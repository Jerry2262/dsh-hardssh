/**
 * Remote sandbox provisioning: platform detection, hash-based reuse, upload,
 * probe verdicts, and the fail-closed refusals. The engine is a scripted fake
 * so every remote branch (including "kernel does not enforce Landlock") is
 * exercised without a host.
 */

import { describe, expect, it } from 'vitest'
import { RemoteSandboxError, RemoteSandboxProvisioner } from '../../src/sandbox/remote-sandbox.ts'
import { runnerAssetFor } from '../../src/sandbox/landlock.ts'

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
})
