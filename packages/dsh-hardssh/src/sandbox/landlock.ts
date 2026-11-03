/**
 * Remote Landlock runner assets and the launcher's CLI spelling.
 *
 * The launcher binaries are the static `landlock-run` builds from
 * `@deepseek-ai/node-addon-system-linux-*` (MIT, see
 * `assets/sandbox/LICENSE`), vendored so a remote host needs no package
 * manager and no network. Their CLI contract is pinned by DSH itself:
 * `landlock-run [--ro <path>]... [--rw <path>]... -- <argv>...`, and
 * `landlock-run --probe` exits 0 only when the running kernel enforces the
 * ruleset ("partially enforced" on the report line = per-ABI subset).
 *
 * @module dsh-hardssh/sandbox/landlock
 */

import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { SandboxMode } from '@deepseek-ai/dsh-sandbox'

/** The launcher file name inside each vendored platform directory. */
export const LAUNCHER_BIN = 'landlock-run'

/** Remote architectures v1 supports. */
export type RunnerArch = 'linux-x64' | 'linux-arm64'

/** One vendored launcher. */
export interface LandlockRunnerAsset {
  arch: RunnerArch
  /** Absolute path of the binary shipped inside this package. */
  path: string
  /** Content hash: the remote deployment key and integrity check. */
  sha256: string
}

/** Enforcement verdict the launcher's functional probe reports. */
export type LandlockEnforcement = 'full' | 'partial'

const sha256Cache = new Map<RunnerArch, Promise<LandlockRunnerAsset>>()

/** Walk up from this module to the package root (works both from the `src/`
 *  tree and from the bundled `lib/` layout). */
function packageRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url))
  for (let depth = 0; depth < 6; depth += 1) {
    const manifest = join(dir, 'package.json')
    if (existsSync(manifest)) return dir
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  throw new Error('dsh-hardssh: cannot locate the package root for sandbox assets')
}

/** Map `uname -m` output onto a vendored runner, or undefined when unsupported. */
export function archForUnameMachine(machine: string): RunnerArch | undefined {
  switch (machine.trim().toLowerCase()) {
    case 'x86_64':
    case 'amd64':
      return 'linux-x64'
    case 'aarch64':
    case 'arm64':
      return 'linux-arm64'
    default:
      return undefined
  }
}

/** Resolve and hash one vendored launcher (cached per process). */
export function runnerAssetFor(arch: RunnerArch): Promise<LandlockRunnerAsset> {
  const cached = sha256Cache.get(arch)
  if (cached !== undefined) return cached
  const promise = (async () => {
    const path = join(packageRoot(), 'assets', 'sandbox', arch, LAUNCHER_BIN)
    const bytes = await readFile(path)
    return {
      arch,
      path,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    }
  })()
  sha256Cache.set(arch, promise)
  return promise
}

/** The launcher's functional-probe argv. */
export function probeArgv(runnerPath: string): string[] {
  return [runnerPath, '--probe']
}

/** Parse the probe's exit status + report line. */
export function parseProbe(stdout: string, exitCode: number | null): LandlockEnforcement | undefined {
  if (exitCode !== 0) return undefined
  return /partially enforced/.test(stdout) ? 'partial' : 'full'
}

/** The grant argv for one policy, mirroring DSH's native Landlock profile:
 *  everything is read-only, `/dev/null` is always writable, and
 *  `workspace-write` adds `/tmp` plus the workspace root. `danger-full-access`
 *  is never expressed as a profile: the caller runs unconfined instead. */
export function grantArgs(mode: SandboxMode, workspaceRoot: string): string[] {
  const readWrite = ['/dev/null']
  if (mode === 'workspace-write') readWrite.push('/tmp', workspaceRoot)
  return [...['/'].flatMap(root => ['--ro', root]), ...readWrite.flatMap(root => ['--rw', root])]
}
