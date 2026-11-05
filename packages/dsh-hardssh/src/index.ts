/**
 * dsh-hardssh — host half. Owns the local⇄remote mode store, the
 * /api/dsh-hardssh route family (loopback-only), the remote_* agent
 * tools, a model-facing announcement section, the generic workspace core,
 * and the SSH operations capability (host manager, ssh_* tools,
 * /api/dsh-hardssh/ssh, web terminal). In SSH mode the model's ordinary
 * read/write/edit/bash tools run transparently on the remote host through
 * those switch rows. File operations and SSH operations ride ONE shared
 * SshEngine/HostStore over ~/.dsh/dsh-hardssh-ssh.json (a single connection
 * pool; SSH ops and workspaces invalidate together on config change). The
 * browser half (./client) renders the header buttons, the SSH config dialog,
 * the left workspace panel, and the SSH host-manager surfaces.
 *
 * The announcement section is rendered PER SESSION from the workspace facts
 * (which workspace this session's cwd binds to), never from path-string
 * heuristics. There is no tool guard layer: routing lives in the fs/subprocess
 * seams, and the subprocess facade routes the one combination that no other
 * layer can — a client-side search helper (glob/grep's bundled ripgrep) inside
 * a remote-bound session, which the workspace-search bridge answers from the
 * bound host instead of searching the local anchor placeholder.
 *
 * The generic WorkspaceCore is the only workspace runtime. Its ledger lives at
 * `~/.dsh/workspaces/index.v1.json`; boot recovery restores a missing or corrupt
 * ledger from the `.last-good` snapshot or the newest backup, and otherwise
 * fails closed instead of silently starting with an empty workspace set.
 */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type {} from '@deepseek-ai/dsh-settings'
import type {} from '@deepseek-ai/dsh-tools'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import z from '@deepseek-ai/schemastery'
import type { HardsshCore } from './core.ts'
import { anchorRoot } from './ledger.ts'
import { GenericWorkspaceStore, type WorkspaceStoreView } from './backend.ts'
import { makeRoutes, reconcileHostWorkspaces, type HostWorkspaceReconcileDeps, type HostWorkspaceReconcileReport } from './routes.ts'
import { RemoteSandboxProvisioner } from './sandbox/remote-sandbox.ts'
import { SshEngine } from './ssh/engine.ts'
import { mountSshCapability } from './ssh/plugin.ts'
import { HostStore } from './ssh/store.ts'
import { SecureHostStore } from './ssh/store.ts'
import { checkCommand, commandGuardTargets } from './ssh/command-policy.ts'
import { KnownHostsStore } from './ssh/known-hosts.ts'
import { withSshConfig } from './ssh/ssh-config.ts'
import { Vault } from './ssh/vault.ts'
import { mountWorkspaceCore, genericLedgerPath, type WorkspaceCore } from './runtime/workspace-core.ts'
import { mountHardsshHealth, watchHardsshOptionalServices } from './runtime/health.ts'
import { mountRemoteExecutionNotice, mountRemoteWireTranslation, remoteBindings } from './runtime/remote-context.ts'
import { inspectGenericLedger, recoverGenericLedger } from './runtime/workspace-recovery.ts'

/** Stable cordis plugin name. */
export const name = 'hardssh'

/**
 * Services required before the workspace surfaces can mount. `webServer` is
 * deliberately NOT here: headless profiles lack it, and a hard inject would
 * block the whole load tree — routes register through the dynamic
 * ctx.inject(['webServer'], …) below (DSH 插件规范 §4.2).
 */
export const inject = ['tools']

/** Plugin config (schemastery; optional fields use .default, never .optional). */
export interface Config {
  /**
   * Workspace-surface switch (default on). It gates the SSH-workspace
   * surfaces this row mounts after the check below: the /api/dsh-hardssh
   * workspace CRUD routes and the workspace panel. The connection-configuration
   * routes, the shared engine/host-store/vault, the fs/subprocess routing rows,
   * and the seam replacement itself mount before this switch and keep running
   * (a workspace must be creatable/connectable).
   */
  enabled: boolean
  /**
   * Secret storage mode: 'none' (default, VSCode Remote-SSH style: passwords
   * never persisted, prompted once per session) or 'vault' (encrypted at
   * rest, for unattended agents).
   *
   * This is the SINGLE SOURCE for the mode: the Vault and SecureHostStore are
   * constructed once from it when the plugin loads, so changing it requires a
   * plugin reload.
   */
  secretStorage: 'none' | 'vault'
  /**
   * Whether the credential vault may auto-unlock from the
   * `DSH_CREDENTIAL_PASSWORD` environment variable at plugin load.
   *
   * `'off'` (default): the vault stays locked until a password is entered, so a
   * leaked ciphertext is not enough to recover credentials. `'env'` is the
   * explicit opt-in for unattended/headless agents.
   */
  vaultAutoUnlock: 'off' | 'env'
}

export const Config: z<Config> = z.object({
  enabled: z.boolean().default(true),
  secretStorage: z.union([z.const('none'), z.const('vault')]).default('none'),
  vaultAutoUnlock: z.union([z.const('off'), z.const('env')]).default('off'),
})

/**
 * The ONE effective secretStorage mode: the plugin config value, defaulting to
 * 'none'. The Vault and SecureHostStore are constructed from this value once
 * (plugin load), which is what makes it authoritative.
 */
export function resolveSecretStorageMode(config?: { secretStorage?: unknown }): 'none' | 'vault' {
  return config?.secretStorage === 'vault' ? 'vault' : 'none'
}

/** Isolated-path options for one generic startup (tests inject temp dirs). */
export interface GenericBootOptions {
  /** The generic ledger target (~/.dsh/workspaces/index.v1.json). */
  genericPath: string
}

/**
 * Boot the one generic workspace runtime: classify the ledger, recover it from
 * `.last-good` / the newest backup when it is missing or corrupt, then
 * initialize the core.
 *
 * A fresh install (no ledger, no recovery source) initializes an empty ledger.
 * A corrupt ledger with no recovery source rejects: consumers fail closed
 * instead of silently operating an empty workspace set. Recovery keeps the
 * current ledger format only; no legacy-format import runs.
 *
 * @param core - the generic core to initialize.
 * @param options - the ledger path (tests inject temp dirs).
 */
export async function bootstrapGenericWorkspaceCore(core: WorkspaceCore, options: GenericBootOptions): Promise<void> {
  const state = await inspectGenericLedger(options.genericPath)
  if (state !== 'readable') {
    const recovery = await recoverGenericLedger({ genericPath: options.genericPath })
    if (recovery.recovered) {
      console.warn(
        `[dsh-hardssh] generic workspace ledger was ${state}; restored ${recovery.recordCount ?? 0} workspace(s) `
        + `from ${recovery.source} '${recovery.path}'`,
      )
    } else if (state === 'corrupt') {
      throw new Error(
        `generic workspace ledger '${options.genericPath}' is corrupt (recovery failed: ${recovery.reason ?? 'unknown reason'}); `
        + 'refusing to start with an empty workspace set — restore it from a backup',
      )
    }
  }
  await core.initialize()
}

/**
 * The members of the host workspace registry this plugin uses. Both the 0.2.0
 * `ctx.workspace` service (`@deepseek-ai/dsh-workspace`) and the pre-0.2.0
 * `workspaceRegistry` service satisfy it.
 */
export interface HostWorkspaceRegistry {
  /** Resolve one path to its registered workspace; REJECTS for a missing path. */
  resolveByPath(path: string): Promise<{ id: string } | undefined>
  /** Register one existing directory; returns the existing record for a repeat call. */
  create(path: string, title?: string): Promise<{ id: string }>
  /** Remove the registration only; answers false for an unknown id. */
  delete(id: string): Promise<boolean>
}

/**
 * Resolve the host workspace registry across DSH versions.
 *
 * 0.2.0 renamed this service: `@deepseek-ai/dsh-workspace` registers
 * `super(ctx, 'workspace')` and ships no `workspaceRegistry` alias. A
 * single-name lookup therefore silently no-ops on 0.2.0 — the anchor never
 * becomes a real sidebar workspace, and nothing reports it. Newest name first;
 * the shape check keeps an unrelated same-named service from being mistaken for
 * the registry.
 * @param ctx - host plugin context.
 * @returns the registry, or undefined when this deployment has none.
 */
export function hostWorkspaceRegistry(ctx: Context): HostWorkspaceRegistry | undefined {
  const candidate = (ctx.get('workspace') ?? ctx.get('workspaceRegistry')) as Partial<HostWorkspaceRegistry> | undefined
  if (candidate === undefined) return undefined
  if (typeof candidate.create !== 'function' || typeof candidate.resolveByPath !== 'function') return undefined
  return candidate as HostWorkspaceRegistry
}

/**
 * Resolve one path through a registry whose `resolveByPath` rejects (rather than
 * answering undefined) for a path it does not know. Both readings mean the same
 * thing here: not registered.
 * @param registry - the host workspace registry.
 * @param path - the anchor path to look up.
 * @returns the registered workspace, or undefined when it is not registered.
 */
export async function resolveHostWorkspace(registry: HostWorkspaceRegistry, path: string): Promise<{ id: string } | undefined> {
  try {
    return await registry.resolveByPath(path)
  } catch {
    return undefined
  }
}

/**
 * A-04 startup half: replay host-workspace registration for every stored
 * record once the workspace store is ready, so a process restart (or a create
 * whose registration failed before the compensating rollback existed) cannot
 * leave a binding whose sidebar entry is missing. `registerHostWorkspace` is
 * create-if-missing, so replay is idempotent.
 *
 * Thin delegation to the shared `reconcileHostWorkspaces` (src/routes.ts) that
 * the loopback-guarded `/reconcile` route also calls, so the two halves cannot
 * drift. This wrapper owns the startup-only rules: never reject (a broken host
 * registry or an unreadable ledger must not break plugin load) and log what
 * happened instead of surfacing it to the loader.
 * @param deps - the record source and the host-registry registration hook.
 * @returns the shared reconcile report (empty when the record list failed).
 */
export async function reconcileHostWorkspacesOnStartup(deps: HostWorkspaceReconcileDeps): Promise<HostWorkspaceReconcileReport> {
  try {
    const report = await reconcileHostWorkspaces(deps)
    // The shared helper reports an unreadable record source instead of
    // throwing; the startup path must still surface it in the log.
    if (report.listError !== undefined) {
      console.warn(`[dsh-hardssh] host-workspace startup reconciliation could not list workspaces: ${report.listError}`)
    }
    for (const failure of report.failures) {
      console.warn(`[dsh-hardssh] host-workspace startup reconciliation failed for workspace '${failure.id}': ${failure.error}`)
    }
    return report
  } catch (error) {
    console.warn(`[dsh-hardssh] host-workspace startup reconciliation failed: ${error instanceof Error ? error.message : String(error)}`)
    return { registered: 0, failures: [] }
  }
}

/**
 * Mount the mode store, route seams, workspace UI routes, announcement, guard,
 * and the shared core.
 * @param ctx - host plugin context (webServer/systemPrompt optional).
 * @param config - resolved plugin config (schema defaults applied by the loader).
 */
export function apply(ctx: Context, config?: Config): void {
  const resolved = {
    enabled: config?.enabled ?? true,
    // Secret storage: 'none' (VSCode Remote-SSH style; default) or 'vault'.
    // Single-sourced: the Vault/SecureHostStore below are built from THIS value.
    secretStorage: resolveSecretStorageMode(config),
    // Env-based vault auto-unlock is opt-in (see the Config docs): the variable
    // is visible to anything running as this user, so it is not a default.
    vaultAutoUnlock: config?.vaultAutoUnlock === 'env' ? 'env' as const : 'off' as const,
  }

  // Single provider ownership is established BEFORE store/engine/core
  // construction. The fs/subprocess sibling rows bind dynamically and replay
  // their latest state when this provider becomes visible, so Cordis parallel
  // loading cannot race three `provide('hardsshHealth', …)` calls. Optional
  // services are watched dynamically too (parallel activation + HMR safe).
  const health = mountHardsshHealth(ctx)
  watchHardsshOptionalServices(ctx, health)

  // Host-key TOFU: connections are refused until the operator confirms the
  // server fingerprint (see known-hosts.ts). Default-enabled for new installs;
  // the engine falls back to pre-security behavior when no store is passed.
  const knownHosts = new KnownHostsStore()
  // Credential handling per secretStorage:
  // - 'vault': encrypt at rest (AES-256-GCM + scrypt) via SecureHostStore;
  //   for unattended agents running password hosts.
  // - 'none' (default): passwords are NEVER persisted — they are prompted
  //   once (VSCode Remote-SSH style) and held in the engine's in-memory table
  //   for that CONNECTION's lifetime (the pool's retirement drops them).
  const vault = resolved.secretStorage === 'vault'
    ? new Vault(undefined, { allowEnvUnlock: resolved.vaultAutoUnlock === 'env' })
    : undefined
  const secureHosts = new SecureHostStore(vault, undefined, undefined, resolved.secretStorage)
  // `~/.ssh/config` is a LIVE host source (VS Code Remote-SSH style): the stored
  // entries keep the override layer, and a host that exists only in that file is
  // usable without an import step. The engine reads through this view, so
  // exec/SFTP/terminal/tunnels/cluster all see the same aliases.
  const hosts = withSshConfig(secureHosts)
  const engine = new SshEngine(hosts, undefined, {
    knownHosts,
    resolveSecrets: (entry) => secureHosts.resolveAuth(entry),
    redactOutput: vault === undefined ? undefined : (text) => vault.redact(text),
  })
  ctx.effect(() => () => {
    engine.dispose()
    vault?.dispose()
  }, 'dsh-hardssh: engine')

  // Remote-world execution precondition: the vendored Landlock launcher is
  // provisioned into the bound host's home on first use and verified by probe.
  // Creation and execution both fail closed when it cannot be provided.
  const remoteSandbox = new RemoteSandboxProvisioner(engine)
  ctx.provide('hardsshSandbox', remoteSandbox)

  // Canonical provider-neutral workspace runtime. It is the only in-process
  // ledger/router used by fs, subprocess, routes, tools and host-delete guards.
  const genericCore = mountWorkspaceCore(ctx, { engine, hosts })
  health.set('workspaceCore', { state: 'degraded', reason: 'workspace core is still initializing' })
  const boot = bootstrapGenericWorkspaceCore(genericCore, { genericPath: genericLedgerPath() })
  void boot.then(() => {
    health.set('workspaceCore', { state: 'ready' })
  }).catch((error: unknown) => {
    // A failed startup must not become an unhandled rejection: consumers await
    // this same promise and fail closed; there is no in-process legacy fallback.
    health.set('workspaceCore', {
      state: 'failed',
      reason: `workspace runtime failed to initialize: ${error instanceof Error ? error.message : String(error)}`,
    })
    console.error('[dsh-hardssh] generic workspace runtime failed to initialize — workspace consumers will fail closed (no silent local fallback):', error instanceof Error ? error.message : String(error))
  })
  // Preserve the established SSH anchor layout across the one-time import.
  const workspaces: WorkspaceStoreView = new GenericWorkspaceStore(genericCore, boot, anchorRoot())

  // Last model-visible boundary: a bound session's kernel cwd is the local
  // anchor, while bash runs on the server. Rewrite the outgoing request paths to
  // the remote root so the model sees one consistent working directory, and tell
  // remote sessions the one fact they would otherwise waste attention inferring.
  // Presentation only — fs/subprocess routing still keys off the anchor.
  const sessionCwd = (sessionId: string | undefined): string | undefined => {
    if (sessionId === undefined) return undefined
    const sessions = ctx.get('sessions') as { get?: (id: string) => { header?: { cwd?: string } } | undefined } | undefined
    return sessions?.get?.(sessionId)?.header?.cwd
  }
  mountRemoteWireTranslation(ctx, () => remoteBindings(genericCore), sessionCwd)
  mountRemoteExecutionNotice(ctx, () => remoteBindings(genericCore))

  // SSH-specific integrations retain only the shared host store and engine.
  // dsh-workbench consumes `workspaceCore` directly; no sshWorkspaceCore or
  // synchronous compatibility runner alias remains.
  const core: HardsshCore = { hosts: secureHosts, engine }
  ctx.provide('hardsshCore', core)

  // Connection configuration routes (hosts / credentials / health) —
  // mounted against the SAME engine/store and kept independent of the
  // workspace `enabled` switch below: a workspace must be configurable and
  // connectable even when the workspace panel itself is switched off. The
  // host-delete reference guard reads the same record source as the
  // workspace surfaces.
  mountSshCapability(ctx, { store: secureHosts, engine, knownHosts, vault, ledger: workspaces, health })

  // Per-host command guard (tool layer). Default is NO interception: only hosts
  // that explicitly carry a `commandPolicy` are gated. The only tool-layer
  // remote-command channel is `bash`; the seam layer (SshSubprocessRuntime)
  // applies the same policy to spawns from any consumer, so the tool layer
  // exists to give the operator the readable reason.
  const guardDispose = ctx.tools.guard((execution) => {
    const args = execution.arguments as Readonly<Record<string, unknown>> | undefined
    const targets = commandGuardTargets(execution.name, args, execution.agent?.session?.header?.cwd, {
      aliasForCwd: (cwd) => (cwd === undefined || cwd === '' ? undefined : workspaces.findByAnchorSync(cwd)?.alias),
    })
    if (targets === undefined) return undefined
    for (const { alias, command } of targets) {
      const policy = engine.find(alias)?.commandPolicy
      if (policy === undefined) continue
      const denial = checkCommand(alias, command, policy)
      if (denial !== undefined) return denial
    }
    return undefined
  })
  ctx.effect(() => () => { guardDispose() }, 'dsh-hardssh: command-guard')

  // C-04: secretStorage is a construction-time decision (vault + store above).
  // The plugin config owns the mode; there is no settings namespace that can
  // disagree with it.

  if (!resolved.enabled) return

  // Host workspace registration hooks (make the anchor a real sidebar
  // workspace). The registry is optional — headless profiles lack it.
  const registerHostWorkspace = async (anchorPath: string, title: string): Promise<void> => {
    const registry = hostWorkspaceRegistry(ctx)
    if (registry === undefined) return
    if (await resolveHostWorkspace(registry, anchorPath) !== undefined) return
    // The 0.2.0 registry canonicalizes the path with fs.realpath and refuses a
    // directory that does not exist. The normal create path has already made the
    // managed anchor, but a startup reconcile replays records whose anchor may
    // have been removed since — restore it instead of failing the registration.
    await mkdir(anchorPath, { recursive: true })
    await registry.create(anchorPath, title)
  }
  const unregisterHostWorkspace = async (anchorPath: string): Promise<void> => {
    const registry = hostWorkspaceRegistry(ctx)
    if (registry === undefined) return
    const existing = await resolveHostWorkspace(registry, anchorPath)
    if (existing === undefined) return
    if (await registry.delete(existing.id)) return
    // `delete` answers false for an unknown id: an already-gone registration is
    // success, and only a registry that kept the record is a real refusal.
    if (await resolveHostWorkspace(registry, anchorPath) === undefined) return
    throw new Error(`host workspace registry refused to delete '${existing.id}'`)
  }

  const routes = makeRoutes({
    // Read-only host surface: the union of the stored hosts and the LIVE
    // `~/.ssh/config`, so the GUI lists (and validates aliases for) config-only
    // hosts too. Writes stay in the SSH routes, which own the JSON store.
    hosts,
    engine,
    workspaces,
    sandbox: remoteSandbox,
    registerHostWorkspace,
    unregisterHostWorkspace,
  })
  // webServer is optional (headless profiles lack it): dynamic inject keeps
  // this plugin loadable everywhere, mounting routes only when it appears.
  // The inject callback receives a scoped Context with the service available.
  ctx.inject(['webServer'], (scoped) => {
    const disposers = routes.map(route => scoped.webServer.register(route))
    return () => {
      for (const dispose of disposers) dispose()
    }
  })

  // A-04 startup half: a restart does not replay sidebar registration, and a
  // create whose registration failed before compensation existed leaves a
  // binding with no host workspace. Reconcile once, after the record source is
  // wired (the generic store gates on its boot). The helper never rejects; the
  // catch is belt-and-braces so a future change cannot break plugin load.
  //
  // The registry comes from a LATER-activated row (`dsh-web-app` mounts the
  // 0.2.0 `workspace` service), so a direct lookup here is too early on 0.2.0:
  // it answers undefined and the reconciliation silently registers nothing
  // (verified on 0.2.0-rc.2 — the anchors only appeared after an explicit
  // /reconcile). Cordis resolves that declaratively: inject the name this
  // deployment uses and run when it appears, so startup and the retry route end
  // up equivalent. Registration is create-if-missing, so the once-guard is only
  // about not doing the same work twice.
  let startupReconciled = false
  const reconcileStartupOnce = (): void => {
    if (startupReconciled) return
    startupReconciled = true
    void reconcileHostWorkspacesOnStartup({ workspaces, registerHostWorkspace }).catch((error: unknown) => {
      console.warn('[dsh-hardssh] host-workspace startup reconciliation failed:', error instanceof Error ? error.message : String(error))
    })
  }
  // Both names are injected on purpose: neither deployment provides both, so
  // exactly one callback fires (the other stays a pending injection, the same
  // stance as the optional webServer above — headless profiles lack it too).
  ctx.inject(['workspace'], () => { reconcileStartupOnce() })
  ctx.inject(['workspaceRegistry'], () => { reconcileStartupOnce() })

  // The workspace tools (remote_status / remote_ls / remote_search) were
  // removed with the SSH-operations capability: bound sessions use the routed
  // native tools (read/write/edit/bash/glob/grep) directly.

  // Tool routing for SSH-bound sessions is handled by the fs/subprocess
  // seams, not by tool guards: glob/grep operate through the routed fs
  // (server data remote, declared client roots local — skills readable),
  // and client-native binaries (pwsh.exe etc.) spawn locally via the
  // subprocess switch. See switch-fs.ts / switch-subprocess.ts.
}
