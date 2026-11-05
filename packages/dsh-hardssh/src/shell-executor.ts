/**
 * The `ctx.shell` switch row: one bash executor for both worlds.
 *
 * Local sessions confine through the same injected `ctx.sandbox` provider the
 * native sandbox executor used: this executor extends the local executor and
 * wraps the exact bash argv with the session's policy. SSH-bound sessions run
 * through a verified remote Landlock or bubblewrap backend: the local sandbox
 * never wraps a command that will execute on another machine.
 *
 * The remote backend is selected by `RemoteSandboxProvisioner`; a host
 * without a verified runner fails closed. User commands are never replayed.
 * `danger-full-access` is the one mode that runs without the launcher,
 * mirroring the native executor.
 *
 * @module dsh-hardssh/shell-executor
 */

import z from '@deepseek-ai/schemastery'
import type { Context } from '@deepseek-ai/cordis'
import { LocalBashExecutor, type Config as LocalBashConfig } from '@deepseek-ai/dsh-bash-local'
import { SandboxUnavailableError, classifyRunnerFailure, isRunnerSpawnFailure, matchesSignature } from '@deepseek-ai/dsh-sandbox'
import type { ConfinedArgv, ConfinedSandboxMode, SandboxMode } from '@deepseek-ai/dsh-sandbox'
import type {} from '@deepseek-ai/dsh-sandbox-policy'
import type { ShellExecRequest, ShellExecSpec, ShellExecution, ShellRunResult, ShellSandboxInfo } from '@deepseek-ai/dsh-shell'
import { anchorRoots, isPathUnderAnchor } from './ledger.ts'
import { shellQuote } from './shell.ts'
import type { WorkspaceCore } from './runtime/workspace-core.ts'
import type { RemoteSandboxProvisioner } from './sandbox/remote-sandbox.ts'
import { grantArgs } from './sandbox/landlock.ts'
import { bubblewrapArgs } from './sandbox/bubblewrap.ts'

/** The remote world owning one synthetic (anchor) cwd. When the caller asked
 *  for an explicit REMOTE workdir, `remoteWorkdir` carries it and the command
 *  runs there while the spawn itself keeps the anchor cwd (the subprocess
 *  facade routes by anchor path; the remote runtime translates the cwd). */
interface RemoteShellWorld {
  alias: string
  remoteRoot: string
  anchorPath: string
  remoteWorkdir?: string
}

/** Validated plugin configuration; mirrors the native local executor so the
 *  two worlds share the same budgets (the base profile's `bash-sandbox` row
 *  is disabled and this row takes its place). */
export type Config = LocalBashConfig

export const Config: z<Config> = z.object({
  cwd: z.string().volatile(),
  timeoutMs: z.number().default(120_000).volatile(),
  maxTimeoutMs: z.number().default(600_000).volatile(),
  maxOutputBytes: z.number().default(64_000).volatile(),
  maxSpillBytes: z.number().default(64 * 1024 * 1024).volatile(),
  graceMs: z.number().default(3_000).volatile(),
})

export const name = 'hardssh-shell'

/** The local world confines through this executor's own injected
 *  `ctx.sandbox` provider, so `inject` lists every service both worlds use. */
export const inject = ['subprocess', 'sandbox', 'sandboxPolicy']

/** One workspace world resolved by ANCHOR path; throws for an unowned anchor. */
function worldFromAnchor(core: WorkspaceCore, cwd: string): RemoteShellWorld | undefined {
  const connection = core.router.fromAnchor(cwd)
  if (connection === undefined) return undefined
  const record = core.ledger.snapshotSync().records.find(candidate => candidate.id === connection.workspaceId)
  if (record === undefined) {
    throw new Error(`shell-workspace: routed workspace '${connection.workspaceId}' is missing from the ledger`)
  }
  if (record.anchor === undefined) throw new Error(`shell-workspace: workspace '${record.id}' has no anchor`)
  const alias = record.provider.connectionRef?.alias ?? record.provider.connectionRef?.id
  if (alias === undefined || alias === '') {
    throw new Error(`shell-workspace: workspace '${record.id}' has no connection alias`)
  }
  return { alias, remoteRoot: record.location.root, anchorPath: record.anchor.path }
}

/**
 * Resolve the SSH world owning one resolved command, or undefined for a local
 * command.
 *
 * The session's world comes from the resolved sandbox policy's workspaceRoot
 * (the session cwd = anchor). An explicit POSIX-absolute `workdir` that is NOT
 * under the anchor is a REMOTE path the caller wants to enter: the spawn stays
 * on the anchor so the subprocess facade routes it, and the command itself
 * `cd`s to the remote path inside the remote shell. Local sessions have a
 * policyRoot outside the managed anchor root, so a local `/tmp/x` workdir is
 * never hijacked into the remote world.
 */
function remoteWorldFor(ctx: Context, spec: ShellExecSpec): RemoteShellWorld | undefined {
  const core = ctx.get('workspaceCore') as WorkspaceCore | undefined
  const anchorDirs = anchorRoots()
  const underAnchor = (path: string): boolean => anchorDirs.some(root => isPathUnderAnchor(root, path))
  const workdir = spec.workdir
  const policyRoot = spec.sandboxPolicy?.workspaceRoot
  if (core === undefined || !core.isReady()) {
    if (underAnchor(workdir) || (policyRoot !== undefined && underAnchor(policyRoot))) {
      throw new Error('shell-ssh: workspace routing is unavailable while the workspace core is not ready (anchor path fails closed)')
    }
    return undefined
  }
  if (policyRoot !== undefined && underAnchor(policyRoot)) {
    const world = worldFromAnchor(core, policyRoot)
    if (world === undefined) {
      throw new Error(`shell-workspace: '${policyRoot}' is inside the workspace anchor root but no registered workspace owns it (fail closed)`)
    }
    if (underAnchor(workdir)) return world
    if (workdir.startsWith('/')) return { ...world, remoteWorkdir: workdir }
    throw new Error(`shell-workspace: workdir '${workdir}' is not an absolute POSIX path for an SSH-bound session`)
  }
  if (underAnchor(workdir)) {
    const world = worldFromAnchor(core, workdir)
    if (world !== undefined) return world
    throw new Error(`shell-workspace: '${workdir}' is inside the workspace anchor root but no registered workspace owns it (fail closed)`)
  }
  return undefined
}

/** The bash executor that routes each command to the world of its resolved cwd. */
class RemoteBashExecutor extends LocalBashExecutor {
  static inject = inject

  constructor(ctx: Context, config: Config) {
    super(ctx, config)
  }

  /** The configured default mode (what the bash tool reads before a call). */
  override get sandboxMode(): SandboxMode | undefined {
    return this.ctx.sandboxPolicy.defaultMode
  }

  /** Attach the default policy when a lower-level caller omitted it; tool
   *  calls always resolve it themselves. */
  override resolve(request: ShellExecRequest): ShellExecSpec {
    const spec = super.resolve(request)
    if (spec.sandboxPolicy === undefined) spec.sandboxPolicy = this.ctx.sandboxPolicy.resolve()
    return spec
  }

  override async execute(spec: ShellExecSpec): Promise<ShellExecution> {
    const world = remoteWorldFor(this.ctx, spec)
    const mode = spec.sandboxPolicy?.mode ?? this.ctx.sandboxPolicy.defaultMode
    if (world === undefined) {
      if (mode === 'danger-full-access') {
        return this.decorate(await this.executeArgv(spec, ['bash', '-c', spec.command]), { mode, denied: false })
      }
      return this.executeLocalConfined(spec, mode)
    }
    // The spawn cwd stays the anchor so the subprocess facade routes it; an
    // explicit remote workdir is entered by the command itself.
    const spawnSpec = world.remoteWorkdir === undefined ? spec : { ...spec, workdir: world.anchorPath }
    const command = world.remoteWorkdir === undefined
      ? spec.command
      : `cd -- ${shellQuote(world.remoteWorkdir)} && ${spec.command}`
    if (mode === 'danger-full-access') {
      return this.decorate(await this.executeArgv(spawnSpec, ['bash', '-c', command]), { mode, denied: false })
    }
    const sandbox = this.ctx.get('hardsshSandbox') as RemoteSandboxProvisioner | undefined
    if (sandbox === undefined) {
      throw new Error('hardssh-shell: the remote sandbox provisioner is unavailable; cannot run remote commands')
    }
    // Fail closed: provisioning throws with the actionable reason (unsupported
    // host, Landlock missing, upload failure) instead of running unconfined.
    const state = await sandbox.ensure(world.alias)
    const profile = state.backend === 'bubblewrap'
      ? bubblewrapArgs(mode, world.remoteRoot)
      : grantArgs(mode, world.remoteRoot)
    const argv = [state.runnerPath, ...profile, '--', 'bash', '-c', command]
    const execution = await this.executeArgv(spawnSpec, argv)
    return this.decorate(execution, { mode, denied: false, enforcement: state.enforcement }, () => sandbox.invalidate(world.alias))
  }

  /** Local world: wrap the exact bash argv through this executor's own
   *  injected `ctx.sandbox` provider (the same provider the native sandbox
   *  executor used) and let the inherited local mechanics spawn it. */
  private async executeLocalConfined(spec: ShellExecSpec, mode: ConfinedSandboxMode): Promise<ShellExecution> {
    const policy = { ...(spec.sandboxPolicy ?? this.ctx.sandboxPolicy.resolve()), mode }
    let confined: ConfinedArgv | undefined
    let execution: ShellExecution
    try {
      execution = await this.executeArgv(spec, async (signal) => {
        const prepared = await this.ctx.sandbox.confine(['bash', '-c', spec.command], policy, signal)
        signal.throwIfAborted()
        confined = prepared
        return prepared.argv
      })
    } catch (error) {
      if (spec.signal?.aborted === true) spec.signal.throwIfAborted()
      if (confined !== undefined && isRunnerSpawnFailure(error, confined.argv[0], spec.workdir)) {
        throw new SandboxUnavailableError(mode, String(error))
      }
      throw error
    }
    const facts = confined
    const base = execution.result.bind(execution)
    let decorated: Promise<ShellRunResult> | undefined
    execution.result = () => {
      decorated ??= base().then((result) => {
        if (facts === undefined) return { ...result, sandbox: { mode, denied: false } }
        const runnerFailure = classifyRunnerFailure(result.exitCode, result.stderr.text, facts.runnerFailureRules)
        if (runnerFailure !== undefined) throw new SandboxUnavailableError(mode, runnerFailure.detail)
        return {
          ...result,
          sandbox: {
            mode,
            denied: matchesSignature(result.exitCode, result.stderr.text, facts.denialSignatures),
            enforcement: facts.enforcement,
          },
        }
      })
      return decorated
    }
    return execution
  }

  /** Stamp sandbox facts on the foreground projection, like the native
   *  executor does; a launcher-level failure (exit 125 with its own fatal
   *  line) is an infrastructure error, not a command result. */
  private decorate(
    execution: ShellExecution,
    sandbox: ShellSandboxInfo,
    onLauncherFailure?: () => void,
  ): ShellExecution {
    const base = execution.result.bind(execution)
    let decorated: Promise<ShellRunResult> | undefined
    execution.result = () => {
      decorated ??= base().then((result) => {
        if ((result.exitCode === 125 && result.stderr.text.includes('landlock-run:')) ||
            (result.exitCode !== 0 && result.stderr.text.includes('bwrap:'))) {
          // The deployed launcher failed (removed on the host, kernel change,
          // …): forget the cached verdict so the next call re-provisions.
          onLauncherFailure?.()
          throw new Error(`remote sandbox runner failed on the host: ${result.stderr.text.trim()}`)
        }
        return { ...result, sandbox }
      })
      return decorated
    }
    return execution
  }
}

/** The row's entry point: one routed executor registers as `ctx.shell` in the
 *  host scope and serves both worlds. */
export function apply(ctx: Context, config: Config): void {
  // The shell seam changed between the 0.1.x line (`run`/`start`) and 0.2.x
  // (`execute`). The routed executor is written against 0.2.x; loading it on a
  // pre-0.2 host would leave the tool calling the inherited unconfined `run`,
  // silently dropping the remote permission semantics. Fail the row loudly
  // instead of degrading.
  const base = LocalBashExecutor.prototype as unknown as { execute?: unknown; executeArgv?: unknown }
  if (typeof base.execute !== 'function' || typeof base.executeArgv !== 'function') {
    throw new Error(
      'hardssh-shell: this DSH host exposes the pre-0.2 shell API (run/start); ' +
      'remote bash sandboxing requires DSH 0.2.x — refusing to load a silently unconfined shell',
    )
  }
  new RemoteBashExecutor(ctx, config)
}
