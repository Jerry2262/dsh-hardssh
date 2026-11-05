/**
 * Integration tests for the routed `ctx.shell` row over a REAL Cordis context.
 *
 * The previous version of this row constructed the native sandbox executor on
 * a manually isolated child context; Cordis never resolved that child's
 * `inject`, so the first local `ctx.sandbox` access threw
 * `cannot get property "sandbox" without inject`. Fake-context unit tests
 * cannot see that class of bug — these tests mount the real service graph,
 * stub only the providers, and execute both worlds through the public
 * `resolve` / `execute` seam.
 */

import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import { anchorRoot } from '../../src/ledger.ts'
import { apply, type Config } from '../../src/shell-executor.ts'
import type { ShellExecSpec, ShellExecution } from '@deepseek-ai/dsh-shell'

/** Reactive config accessors as the plugin receives them from Cordis. */
function config(): Config {
  const value = (n: number) => ({ get: () => n })
  return {
    cwd: { get: () => '/local/workspace' },
    timeoutMs: value(120_000),
    maxTimeoutMs: value(600_000),
    maxOutputBytes: value(64_000),
    maxSpillBytes: value(64 * 1024 * 1024),
    graceMs: value(3_000),
  } as unknown as Config
}

interface Stubs {
  ctx: Context
  shell: {
    resolve(request: unknown): ShellExecSpec
    execute(spec: ShellExecSpec): Promise<ShellExecution>
    executeArgv: unknown
  }
  spawns: string[][]
  spawnCwds: Array<string | undefined>
  confine: ReturnType<typeof vi.fn>
  ensure: ReturnType<typeof vi.fn>
  invalidate: ReturnType<typeof vi.fn>
}

function execution(): ShellExecution {
  return {
    result: async () => ({
      exitCode: 0,
      signal: null,
      timedOut: false,
      stdout: { text: 'hi', truncated: false },
      stderr: { text: '', truncated: false },
    }),
  } as unknown as ShellExecution
}

function harness(options: {
  anchor?: string
  remoteRoot?: string
  enforcement?: 'full' | 'partial'
  withProvisioner?: boolean
  backend?: 'landlock' | 'bubblewrap'
  result?: { exitCode: number; stderr: string }
} = {}): Stubs {
  const anchor = options.anchor
  const remoteRoot = options.remoteRoot ?? '/remote/root'
  const spawns: string[][] = []
  const spawnCwds: Array<string | undefined> = []
  const confine = vi.fn(async (argv: readonly string[]) => ({
    argv: ['confined', ...argv],
    enforcement: 'full' as const,
    denialSignatures: ['denied'],
    runnerFailureRules: [],
  }))
  const ensure = vi.fn(async (alias: string) => ({
    alias,
    arch: 'linux-x64',
    runnerPath: options.backend === 'bubblewrap' ? '/usr/bin/bwrap' : '/remote/home/.dsh-hardssh/sandbox/runner-abc/landlock-run',
    backend: options.backend,
    sha256: 'abc',
    enforcement: options.enforcement ?? 'partial',
  }))
  const invalidate = vi.fn()

  const ctx = new Context()
  const core = {
    isReady: () => true,
    router: {
      fromAnchor: (cwd: string | undefined) => (anchor !== undefined && cwd === anchor ? { workspaceId: 'ws-1' } : undefined),
    },
    ledger: {
      snapshotSync: () => ({
        records: anchor === undefined
          ? []
          : [{
              id: 'ws-1',
              anchor: { path: anchor },
              provider: { connectionRef: { alias: 'host-a' } },
              location: { root: remoteRoot },
            }],
      }),
    },
  }
  const sandboxPolicy = {
    defaultMode: 'workspace-write' as const,
    resolve: () => ({ mode: 'workspace-write' as const, workspaceRoot: anchor ?? '/local/workspace' }),
  }

  ctx.provide('workspaceCore', core)
  if (options.withProvisioner !== false) ctx.provide('hardsshSandbox', { ensure, invalidate })
  ctx.provide('sandboxPolicy', sandboxPolicy)
  ctx.provide('sandbox', { confine })
  ctx.provide('subprocess', { spawn: vi.fn() })
  apply(ctx, config())

  const shell = ctx.shell as unknown as Stubs['shell']
  shell.executeArgv = vi.fn(async (spec: ShellExecSpec, argvOrPrepare: unknown) => {
    const signal = new AbortController().signal
    const argv = typeof argvOrPrepare === 'function'
      ? await (argvOrPrepare as (s: AbortSignal) => Promise<string[]>)(signal)
      : argvOrPrepare as string[]
    spawns.push([...argv])
    spawnCwds.push(spec.workdir)
    const running = execution()
    if (options.result !== undefined) {
      const result = options.result
      const original = running.result.bind(running)
      running.result = async () => ({ ...(await original()), exitCode: result.exitCode, stderr: { text: result.stderr, truncated: false } })
    }
    return running
  })
  return { ctx, shell, spawns, spawnCwds, confine, ensure, invalidate }
}

const policy = (workspaceRoot: string, mode: 'workspace-write' | 'read-only' | 'danger-full-access' = 'workspace-write') =>
  ({ mode, workspaceRoot }) as const

describe('routed shell executor over a real Cordis context', () => {
  it('runs a LOCAL command through the injected sandbox provider', async () => {
    const h = harness()
    const spec = h.shell.resolve({ command: 'echo hi', workdir: '/local/workspace', sandboxPolicy: policy('/local/workspace') })
    const running = await h.shell.execute(spec)
    const result = await running.result()

    // The local world must not throw the old `sandbox ... without inject`
    // error, must confine the exact bash argv, and must report enforcement.
    expect(h.confine).toHaveBeenCalledTimes(1)
    expect(h.confine.mock.calls[0]![0]).toEqual(['bash', '-c', 'echo hi'])
    expect(h.spawns[0]).toEqual(['confined', 'bash', '-c', 'echo hi'])
    expect(result.sandbox).toEqual({ mode: 'workspace-write', denied: false, enforcement: 'full' })
  })

  it('runs a LOCAL danger-full-access command unconfined', async () => {
    const h = harness()
    const spec = h.shell.resolve({ command: 'echo hi', workdir: '/local/workspace', sandboxPolicy: policy('/local/workspace', 'danger-full-access') })
    const result = await (await h.shell.execute(spec)).result()

    expect(h.confine).not.toHaveBeenCalled()
    expect(h.spawns[0]).toEqual(['bash', '-c', 'echo hi'])
    expect(result.sandbox).toEqual({ mode: 'danger-full-access', denied: false })
  })

  it('routes an SSH-bound cwd through the provisioned remote launcher', async () => {
    const anchor = `${anchorRoot()}/ws-1`
    const h = harness({ anchor })
    const spec = h.shell.resolve({ command: 'uname -m', workdir: anchor, sandboxPolicy: policy(anchor) })
    const result = await (await h.shell.execute(spec)).result()

    expect(h.ensure).toHaveBeenCalledWith('host-a')
    expect(h.confine).not.toHaveBeenCalled()
    expect(h.spawns[0]!.slice(0, 2)).toEqual([
      '/remote/home/.dsh-hardssh/sandbox/runner-abc/landlock-run',
      '--ro',
    ])
    expect(h.spawns[0]).toContain('--')
    expect(h.spawns[0]!.slice(-3)).toEqual(['bash', '-c', 'uname -m'])
    expect(h.spawnCwds[0]).toBe(anchor)
    expect(result.sandbox).toEqual({ mode: 'workspace-write', denied: false, enforcement: 'partial' })
  })

  it('keeps the anchor spawn cwd for an explicit REMOTE workdir', async () => {
    const anchor = `${anchorRoot()}/ws-1`
    const h = harness({ anchor })
    const spec = h.shell.resolve({ command: 'pwd', workdir: '/remote/sub', sandboxPolicy: policy(anchor) })
    await h.shell.execute(spec)

    expect(h.spawnCwds[0]).toBe(anchor)
    expect(h.spawns[0]!.slice(-3)).toEqual(['bash', '-c', "cd -- '/remote/sub' && pwd"])
  })

  it.each(['read-only', 'workspace-write'] as const)('uses the selected bwrap backend for %s', async mode => {
    const anchor = `${anchorRoot()}/ws-1`
    const h = harness({ anchor, backend: 'bubblewrap', enforcement: 'full' })
    const spec = h.shell.resolve({ command: 'echo user-command', workdir: anchor, sandboxPolicy: policy(anchor, mode) })
    const result = await (await h.shell.execute(spec)).result()
    const argv = h.spawns[0]!
    expect(argv[0]).toBe('/usr/bin/bwrap')
    expect(argv).toContain('--unshare-user')
    expect(argv).toContain('--ro-bind')
    expect(argv).toContain('--cap-drop')
    expect(argv.includes('--bind')).toBe(mode === 'workspace-write')
    expect(argv.includes('--tmpfs')).toBe(mode === 'workspace-write')
    expect(argv.slice(-4)).toEqual(['--', 'bash', '-c', 'echo user-command'])
    expect(result.sandbox).toEqual({ mode, denied: false, enforcement: 'full' })
  })

  it.each([
    ['bubblewrap', 1, 'bwrap: Creating new namespace failed'],
    ['landlock', 125, 'landlock-run: failed'],
  ] as const)('never replays the user command after %s runner failure', async (backend, exitCode, stderr) => {
    const anchor = `${anchorRoot()}/ws-1`
    const h = harness({ anchor, backend, result: { exitCode, stderr } })
    const spec = h.shell.resolve({ command: 'touch /remote/root/once', workdir: anchor, sandboxPolicy: policy(anchor) })
    const running = await h.shell.execute(spec)
    await expect(running.result()).rejects.toThrow('remote sandbox runner failed')
    await expect(running.result()).rejects.toThrow('remote sandbox runner failed')
    expect(h.spawns).toHaveLength(1)
    expect(h.ensure).toHaveBeenCalledTimes(1)
    expect(h.invalidate).toHaveBeenCalledTimes(1)
  })

  it('does not switch backend on an ordinary nonzero user-command exit', async () => {
    const anchor = `${anchorRoot()}/ws-1`
    const h = harness({ anchor, backend: 'bubblewrap', result: { exitCode: 2, stderr: 'application failed' } })
    const spec = h.shell.resolve({ command: 'exit 2', workdir: anchor, sandboxPolicy: policy(anchor) })
    expect((await (await h.shell.execute(spec)).result()).exitCode).toBe(2)
    expect(h.spawns).toHaveLength(1)
    expect(h.invalidate).not.toHaveBeenCalled()
  })

  it('fails closed instead of running locally when the remote provisioner is missing', async () => {
    const anchor = `${anchorRoot()}/ws-1`
    const h = harness({ anchor, withProvisioner: false })
    const spec = h.shell.resolve({ command: 'true', workdir: anchor, sandboxPolicy: policy(anchor) })

    await expect(h.shell.execute(spec)).rejects.toThrow(/provisioner is unavailable/)
    expect(h.spawns).toHaveLength(0)
  })
})
