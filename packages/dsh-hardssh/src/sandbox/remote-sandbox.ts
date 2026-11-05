/**
 * Remote sandbox provisioning: put the vendored Landlock launcher on a bound
 * host and prove it enforces before any remote command is allowed to run.
 *
 * This is the plugin's declared precondition, in the spirit of VS Code Remote
 * installing its server into `~/.vscode-server`: everything the plugin can
 * provision on its own is provisioned (user-writable home, no root, no sudo,
 * no package manager). Only conditions the plugin cannot fix — a non-Linux
 * host, an unsupported architecture, a kernel without Landlock — fail closed
 * with an actionable error instead of degrading to unconfined execution.
 *
 * @module dsh-hardssh/sandbox/remote-sandbox
 */

import { posix } from 'node:path'
import type { SshEngine } from '../ssh/engine.ts'
import { shellQuote as quoteShellArg } from '../shell.ts'
import {
  archForUnameMachine,
  grantArgs,
  parseProbe,
  probeArgv,
  runnerAssetFor,
  LAUNCHER_BIN,
  type LandlockEnforcement,
  type LandlockRunnerAsset,
  type RunnerArch,
} from './landlock.ts'

/** Machine-readable refusal codes (the UI shows the message, tests assert the code). */
export type RemoteSandboxErrorCode =
  | 'REMOTE_SANDBOX_UNSUPPORTED_OS'
  | 'REMOTE_SANDBOX_UNSUPPORTED_ARCH'
  | 'REMOTE_SANDBOX_PROVISION_FAILED'
  | 'REMOTE_SANDBOX_PROBE_FAILED'
  | 'REMOTE_SANDBOX_NOT_PROVISIONED'

/** A refused remote-world execution. `status` maps it onto the HTTP surface. */
export class RemoteSandboxError extends Error {
  constructor(
    message: string,
    public readonly code: RemoteSandboxErrorCode,
    public readonly status: 400 | 502 = 400,
  ) {
    super(message)
    this.name = 'RemoteSandboxError'
  }
}

/** One provisioned host's facts. */
export interface RemoteSandboxState {
  alias: string
  arch: RunnerArch
  /** Absolute launcher path on the remote host. */
  runnerPath: string
  /** Content hash of the exact binary deployed there. */
  sha256: string
  enforcement: LandlockEnforcement
}

/** What the provisioner needs from the engine (narrow for tests). */
export interface RemoteSandboxEngine {
  exec: SshEngine['exec']
  upload: SshEngine['upload']
}

export interface RemoteSandboxProvisionerOptions {
  /** Bounded remote round trips; provisioning is a user-visible step. */
  timeoutMs?: number
}

const DEFAULT_TIMEOUT_MS = 30_000
const REMOTE_STATE_DIR = '.dsh-hardssh'

/** Run one bounded remote command and return the result; transport failures
 *  surface as provisioning errors instead of raw stream errors. */
async function execOk(
  engine: RemoteSandboxEngine,
  alias: string,
  command: string,
  timeoutMs: number,
  what: string,
): Promise<{ stdout: string; stderr: string }> {
  const result = await engine.exec(alias, command, { timeoutMs })
  if (!result.success || result.exitCode !== 0) {
    const detail = result.error ?? (result.stderr.trim() || result.stdout.trim() || `exit code ${String(result.exitCode)}`)
    throw new RemoteSandboxError(`remote sandbox: ${what} failed on '${alias}': ${detail}`, 'REMOTE_SANDBOX_PROVISION_FAILED', 502)
  }
  return { stdout: result.stdout, stderr: result.stderr }
}

/**
 * Per-host provisioner. `ensure()` is idempotent and single-flight per alias:
 * the first workspace creation uploads + probes, later ones reuse the cached
 * verdict; a failure is never cached so the next attempt retries.
 */
export class RemoteSandboxProvisioner {
  private readonly states = new Map<string, RemoteSandboxState>()
  private readonly inflight = new Map<string, Promise<RemoteSandboxState>>()
  private readonly timeoutMs: number

  constructor(
    private readonly engine: RemoteSandboxEngine,
    options: RemoteSandboxProvisionerOptions = {},
  ) {
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  }

  /** The cached verdict for a bound host, if provisioning already succeeded. */
  stateFor(alias: string): RemoteSandboxState | undefined {
    return this.states.get(alias)
  }

  /** Forget one host (connection generation changed / tests). */
  invalidate(alias?: string): void {
    if (alias === undefined) this.states.clear()
    else this.states.delete(alias)
  }

  /** Provision + verify one host, or throw `RemoteSandboxError`. */
  ensure(alias: string): Promise<RemoteSandboxState> {
    const state = this.states.get(alias)
    if (state !== undefined) return Promise.resolve(state)
    const running = this.inflight.get(alias)
    if (running !== undefined) return running
    const promise = this.provision(alias).then(
      (provisioned) => {
        this.states.set(alias, provisioned)
        return provisioned
      },
      (error: unknown) => {
        throw error
      },
    ).finally(() => {
      this.inflight.delete(alias)
    })
    this.inflight.set(alias, promise)
    return promise
  }

  private async provision(alias: string): Promise<RemoteSandboxState> {
    const { os, machine } = await this.detectPlatform(alias)
    if (os !== 'Linux') {
      throw new RemoteSandboxError(
        `remote sandbox: '${alias}' runs ${os}; only Linux hosts are supported (macOS/Windows remote hosts are out of scope)`,
        'REMOTE_SANDBOX_UNSUPPORTED_OS',
      )
    }
    const arch = archForUnameMachine(machine)
    if (arch === undefined) {
      throw new RemoteSandboxError(
        `remote sandbox: '${alias}' reports machine '${machine}'; only x86_64 and aarch64 Linux hosts are supported`,
        'REMOTE_SANDBOX_UNSUPPORTED_ARCH',
      )
    }
    const home = await this.remoteHome(alias)
    const asset = await runnerAssetFor(arch)
    const dir = posix.join(home, REMOTE_STATE_DIR, 'sandbox', `runner-${asset.sha256.slice(0, 12)}`)
    const runnerPath = posix.join(dir, LAUNCHER_BIN)
    await this.deployIfStale(alias, asset, dir, runnerPath)
    const enforcement = await this.probe(alias, runnerPath)
    return { alias, arch, runnerPath, sha256: asset.sha256, enforcement }
  }

  private async detectPlatform(alias: string): Promise<{ os: string; machine: string }> {
    const { stdout } = await execOk(this.engine, alias, "printf '%s\\n' \"$(uname -s)\" \"$(uname -m)\"", this.timeoutMs, 'platform detection')
    const [os = '', machine = ''] = stdout.trim().split('\n')
    if (os === '' || machine === '') {
      throw new RemoteSandboxError(`remote sandbox: '${alias}' returned no platform information from uname`, 'REMOTE_SANDBOX_PROVISION_FAILED', 502)
    }
    return { os: os.trim(), machine: machine.trim() }
  }

  private async remoteHome(alias: string): Promise<string> {
    const { stdout } = await execOk(this.engine, alias, "printf '%s\\n' \"$HOME\"", this.timeoutMs, 'home resolution')
    const home = stdout.trim()
    if (!home.startsWith('/')) {
      throw new RemoteSandboxError(`remote sandbox: '${alias}' has no absolute $HOME (got '${home}')`, 'REMOTE_SANDBOX_PROVISION_FAILED', 502)
    }
    return home
  }

  /** Upload the launcher when the remote copy is missing or differs. */
  private async deployIfStale(alias: string, asset: LandlockRunnerAsset, dir: string, runnerPath: string): Promise<void> {
    const quotedPath = quoteShellArg(runnerPath)
    // sha256sum is part of coreutils on every supported distro; a host without
    // it cannot be verified, so the deployment is refreshed instead of trusted.
    const hashResult = await this.engine.exec(alias, `sha256sum -- ${quotedPath} 2>/dev/null | cut -d' ' -f1`, { timeoutMs: this.timeoutMs })
    const remoteHash = hashResult.success && hashResult.exitCode === 0 ? hashResult.stdout.trim() : ''
    if (remoteHash === asset.sha256) return
    await execOk(this.engine, alias, `mkdir -p -- ${quoteShellArg(dir)}`, this.timeoutMs, 'runner directory creation')
    try {
      await this.engine.upload(alias, asset.path, runnerPath, false)
    } catch (error: unknown) {
      const detail = error instanceof Error ? error.message : String(error)
      throw new RemoteSandboxError(`remote sandbox: uploading the Landlock launcher to '${alias}' failed: ${detail}`, 'REMOTE_SANDBOX_PROVISION_FAILED', 502)
    }
    await execOk(this.engine, alias, `chmod 755 -- ${quotedPath}`, this.timeoutMs, 'runner permission update')
  }

  /** Functional probe + a read-only denial smoke test. */
  private async probe(alias: string, runnerPath: string): Promise<LandlockEnforcement> {
    const argv = probeArgv(runnerPath)
    const result = await this.engine.exec(alias, argv.map(quoteShellArg).join(' '), { timeoutMs: this.timeoutMs })
    const enforcement = parseProbe(result.stdout, result.exitCode)
    if (enforcement === undefined) {
      const detail = result.stderr.trim() || result.stdout.trim() || result.error || `exit code ${String(result.exitCode)}`
      throw new RemoteSandboxError(
        `remote sandbox: the kernel on '${alias}' does not enforce Landlock (${detail}); DSH needs Linux 5.13+ with Landlock enabled`,
        'REMOTE_SANDBOX_PROBE_FAILED',
      )
    }
    // Denial smoke test: a read-only profile must refuse a write to $HOME.
    // A host that lets the write through is not a sandbox, whatever the probe
    // line said, so execution stays refused.
    const denyCmd = [
      quoteShellArg(runnerPath),
      ...grantArgs('read-only', '/').map(quoteShellArg),
      '--',
      'sh -c',
      // `touch`, not `:` — a redirection error on the special builtin `:` is a
      // FATAL error in non-interactive POSIX shells (dash exits 2), while an
      // external command's denial is an ordinary nonzero the `if` catches.
      quoteShellArg('f="$HOME/.dsh-hardssh/.sandbox-write-probe"; if touch "$f" 2>/dev/null; then rm -f -- "$f" 2>/dev/null; exit 9; fi; exit 0'),
    ].join(' ')
    const deny = await this.engine.exec(alias, denyCmd, { timeoutMs: this.timeoutMs })
    if (!deny.success || deny.exitCode !== 0) {
      const detail = deny.exitCode === 9
        ? 'a write outside the workspace root succeeded under the read-only profile'
        : (deny.stderr.trim() || deny.error || `exit code ${String(deny.exitCode)}`)
      throw new RemoteSandboxError(
        `remote sandbox: read-only enforcement check failed on '${alias}': ${detail}`,
        'REMOTE_SANDBOX_PROBE_FAILED',
      )
    }
    return enforcement
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Provisioner for the vendored remote Landlock launcher (host scope). */
    hardsshSandbox: RemoteSandboxProvisioner
  }
}
