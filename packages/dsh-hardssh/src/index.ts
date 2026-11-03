/**
 * dsh-hardssh — host half. Owns the local⇄remote mode store, the
 * /api/dsh-hardssh route family (loopback-only), the remote_* agent
 * tools, a model-facing announcement section, the generic workspace core,
 * and the SSH operations capability (host manager, ssh_* tools, /api/dsh-ssh,
 * web terminal). In SSH mode the model's ordinary read/write/edit/bash tools
 * run transparently on the remote host through those switch rows. File
 * operations and SSH operations ride ONE shared SshEngine/HostStore over
 * ~/.dsh/dsh-ssh.json (a single connection pool; SSH ops and workspaces
 * invalidate together on config change). The browser half (./client) renders
 * the header buttons, the SSH config dialog, the left workspace panel, and
 * the SSH host-manager surfaces.
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
import type {} from '@deepseek-ai/dsh-system-prompt'
import type {} from '@deepseek-ai/dsh-tools'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import z from '@deepseek-ai/schemastery'
import type { HardsshCore } from './core.ts'
import { anchorRoot } from './ledger.ts'
import { GenericWorkspaceStore, type WorkspaceStoreView } from './backend.ts'
import { makeRoutes, reconcileHostWorkspaces, type HostWorkspaceReconcileDeps, type HostWorkspaceReconcileReport } from './routes.ts'
import { RemoteSandboxProvisioner } from './sandbox/remote-sandbox.ts'
import { makeWorkspaceTools } from './tools.ts'
import { capabilityToolOpsResolver } from './workspace-tool-ops.ts'
import { SshEngine } from './ssh/engine.ts'
import { mountSshCapability, SSH_SETTINGS_NAMESPACE } from './ssh/plugin.ts'
import { HostStore } from './ssh/store.ts'
import { SecureHostStore } from './ssh/store.ts'
import { checkCommand, commandGuardTargets } from './ssh/command-policy.ts'
import { KnownHostsStore } from './ssh/known-hosts.ts'
import { withSshConfig } from './ssh/ssh-config.ts'
import { Vault } from './ssh/vault.ts'
import { mountWorkspaceCore, genericLedgerPath, type WorkspaceCore } from './runtime/workspace-core.ts'
import { mountHardsshHealth, watchHardsshOptionalServices } from './runtime/health.ts'
import { inspectGenericLedger, recoverGenericLedger } from './runtime/workspace-recovery.ts'
import type { SshWorkspaceRecord } from './protocol.ts'

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
   * Workspace-surface switch (default on). It gates ONLY the SSH-workspace
   * surfaces this row mounts after the check below: the /api/dsh-hardssh
   * workspace CRUD routes, the remote_* workspace agent tools, and the
   * workspace announcement section. It does NOT gate the SSH operations
   * capability (host manager, ssh_* tools, /api/dsh-ssh, web terminal — its
   * own `dsh-ssh` settings namespace `enabled`), the shared
   * engine/host-store/vault, the fs/subprocess routing rows, or the seam
   * replacement itself: those mount before this switch and keep running.
   */
  enabled: boolean
  /** Whether the model-facing announcement section is mounted. */
  announceToAgent: boolean
  /**
   * Secret storage mode: 'none' (default, VSCode Remote-SSH style: passwords
   * never persisted, prompted once per session) or 'vault' (encrypted at
   * rest, for unattended agents).
   *
   * This is the SINGLE SOURCE for the mode: the Vault and SecureHostStore are
   * constructed once from it when the plugin loads, so changing it requires a
   * plugin reload. The `dsh-ssh` settings namespace also exposes
   * `secretStorage` for the settings UI, but that value cannot switch storage
   * mode at runtime (see reportSecretStorageDrift below).
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
  announceToAgent: z.boolean().default(true),
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

/** Read the `secretStorage` field out of a resolved settings section. */
function secretStorageOf(section: unknown): 'none' | 'vault' | undefined {
  if (typeof section !== 'object' || section === null) return undefined
  const value = (section as { secretStorage?: unknown }).secretStorage
  return value === 'vault' ? 'vault' : value === 'none' ? 'none' : undefined
}

/**
 * Report a secretStorage disagreement between the RUNNING mode (fixed when the
 * Vault/SecureHostStore were constructed at plugin load) and the value the
 * `dsh-ssh` settings namespace currently resolves to. The mode cannot change
 * at runtime, so staying silent would let the settings UI claim a storage mode
 * this process is not using.
 * @param running - the construction-time mode actually in effect.
 * @param section - the resolved `dsh-ssh` settings section (any shape).
 * @returns the warning text, or undefined when both agree / the value is unusable.
 */
export function secretStorageDriftMessage(running: 'none' | 'vault', section: unknown): string | undefined {
  const requested = secretStorageOf(section)
  if (requested === undefined || requested === running) return undefined
  return `[dsh-hardssh] secretStorage: the dsh-ssh settings namespace resolves to '${requested}' but this process is running '${running}'. The mode is fixed by the plugin config (secretStorage) when the plugin loads — the vault and host store are constructed once — so the namespace value is ignored; set secretStorage: '${requested}' in the plugin config and reload the plugin (restart dsh web) to switch.`
}

/**
 * Report secretStorage drift once at mount and on every committed settings
 * change (deduplicated, so a repeated change does not spam the log). The
 * settings service is a sibling context and cordis events travel UP from the
 * emitting ctx, so the listener sits on the root context; `ctx.effect` keeps
 * the subscription tied to this plugin's lifetime.
 * @param ctx - the plugin context (provides `settings` when present).
 * @param running - the construction-time mode actually in effect.
 */
export function watchSecretStorageDrift(ctx: Context, running: 'none' | 'vault'): void {
  let last: string | undefined
  const report = (section: unknown): void => {
    const message = secretStorageDriftMessage(running, section)
    if (message === undefined || message === last) return
    last = message
    console.warn(message)
  }
  const settings = ctx.get('settings') as { get?: (ns: string) => unknown } | undefined
  report(settings?.get?.(SSH_SETTINGS_NAMESPACE))
  ctx.effect(() => ctx.root.on('settings/updated', (ns, next) => {
    if (ns === SSH_SETTINGS_NAMESPACE) report(next)
  }), 'dsh-hardssh: secretStorage drift watch')
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

/** Order of the announcement section (right after the dsh-ssh section at 150). */
const SECTION_ORDER = 160

/** Minimal shape of the assembly context the guidance section reads. The DSH
 *  type (`AssembleContext`) only declares scope/signal, but the agent loop
 *  passes `{ agent, scope, signal }` (see dsh-agent assembleContextFor). */
interface GuidanceAssemblyContext {
  agent?: { session?: { header?: { cwd?: string } } }
}

/** Render the workspace guidance from the RECORD SOURCE for this session:
 *  a cwd the store binds renders the remote branch (with the real alias /
 *  remote root), everything else the local branch. No path-string matching. */
function renderWorkspaceGuidance(workspaces: WorkspaceStoreView, context: unknown): string {
  const agent = (context as GuidanceAssemblyContext).agent
  const cwd = agent?.session?.header?.cwd
  const record = cwd === undefined || cwd === '' ? undefined : workspaces.findByAnchorSync(cwd)
  if (record === undefined) return localGuidance()
  return remoteGuidance(record)
}

/** Local-session branch of the announcement. Exported for the guidance test. */
export function localGuidance(): string {
  return '本机已安装 dsh-hardssh 插件（SSH 工作区）。当前会话是本机工作区：正常使用全部工具（pwsh / glob / grep / read / write / edit），文件操作在本机。remote_ls / remote_search / remote_status 与 ssh_exec / ssh_upload / ssh_download / ssh_tunnel / ssh_cluster 用于一次性远程运维（消耗真实远程资源，先确认再执行）。用户提到「SSH 工作区 / 远程工作区 / 远程文件 / 远程项目 / 远程服务器上改代码」时即指本插件。'
}

/**
 * SSH-bound-session branch of the announcement.
 *
 * The tool facts here must match the seams. read/write/edit route through
 * `SwitchFileSystem` (server data remote, client-declared local roots local).
 * glob/grep do NOT: they run the CLIENT's bundled ripgrep through
 * `ctx.subprocess`, which cannot see the remote workspace, so the subprocess
 * facade refuses that combination and points here to the remote tools. `pwsh`
 * is a client-native binary and runs on this machine.
 *
 * Exported for the guidance test.
 */
export function remoteGuidance(record: SshWorkspaceRecord): string {
  return `本机已安装 dsh-hardssh 插件（SSH 工作区）。当前会话绑定到远程工作区「${record.title}」（${record.alias} @ ${record.remoteRoot}）：
- read / write / edit 自动路由到远程（SFTP）；路径用远程绝对路径（如 ${record.remoteRoot}/src/main.ts），相对路径以远程根目录为基准。
- glob / grep 在 SSH 工作区里**直接查远端**：宿主机有 ripgrep 时在服务器上执行同一条 rg 命令；没有时代答（POSIX find/grep 模板或 SFTP 遍历），返回格式与原生一致（glob 只列文件，grep 返回「路径:行号:内容」）。搜索路径按工作区根用 POSIX 形式给出，超出工作区根的路径会被拒绝。需要正则内容检索、更多条数/字节控制时用 remote_search（可选 syntax="regex"，宿主机既无 rg 也无 GNU grep 时会明确报错），列目录用 remote_ls，连接与回退状态用 remote_status。
- pwsh / powershell / cmd 是客户端原生二进制，在本机执行；远端为 POSIX 主机时请用 bash 语义命令或 ssh_exec。
- 远程操作消耗真实远程资源，先确认再执行。`
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
 * Mount the mode store, routes, tools, announcement, guard, and the shared core.
 * @param ctx - host plugin context carrying tools/systemPrompt (webServer optional).
 * @param config - resolved plugin config (schema defaults applied by the loader).
 */
export function apply(ctx: Context, config?: Config): void {
  const resolved = {
    enabled: config?.enabled ?? true,
    announceToAgent: config?.announceToAgent ?? true,
    // Secret storage: 'none' (VSCode Remote-SSH style; default) or 'vault'.
    // Single-sourced: the Vault/SecureHostStore below are built from THIS
    // value, and any disagreement with the dsh-ssh settings namespace is
    // reported through secretStorageDriftMessage (never silently accepted).
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

  // SSH-specific integrations retain only the shared host store and engine.
  // dsh-workbench consumes `workspaceCore` directly; no sshWorkspaceCore or
  // synchronous compatibility runner alias remains.
  const core: HardsshCore = { hosts: secureHosts, engine }
  ctx.provide('hardsshCore', core)

  // SSH operations capability (host manager, ssh_* tools, /api/dsh-ssh,
  // terminal, settings, prompt) — mounted against the SAME engine/store and
  // kept independent of the workspace `enabled` switch below (its own
  // `dsh-ssh` settings namespace toggles it). The host-delete reference guard
  // reads the same record source as the workspace surfaces.
  mountSshCapability(ctx, { store: secureHosts, engine, knownHosts, vault, ledger: workspaces, health })

  // Per-host command guard (tool layer). Default is NO interception: only hosts
  // that explicitly carry a `commandPolicy` are gated. Covers ssh_exec /
  // ssh_cluster / bash — every remote-command channel the model can drive.
  // The seam layer (SshSubprocessRuntime) applies the same policy to spawns
  // from any consumer; the tool layer gives the operator the readable reason.
  const guardDispose = ctx.tools.guard((execution) => {
    const args = execution.arguments as Readonly<Record<string, unknown>> | undefined
    const targets = commandGuardTargets(execution.name, args, execution.agent?.session?.header?.cwd, {
      allAliases: () => engine.list().map(host => host.alias),
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
  // The dsh-ssh settings namespace exposes the same key for the settings UI,
  // but its resolve() only reads enabled/announceToAgent, so editing it cannot
  // switch storage mode. Report the disagreement instead of pretending it
  // applied: once at mount, then on every committed settings change. The
  // namespace is registered by mountSshCapability above, so the first read
  // already sees the resolved value.
  watchSecretStorageDrift(ctx, resolved.secretStorage)

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

  // Bound-workspace ops always open the generic logical connection and use its
  // workspace.fs/workspace.search capabilities.
  const toolOps = capabilityToolOpsResolver(workspaces, genericCore)
  const tools = makeWorkspaceTools({ workspaces, ops: toolOps })
  ctx.effect(() => {
    const disposers = tools.map(tool => ctx.tools.register(tool))
    return () => {
      for (const dispose of disposers) dispose()
    }
  }, 'dsh-hardssh: tools')

  // Tool routing for SSH-bound sessions is handled by the fs/subprocess
  // seams, not by tool guards: glob/grep operate through the routed fs
  // (server data remote, declared client roots local — skills readable),
  // and client-native binaries (pwsh.exe etc.) spawn locally via the
  // subprocess switch. See switch-fs.ts / switch-subprocess.ts.

  if (resolved.announceToAgent) {
    // Optional integration (see the inject note above): no system-prompt
    // service means no announcement, never a failed plugin load.
    const systemPrompt = ctx.get('systemPrompt') as { section?: (options: { name: string; order: number; text: (context: unknown) => string }) => unknown } | undefined
    if (typeof systemPrompt?.section === 'function') {
      systemPrompt.section({
        name: 'plugin:dsh-hardssh',
        order: SECTION_ORDER,
        text: (context) => renderWorkspaceGuidance(workspaces, context as never),
      })
    }
  }
}
