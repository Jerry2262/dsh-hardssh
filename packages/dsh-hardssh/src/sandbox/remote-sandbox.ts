/**
 * Remote sandbox selection happens before user commands: deploy and verify
 * the vendored Landlock launcher; when its availability probe fails, discover
 * and functionally verify installed bubblewrap. Both runners enforce the
 * confined presets. A failed confinement check never permits an unconfined
 * command or a replay on another runner. No root/package-manager operations.
 *
 * @module dsh-hardssh/sandbox/remote-sandbox
 */

import { posix } from 'node:path'
import { bubblewrapArgs } from './bubblewrap.ts'
import type { SshEngine } from '../ssh/engine.ts'
import type { OperationLog, OperationRecord } from '../ssh/operation-log.ts'
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

/** Only the functional Landlock availability probe permits backend selection. */
class LandlockUnavailableError extends RemoteSandboxError {}

/** One provisioned host's facts. */
export interface RemoteSandboxState {
  alias: string
  arch: RunnerArch
  /** Absolute launcher path on the remote host. */
  runnerPath: string
  /** Content hash of the exact binary deployed there. */
  sha256: string
  enforcement: LandlockEnforcement
  /** Absent means Landlock for existing fixtures/consumers. */
  backend?: 'landlock' | 'bubblewrap'
  /** Installed bwrap version; sha256 is empty for this system-owned binary. */
  version?: string
}

/** What the provisioner needs from the engine (narrow for tests). */
export interface RemoteSandboxEngine {
  exec: SshEngine['exec']
  upload: SshEngine['upload']
}

export interface RemoteSandboxProvisionerOptions {
  /** Bounded remote round trips; provisioning is a user-visible step. */
  timeoutMs?: number
  /** Management-operation log; absent in fixtures that do not exercise it. */
  log?: OperationLog
}

const DEFAULT_TIMEOUT_MS = 30_000
const REMOTE_STATE_DIR = '.dsh-hardssh'

/** Run one bounded remote command and return the result; transport failures
 *  surface as provisioning errors instead of raw stream errors. */

/**
 * Per-host provisioner. `ensure()` is idempotent and single-flight per alias:
 * the first workspace creation uploads + probes, later ones reuse the cached
 * verdict; a failure is never cached so the next attempt retries.
 */
export class RemoteSandboxProvisioner {
  private readonly states = new Map<string, RemoteSandboxState>()
  private readonly inflight = new Map<string, Promise<RemoteSandboxState>>()
  private readonly timeoutMs: number
  private readonly log: OperationLog | undefined

  constructor(
    private readonly engine: RemoteSandboxEngine,
    options: RemoteSandboxProvisionerOptions = {},
  ) {
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
    this.log = options.log
  }

  /** Run one command and record it when this provisioner owns a log record. */
  private async step<T>(
    record: OperationRecord | undefined,
    command: string,
    run: () => Promise<T>,
    describe?: (value: T) => { exitCode?: number | null; stdout?: string; stderr?: string },
  ): Promise<T> {
    return this.log === undefined ? run() : this.log.step(record, command, run, describe)
  }

  /** Run one command, requiring exit code 0, with the same error wording as before. */
  private async execOk(
    record: OperationRecord | undefined,
    alias: string,
    command: string,
    what: string,
  ): Promise<{ stdout: string; stderr: string }> {
    const result = await this.step(
      record,
      command,
      () => this.engine.exec(alias, command, { timeoutMs: this.timeoutMs }),
      value => ({ exitCode: value.exitCode, stdout: value.stdout, stderr: value.stderr }),
    )
    if (!result.success || result.exitCode !== 0) {
      const detail = result.error ?? (result.stderr.trim() || result.stdout.trim() || `exit code ${String(result.exitCode)}`)
      throw new RemoteSandboxError(`remote sandbox: ${what} failed on '${alias}': ${detail}`, 'REMOTE_SANDBOX_PROVISION_FAILED', 502)
    }
    return { stdout: result.stdout, stderr: result.stderr }
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
    const record = this.log?.begin('sandbox.deploy', alias)
    try {
      const { os, machine } = await this.detectPlatform(record, alias)
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
      const home = await this.remoteHome(record, alias)
      const asset = await runnerAssetFor(arch)
      const dir = posix.join(home, REMOTE_STATE_DIR, 'sandbox', `runner-${asset.sha256.slice(0, 12)}`)
      const runnerPath = posix.join(dir, LAUNCHER_BIN)
      await this.deployIfStale(record, alias, asset, dir, runnerPath)
      let enforcement: LandlockEnforcement
      try {
        enforcement = await this.probe(record, alias, runnerPath)
      } catch (error) {
        // Selection is infrastructure-only, before any user command. A broken
        // denial check is a security failure, never a reason to try another runner.
        if (!(error instanceof LandlockUnavailableError)) throw error
        const alternative = await this.probeBubblewrap(record, alias, arch, home, error)
        this.log?.finish(record, 'ok')
        return alternative
      }
      this.log?.finish(record, 'ok')
      return { alias, arch, runnerPath, sha256: asset.sha256, enforcement, backend: 'landlock' }
    } catch (error: unknown) {
      this.log?.finish(record, 'failed', errorMessage(error), failureDetail(error))
      throw error
    }
  }

  private async detectPlatform(record: OperationRecord | undefined, alias: string): Promise<{ os: string; machine: string }> {
    const { stdout } = await this.execOk(record, alias, "printf '%s\\n' \"$(uname -s)\" \"$(uname -m)\"", 'platform detection')
    const [os = '', machine = ''] = stdout.trim().split('\n')
    if (os === '' || machine === '') {
      throw new RemoteSandboxError(`remote sandbox: '${alias}' returned no platform information from uname`, 'REMOTE_SANDBOX_PROVISION_FAILED', 502)
    }
    return { os: os.trim(), machine: machine.trim() }
  }

  private async remoteHome(record: OperationRecord | undefined, alias: string): Promise<string> {
    const { stdout } = await this.execOk(record, alias, "printf '%s\\n' \"$HOME\"", 'home resolution')
    const home = stdout.trim()
    if (!home.startsWith('/')) {
      throw new RemoteSandboxError(`remote sandbox: '${alias}' has no absolute $HOME (got '${home}')`, 'REMOTE_SANDBOX_PROVISION_FAILED', 502)
    }
    return home
  }

  /** Upload the launcher when the remote copy is missing or differs. */
  private async deployIfStale(
    record: OperationRecord | undefined,
    alias: string,
    asset: LandlockRunnerAsset,
    dir: string,
    runnerPath: string,
  ): Promise<void> {
    const quotedPath = quoteShellArg(runnerPath)
    const hashCommand = `sha256sum -- ${quotedPath} 2>/dev/null | cut -d' ' -f1`
    // sha256sum is part of coreutils on every supported distro; a host without
    // it cannot be verified, so the deployment is refreshed instead of trusted.
    const hashResult = await this.step(
      record,
      hashCommand,
      () => this.engine.exec(alias, hashCommand, { timeoutMs: this.timeoutMs }),
      value => ({ exitCode: value.exitCode, stdout: value.stdout, stderr: value.stderr }),
    )
    const remoteHash = hashResult.success && hashResult.exitCode === 0 ? hashResult.stdout.trim() : ''
    if (remoteHash === asset.sha256) return
    await this.execOk(record, alias, `mkdir -p -- ${quoteShellArg(dir)}`, 'runner directory creation')
    try {
      await this.step(
        record,
        `upload ${asset.path} -> ${runnerPath}`,
        () => this.engine.upload(alias, asset.path, runnerPath, false),
        value => ({ exitCode: 0, stdout: `${value.bytes} bytes` }),
      )
    } catch (error: unknown) {
      const detail = error instanceof Error ? error.message : String(error)
      throw new RemoteSandboxError(`remote sandbox: uploading the Landlock launcher to '${alias}' failed: ${detail}`, 'REMOTE_SANDBOX_PROVISION_FAILED', 502)
    }
    await this.execOk(record, alias, `chmod 755 -- ${quotedPath}`, 'runner permission update')
  }

  /** Functional probe + a read-only denial smoke test. */
  private async probe(
    record: OperationRecord | undefined,
    alias: string,
    runnerPath: string,
  ): Promise<LandlockEnforcement> {
    const argv = probeArgv(runnerPath)
    const probeCommand = argv.map(quoteShellArg).join(' ')
    const result = await this.step(
      record,
      probeCommand,
      () => this.engine.exec(alias, probeCommand, { timeoutMs: this.timeoutMs }),
      value => ({ exitCode: value.exitCode, stdout: value.stdout, stderr: value.stderr }),
    )
    const enforcement = parseProbe(result.stdout, result.exitCode)
    if (enforcement === undefined) {
      const detail = result.stderr.trim() || result.stdout.trim() || result.error || `exit code ${String(result.exitCode)}`
      // The launcher line says only "not enforced". Ask the kernel itself so
      // the refusal states WHY it stopped: old kernel, missing/disabled LSM
      // entry, or a container that blocks the syscall.
      const facts = await this.kernelFacts(record, alias)
      const factsSuffix = facts === undefined ? '' : ` [${facts}]`
      throw new LandlockUnavailableError(
        `remote sandbox: the kernel on '${alias}' does not enforce Landlock${factsSuffix} (${detail}); the Landlock backend requires Linux 5.13+ with Landlock enabled`,
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
    const deny = await this.step(
      record,
      denyCmd,
      () => this.engine.exec(alias, denyCmd, { timeoutMs: this.timeoutMs }),
      value => ({ exitCode: value.exitCode, stdout: value.stdout, stderr: value.stderr }),
    )
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

  /** Discover and functionally verify installed bwrap before selecting it. */
  private async probeBubblewrap(
    record: OperationRecord | undefined, alias: string, arch: RunnerArch, home: string,
    landlockError: Error,
  ): Promise<RemoteSandboxState> {
    try {
      const found = await this.execOk(record, alias,
        'p=$(command -v bwrap) || exit 1; case "$p" in /*) ;; *) exit 1 ;; esac; test -f "$p" && test -x "$p" || exit 1; printf "%s\\n" "$p"; "$p" --version',
        'bubblewrap discovery')
      const [runnerPath = '', version = ''] = found.stdout.trim().split('\n')
      if (!runnerPath.startsWith('/') || !/^bubblewrap\s+\d+\.\d+/.test(version)) {
        throw new Error('bwrap discovery did not return an absolute executable path and bubblewrap version')
      }
      const ro = [runnerPath, ...bubblewrapArgs('read-only', '/')].map(quoteShellArg).join(' ')
      // Create controlled writable fixtures OUTSIDE the sandbox. The positive
      // baseline prevents a denied host filesystem from yielding a false pass.
      // mktemp + trap guarantee only this probe's own files are removed.
      const setup = `set -eu; d=$(mktemp -d -- ${quoteShellArg(posix.join(home, '.dsh-hardssh', '.bwrap-probe.XXXXXX'))}); trap 'rm -rf -- "$d"' EXIT; mkdir "$d/work"; printf original > "$d/outside"; printf original > "$d/work/inside"; `
      const readonly = `${ro} -- sh -c ${quoteShellArg('set -eu; test "$(cat "$1/outside")" = original; if printf forbidden > "$1/outside"; then exit 9; fi; if printf forbidden > "$1/work/inside"; then exit 9; fi; printf ok > /dev/null')} sh "$d"`
      // Expand the per-probe workspace path in the management shell, never as
      // user-supplied shell text. /tmp is private and discarded at runner exit.
      const rw = [runnerPath, ...bubblewrapArgs('workspace-write', '__WORKSPACE__')]
        .map(arg => arg === '__WORKSPACE__' ? '"$d/work"' : quoteShellArg(arg)).join(' ')
      const writable = `${rw} -- sh -c ${quoteShellArg('set -eu; printf allowed > "$1/work/inside"; printf temporary > /tmp/dsh-bwrap-probe; if printf forbidden > "$1/outside"; then exit 9; fi; printf ok > /dev/null')} sh "$d"`
      const verified = await this.execOk(record, alias,
        `${setup}${readonly}; ${writable}; test "$(cat "$d/outside")" = original; test "$(cat "$d/work/inside")" = allowed; printf 'bwrap confinement verified\\n'`,
        'bubblewrap namespace and write confinement probe')
      if (verified.stdout.trim() !== 'bwrap confinement verified') throw new Error('missing bwrap confinement verification marker')
      return { alias, arch, runnerPath, sha256: '', enforcement: 'full', backend: 'bubblewrap', version }
    } catch (error) {
      throw new RemoteSandboxError(
        `${landlockError.message}; bubblewrap unavailable: ${errorMessage(error)}; no verified remote sandbox backend is available`,
        'REMOTE_SANDBOX_PROBE_FAILED',
      )
    }
  }

  /** Best-effort kernel facts for a failed Landlock probe (never throws). */
  private async kernelFacts(record: OperationRecord | undefined, alias: string): Promise<string | undefined> {
    // /proc/cmdline tells whether the boot `lsm=` parameter excludes Landlock;
    // the kernel config tells whether Landlock was compiled in at all. Together
    // they separate "too old kernel" / "built without Landlock" / "disabled
    // at boot (lsm=)" without an interactive SSH session.
    const command = `printf 'kernel=%s\nlsm=%s\ncmdline=%s\nlandlock=%s\n' "$(uname -r)" "$(cat /sys/kernel/security/lsm 2>/dev/null)" "$(cat /proc/cmdline 2>/dev/null)" "$( (zcat /proc/config.gz 2>/dev/null || cat /boot/config-$(uname -r) 2>/dev/null) | grep -m1 CONFIG_SECURITY_LANDLOCK )"`
    try {
      const result = await this.step(
        record,
        command,
        () => this.engine.exec(alias, command, { timeoutMs: Math.min(this.timeoutMs, 5_000) }),
        value => ({ exitCode: value.exitCode, stdout: value.stdout, stderr: value.stderr }),
      )
      if (!result.success || result.exitCode !== 0) return undefined
      const kernel = /kernel=(.*)/.exec(result.stdout)?.[1]?.trim() ?? 'unknown'
      const lsm = /lsm=(.*)/.exec(result.stdout)?.[1]?.trim() ?? ''
      const cmdline = /cmdline=(.*)/.exec(result.stdout)?.[1]?.trim() ?? ''
      const landlock = /landlock=(.*)/.exec(result.stdout)?.[1]?.trim() ?? ''
      const facts = [`kernel ${kernel}`, `LSM ${lsm === '' ? '(unreadable)' : lsm}`]
      if (cmdline !== '') facts.push(`cmdline ${cmdline.length > 300 ? `${cmdline.slice(0, 300)}…` : cmdline}`)
      if (landlock !== '') {
        facts.push(landlock.includes('is not set') ? 'Landlock not compiled' : `Landlock config ${landlock}`)
      }
      return facts.join('; ')
    } catch {
      return undefined
    }
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Keep the inner cause when the top-level message is a wrapper. */
function failureDetail(error: unknown): string | undefined {
  if (!(error instanceof Error)) return undefined
  const cause = (error as { cause?: unknown }).cause
  if (cause === undefined) return undefined
  return cause instanceof Error ? cause.message : String(cause)
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Verified remote sandbox backend selection (host scope). */
    hardsshSandbox: RemoteSandboxProvisioner
  }
}
