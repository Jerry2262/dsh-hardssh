import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { bubblewrapArgs } from '../../src/sandbox/bubblewrap.ts'
import { RemoteSandboxProvisioner } from '../../src/sandbox/remote-sandbox.ts'

describe('remote bubblewrap profiles', () => {
  it('makes root read-only and drops capabilities in a user/PID namespace', () => {
    const args = bubblewrapArgs('read-only', '/work')
    expect(args).toContain('--unshare-user')
    expect(args).toContain('--unshare-pid')
    expect(args).toContain('--new-session')
    expect(args).toContain('--cap-drop')
    expect(args).toContain('ALL')
    expect(args.slice(args.indexOf('--ro-bind'), args.indexOf('--ro-bind') + 3)).toEqual(['--ro-bind', '/', '/'])
    expect(args).not.toContain('--bind')
    expect(args).not.toContain('--tmpfs')
    expect(args).toContain('--dev')
    expect(args.filter(arg => arg === '--remount-ro')).toHaveLength(2)
  })

  it('opens only the workspace and a private /tmp for workspace-write', () => {
    const root = "/home/u/project with spaces'"
    const args = bubblewrapArgs('workspace-write', root)
    expect(args.slice(-5)).toEqual(['--tmpfs', '/tmp', '--bind', root, root])
    expect(args.filter(arg => arg === '--bind')).toHaveLength(1)
  })

  it('rejects an unconfined or unknown mode', () => {
    expect(() => bubblewrapArgs('danger-full-access', '/work')).toThrow('requires a confined mode')
  })
})

it.skipIf(process.env.DSH_LIVE_BWRAP !== '1')('runs the provisioner-generated functional probe locally and cleans its fixtures', async () => {
  const dir = mkdtempSync(join(process.cwd(), ".bwrap-provisioner-test-'"))
  mkdirSync(join(dir, '.dsh-hardssh'))
  const ok = (stdout = '') => ({ success: true, exitCode: 0, stdout, stderr: '', timedOut: false, durationMs: 0 })
  const provisioner = new RemoteSandboxProvisioner({
    async exec(_alias, command) {
      if (command.includes('uname -s')) return ok('Linux\nx86_64\n')
      if (command.includes('$HOME')) return ok(`${dir}\n`)
      if (command.includes('--probe')) return { ...ok(), success: false, exitCode: 125, stderr: 'Landlock unavailable in this fixture' }
      if (command.includes('command -v bwrap') || command.includes('.bwrap-probe.XXXXXX')) {
        const result = spawnSync('sh', ['-c', command], { encoding: 'utf8', timeout: 10_000 })
        return { ...ok(result.stdout), stderr: result.stderr, success: result.status === 0, exitCode: result.status }
      }
      return ok()
    },
    async upload() { return { bytes: 0, files: 0 } },
  })
  try {
    expect(await provisioner.ensure('local-acceptance')).toMatchObject({ backend: 'bubblewrap', enforcement: 'full' })
    expect(readdirSync(join(dir, '.dsh-hardssh'))).toEqual([])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// Explicit opt-in: runs the actual profiles locally, never connects to SSH.
// A host without usable namespaces must fail this acceptance test, not pass a mock.
it.skipIf(process.env.DSH_LIVE_BWRAP !== '1')('enforces both profiles with real local bwrap', () => {
  const dir = mkdtempSync(join(process.cwd(), '.bwrap-profile-test-'))
  const root = join(dir, 'work')
  mkdirSync(root)
  writeFileSync(join(dir, 'outside'), 'original')
  writeFileSync(join(root, 'inside'), 'original')
  const run = (mode: 'read-only' | 'workspace-write', script: string) => spawnSync('bwrap', [
    ...bubblewrapArgs(mode, root), '--', 'sh', '-c', script, 'sh', dir,
  ], { encoding: 'utf8', timeout: 10_000 })
  try {
    const readonly = run('read-only', 'set -eu; test "$(cat "$1/outside")" = original; if printf bad > "$1/work/inside"; then exit 9; fi; if printf bad > "$1/outside"; then exit 9; fi; printf ok > /dev/null')
    expect(readonly.status, readonly.stderr).toBe(0)
    const writable = run('workspace-write', 'set -eu; printf allowed > "$1/work/inside"; printf temporary > /tmp/dsh-bwrap-acceptance; if printf bad > "$1/outside"; then exit 9; fi; printf ok > /dev/null')
    expect(writable.status, writable.stderr).toBe(0)
    expect(readFileSync(join(dir, 'outside'), 'utf8')).toBe('original')
    expect(readFileSync(join(root, 'inside'), 'utf8')).toBe('allowed')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
