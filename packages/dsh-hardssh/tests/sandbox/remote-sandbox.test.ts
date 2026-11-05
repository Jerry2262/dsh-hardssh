/**
 * Remote sandbox provisioning: platform detection, hash-based reuse, upload,
 * probe verdicts, and the fail-closed refusals. The engine is a scripted fake
 * so every remote branch (including "kernel does not enforce Landlock") is
 * exercised without a host.
 */

import { describe, expect, it } from 'vitest'
import { RemoteSandboxError, RemoteSandboxProvisioner } from '../../src/sandbox/remote-sandbox.ts'
import { runnerAssetFor } from '../../src/sandbox/landlock.ts'
import { OperationLog } from '../../src/ssh/operation-log.ts'

interface ExecResult {
  success: boolean
  exitCode: number | null
  stdout: string
  stderr: string
  timedOut: boolean
  durationMs: number
  error?: string
}

const ok = (stdout = ''): ExecResult => ({ success: true, exitCode: 0, stdout, stderr: '', timedOut: false, durationMs: 1 })

/** Scripted engine: the handler receives the raw remote command text. */
function fakeEngine(handler: (command: string) => ExecResult | Promise<ExecResult>) {
  const commands: string[] = []
  const uploads: Array<{ localPath: string; remotePath: string }> = []
  return {
    commands,
    uploads,
    engine: {
      async exec(_alias: string, command: string): Promise<ExecResult> {
        commands.push(command)
        return await handler(command)
      },
      async upload(_alias: string, localPath: string, remotePath: string): Promise<{ bytes: number; files: number }> {
        uploads.push({ localPath, remotePath })
        return { bytes: 1, files: 1 }
      },
    },
  }
}

function happyScript(remoteHash: string) {
  return (command: string): ExecResult => {
    if (command.includes('uname -s')) return ok('Linux\nx86_64\n')
    if (command.includes('$HOME')) return ok('/home/remote\n')
    if (command.includes('sha256sum')) return remoteHash === '' ? { ...ok(), success: false, exitCode: 1 } : ok(`${remoteHash}\n`)
    if (command.includes('mkdir -p')) return ok()
    if (command.includes('chmod 755')) return ok()
    if (command.includes('--probe')) return ok('landlock: fully enforced\n')
    if (command.includes('--ro')) return ok()
    return ok()
  }
}

describe('RemoteSandboxProvisioner', () => {
  it('provisions, probes, caches, and reuses the deployed launcher', async () => {
    const asset = await runnerAssetFor('linux-x64')
    const fake = fakeEngine(happyScript(''))
    const provisioner = new RemoteSandboxProvisioner(fake.engine)

    const state = await provisioner.ensure('aliyun')
    expect(state).toMatchObject({ alias: 'aliyun', arch: 'linux-x64', enforcement: 'full', sha256: asset.sha256 })
    expect(state.runnerPath).toBe(`/home/remote/.dsh-hardssh/sandbox/runner-${asset.sha256.slice(0, 12)}/landlock-run`)
    expect(fake.uploads).toEqual([{ localPath: asset.path, remotePath: state.runnerPath }])
    expect(provisioner.stateFor('aliyun')).toBe(state)

    const again = await provisioner.ensure('aliyun')
    expect(again).toBe(state)
    expect(fake.uploads).toHaveLength(1)
  })

  it('reuses an existing remote copy whose hash matches, without uploading', async () => {
    const asset = await runnerAssetFor('linux-arm64')
    const fake = fakeEngine((command) => {
      if (command.includes('uname -s')) return ok('Linux\naarch64\n')
      if (command.includes('$HOME')) return ok('/home/remote\n')
      if (command.includes('sha256sum')) return ok(`${asset.sha256}\n`)
      if (command.includes('--probe')) return ok('landlock: partially enforced\n')
      if (command.includes('--ro')) return ok()
      return ok()
    })
    const provisioner = new RemoteSandboxProvisioner(fake.engine)
    const state = await provisioner.ensure('aliyun')
    expect(state.arch).toBe('linux-arm64')
    expect(state.enforcement).toBe('partial')
    expect(fake.uploads).toHaveLength(0)
  })

  it('refuses a non-Linux host', async () => {
    const fake = fakeEngine((command) => (command.includes('uname -s') ? ok('Darwin\narm64\n') : ok()))
    const provisioner = new RemoteSandboxProvisioner(fake.engine)
    await expect(provisioner.ensure('mac')).rejects.toMatchObject({
      code: 'REMOTE_SANDBOX_UNSUPPORTED_OS',
      status: 400,
    })
  })

  it('refuses an unsupported architecture', async () => {
    const fake = fakeEngine((command) => (command.includes('uname -s') ? ok('Linux\nriscv64\n') : ok()))
    const provisioner = new RemoteSandboxProvisioner(fake.engine)
    await expect(provisioner.ensure('host')).rejects.toMatchObject({ code: 'REMOTE_SANDBOX_UNSUPPORTED_ARCH' })
  })

  it('refuses a kernel that does not enforce Landlock', async () => {
    const fake = fakeEngine((command) => {
      if (command.includes('uname -s')) return ok('Linux\nx86_64\n')
      if (command.includes('$HOME')) return ok('/home/remote\n')
      if (command.includes('sha256sum')) return { ...ok(), success: false, exitCode: 1 }
      if (command.includes('--probe')) return { ...ok(), success: false, exitCode: 125, stderr: 'landlock-run: kernel does not support Landlock\n' }
      return ok()
    })
    const provisioner = new RemoteSandboxProvisioner(fake.engine)
    await expect(provisioner.ensure('old')).rejects.toMatchObject({ code: 'REMOTE_SANDBOX_PROBE_FAILED' })
    // A failure is not cached: the next attempt runs the probe again.
    await expect(provisioner.ensure('old')).rejects.toBeInstanceOf(RemoteSandboxError)
  })

  it('reports kernel, LSM, boot cmdline and Landlock config when the probe fails', async () => {
    const fake = fakeEngine((command) => {
      if (command.includes('uname -s')) return ok('Linux\nx86_64\n')
      if (command.includes('$HOME')) return ok('/home/remote\n')
      if (command.includes('sha256sum')) return { ...ok(), success: false, exitCode: 1 }
      if (command.includes('--probe')) return { ...ok(), success: false, exitCode: 125, stderr: 'landlock-run: landlock is not enforced by this kernel\n' }
      if (command.includes('uname -r')) {
        return ok([
          'kernel=6.6.0-98.0.0.103.oe2403sp2.x86_64',
          'lsm=lockdown,capability,yama,selinux,bpf',
          'cmdline=BOOT_IMAGE=/vmlinuz ro root=UUID=abc lsm=lockdown,capability,yama,selinux,bpf',
          'landlock=CONFIG_SECURITY_LANDLOCK=y',
        ].join('\n') + '\n')
      }
      return ok()
    })
    const provisioner = new RemoteSandboxProvisioner(fake.engine)
    const error = await provisioner.ensure('zen5-88').then(
      () => { throw new Error('expected the probe to fail') },
      (cause: unknown) => cause,
    )
    const message = error instanceof Error ? error.message : String(error)
    expect(message).toContain('kernel 6.6.0-98.0.0.103.oe2403sp2.x86_64')
    expect(message).toContain('LSM lockdown,capability,yama,selinux,bpf')
    expect(message).toContain('cmdline BOOT_IMAGE=/vmlinuz')
    expect(message).toContain('Landlock config CONFIG_SECURITY_LANDLOCK=y')
    // The diagnostic round trip uses the normal exec path (so it also lands
    // in the operation log when a log is wired).
    expect(fake.commands.some(command => command.includes('uname -r'))).toBe(true)
  })

  it('flags a kernel that was built without Landlock', async () => {
    const fake = fakeEngine((command) => {
      if (command.includes('uname -s')) return ok('Linux\nx86_64\n')
      if (command.includes('$HOME')) return ok('/home/remote\n')
      if (command.includes('sha256sum')) return { ...ok(), success: false, exitCode: 1 }
      if (command.includes('--probe')) return { ...ok(), success: false, exitCode: 125, stderr: 'landlock-run: landlock is not enforced by this kernel\n' }
      if (command.includes('uname -r')) {
        return ok('kernel=4.18.0-513.el8.x86_64\nlsm=lockdown,yama,selinux\ncmdline=ro quiet\nlandlock=# CONFIG_SECURITY_LANDLOCK is not set\n')
      }
      return ok()
    })
    const provisioner = new RemoteSandboxProvisioner(fake.engine)
    const error = await provisioner.ensure('centos8').then(
      () => { throw new Error('expected the probe to fail') },
      (cause: unknown) => cause,
    )
    expect(error instanceof Error ? error.message : '').toContain('Landlock not compiled')
  })

  it('refuses when the read-only smoke test lets a write through', async () => {
    const fake = fakeEngine((command) => {
      if (command.includes('uname -s')) return ok('Linux\nx86_64\n')
      if (command.includes('--probe')) return ok('landlock: fully enforced\n')
      if (command.includes('--ro')) return { ...ok(), success: false, exitCode: 9 }
      if (command.includes('$HOME')) return ok('/home/remote\n')
      if (command.includes('sha256sum')) return { ...ok(), success: false, exitCode: 1 }
      return ok()
    })
    const provisioner = new RemoteSandboxProvisioner(fake.engine)
    await expect(provisioner.ensure('leaky')).rejects.toMatchObject({ code: 'REMOTE_SANDBOX_PROBE_FAILED' })
  })

  it('refuses when the launcher upload fails', async () => {
    const fake = fakeEngine((command) => {
      if (command.includes('uname -s')) return ok('Linux\nx86_64\n')
      if (command.includes('$HOME')) return ok('/home/remote\n')
      if (command.includes('sha256sum')) return { ...ok(), success: false, exitCode: 1 }
      if (command.includes('mkdir -p')) return ok()
      return ok()
    })
    fake.engine.upload = async () => {
      throw new Error('scp: disk full')
    }
    const provisioner = new RemoteSandboxProvisioner(fake.engine)
    await expect(provisioner.ensure('box')).rejects.toMatchObject({
      code: 'REMOTE_SANDBOX_PROVISION_FAILED',
      status: 502,
    })
  })

  it('logs the deploy operation with the failing command and its stderr', async () => {
    const fake = fakeEngine((command) => {
      if (command.includes('uname -s')) return ok('Linux\nx86_64\n')
      if (command.includes('$HOME')) return ok('/home/shixianjie\n')
      if (command.includes('sha256sum')) return { ...ok(), success: false, exitCode: 1 }
      if (command.includes('mkdir -p')) {
        return {
          ...ok(),
          success: false,
          exitCode: 1,
          stderr: "mkdir: cannot create directory '/home/shixianjie/.dsh-hardssh': Permission denied\n",
        }
      }
      return ok()
    })
    const log = new OperationLog()
    const provisioner = new RemoteSandboxProvisioner(fake.engine, { log })
    await expect(provisioner.ensure('zen5-88')).rejects.toBeInstanceOf(RemoteSandboxError)

    const entries = log.snapshot().entries
    expect(entries).toHaveLength(1)
    const entry = entries[0]!
    expect(entry.operation).toBe('sandbox.deploy')
    expect(entry.alias).toBe('zen5-88')
    expect(entry.status).toBe('failed')
    expect(entry.error).toContain('runner directory creation failed')

    const mkdir = entry.steps.find(step => step.command.includes('mkdir -p'))!
    expect(mkdir.exitCode).toBe(1)
    expect(mkdir.stderrTail).toContain('Permission denied')
    // The platform/home steps that ran before the failure are kept too.
    expect(entry.steps.map(step => step.command)).toEqual(expect.arrayContaining([
      expect.stringContaining('uname -s'),
      expect.stringContaining('$HOME'),
    ]))
  })
})
