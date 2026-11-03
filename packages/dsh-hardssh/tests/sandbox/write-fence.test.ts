/**
 * Remote write fence: the policy-only containment applied to canonical remote
 * paths for SFTP write/edit.
 */

import { describe, expect, it } from 'vitest'
import { assertRemoteWritable } from '../../src/sandbox/write-fence.ts'

const policy = (mode: 'read-only' | 'workspace-write' | 'danger-full-access', workspaceRoot = '/home/u/ws') =>
  ({ mode, workspaceRoot }) as never

describe('assertRemoteWritable', () => {
  it('denies every mutation under read-only', () => {
    expect(() => assertRemoteWritable('/home/u/ws/a.ts', 'a.ts', policy('read-only')))
      .toThrowError(/read-only mode/)
    try {
      assertRemoteWritable('/home/u/ws/a.ts', 'a.ts', policy('read-only'))
      throw new Error('expected a denial')
    } catch (error) {
      expect(error).toMatchObject({ code: 'FS_SANDBOX_DENIED' })
    }
  })

  it('allows the workspace root and /tmp under workspace-write, and nothing else', () => {
    expect(() => assertRemoteWritable('/home/u/ws/a.ts', 'a.ts', policy('workspace-write'))).not.toThrow()
    expect(() => assertRemoteWritable('/home/u/ws', 'ws', policy('workspace-write'))).not.toThrow()
    expect(() => assertRemoteWritable('/tmp/x', 'x', policy('workspace-write'))).not.toThrow()
    // Prefix collision: /home/u/ws2 is NOT under /home/u/ws.
    expect(() => assertRemoteWritable('/home/u/ws2/a.ts', 'a.ts', policy('workspace-write')))
      .toThrowError(/workspace-write mode/)
    expect(() => assertRemoteWritable('/home/u/.bashrc', '.bashrc', policy('workspace-write')))
      .toThrowError(/workspace-write mode/)
  })

  it('delegates unfenced under danger-full-access and when no policy is supplied', () => {
    expect(() => assertRemoteWritable('/etc/passwd', 'passwd', policy('danger-full-access'))).not.toThrow()
    expect(() => assertRemoteWritable('/etc/passwd', 'passwd', undefined)).not.toThrow()
  })
})
