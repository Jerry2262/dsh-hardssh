/**
 * Opt-in live check against a real configured SSH host (`DSH_LIVE_SSH=1`):
 * selects a verified remote sandbox backend, runs a command through it, and
 * verifies the read-only profile really denies an out-of-workspace write.
 * Never runs in the default suite.
 */

import { describe, expect, it } from 'vitest'
import { SshEngine } from '../../src/ssh/engine.ts'
import { HostStore, SecureHostStore } from '../../src/ssh/store.ts'
import { KnownHostsStore } from '../../src/ssh/known-hosts.ts'
import { withSshConfig } from '../../src/ssh/ssh-config.ts'
import { RemoteSandboxProvisioner } from '../../src/sandbox/remote-sandbox.ts'
import { grantArgs } from '../../src/sandbox/landlock.ts'
import { bubblewrapArgs } from '../../src/sandbox/bubblewrap.ts'
import { shellQuote } from '../../src/shell.ts'

const HOST = process.env.DSH_LIVE_SSH_HOST ?? 'aliyun'
const ROOT = process.env.DSH_LIVE_SSH_ROOT ?? '/home/jerry/tmp'
const enabled = process.env.DSH_LIVE_SSH === '1'

describe.skipIf(!enabled)('remote sandbox (live)', () => {
  it('provisions, executes, and denies under read-only', async () => {
    const store = new HostStore()
    const secure = new SecureHostStore(undefined)
    const engine = new SshEngine(withSshConfig(secure), undefined, {
      resolveSecrets: entry => secure.resolveAuth(entry),
      knownHosts: new KnownHostsStore(),
    })
    try {
      const provisioner = new RemoteSandboxProvisioner(engine)
      const state = await provisioner.ensure(HOST)
      // The host kernel may expose an older Landlock ABI: partial enforcement
      // still confines every handled file access and is what the native
      // executor reports as `partial` too.
      expect(['full', 'partial']).toContain(state.enforcement)

      const wrap = (mode: 'read-only' | 'workspace-write', script: string): string => [
        'cd --', shellQuote(ROOT), '&&', shellQuote(state.runnerPath),
        ...(state.backend === 'bubblewrap' ? bubblewrapArgs(mode, ROOT) : grantArgs(mode, ROOT)).map(shellQuote), '--',
        'bash', '-c', shellQuote(script),
      ].join(' ')

      const ok = await engine.exec(HOST, wrap('workspace-write', 'echo LIVE_OK; pwd; uname -m'))
      expect(ok.exitCode).toBe(0)
      expect(ok.stdout).toContain('LIVE_OK')
      expect(ok.stdout).toContain(ROOT)

      const denied = await engine.exec(HOST, wrap('read-only', `echo x > ${shellQuote(`${ROOT}/.live-probe`)} 2>/dev/null && echo LEAK || echo DENIED`))
      expect(denied.stdout).toContain('DENIED')
    } finally {
      engine.dispose()
    }
  }, 60_000)
})
