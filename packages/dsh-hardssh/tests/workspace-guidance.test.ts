/**
 * The agent-facing workspace announcement describes the routed native tools
 * only. The SSH-operations capability (ssh_* / remote_* tools, multi-host
 * awareness) was removed, so the text must not advertise any of it.
 */
import { describe, expect, it } from 'vitest'
import { localGuidance, remoteGuidance } from '../src/index.ts'
import type { SshWorkspaceRecord } from '../src/protocol.ts'

const record: SshWorkspaceRecord = {
  id: 'ws-1',
  title: 'proj',
  alias: 'prod',
  remoteRoot: '/srv/app',
  anchorPath: '/home/me/.dsh/ssh-workspaces/ws-1',
  createdAt: '2026-01-01T00:00:00.000Z',
}

describe('workspace guidance', () => {
  it('names the routed native tools and drops the removed remote_* shims', () => {
    const text = remoteGuidance(record)
    for (const tool of ['read', 'write', 'edit', 'bash', 'glob', 'grep']) {
      expect(text).toContain(tool)
    }
    for (const removed of ['remote_search', 'remote_ls', 'remote_status', 'ssh_exec', 'ssh_cluster', 'ssh_tunnel', 'ssh_upload', 'ssh_download']) {
      expect(text).not.toContain(removed)
    }
  })

  it('states that bash runs remotely and names the single bound host', () => {
    const text = remoteGuidance(record)
    expect(text).toContain('bash 命令在远端执行')
    expect(text).toContain('prod')
    expect(text).toContain('/srv/app')
    expect(text).toContain('超出工作区根的路径会被拒绝')
  })

  it('keeps the local-session branch local and free of SSH operations', () => {
    const text = localGuidance()
    expect(text).toContain('当前会话是本机工作区')
    expect(text).toContain('文件操作与 bash 命令都在本机执行')
    for (const removed of ['remote_search', 'remote_ls', 'remote_status', 'ssh_exec', 'ssh_cluster']) {
      expect(text).not.toContain(removed)
    }
  })
})
