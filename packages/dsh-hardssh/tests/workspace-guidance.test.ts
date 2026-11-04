/**
 * The agent-facing workspace announcement must describe the SEAMS, not a
 * removed guard: reading/writing/globbing routes through the switching
 * filesystem and client-native binaries spawn through the switching
 * subprocess runtime. The previous text claimed glob/grep/pwsh were "blocked",
 * which made the agent avoid working tools and misjudge pwsh (P0-3).
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
  it('never claims glob/grep search the remote workspace', () => {
    const text = remoteGuidance(record)
    for (const stale of ['不可用', '已被自动拦截', '自动拦截', 'glob / grep 走已路由的文件系统', '会被明确拒绝']) {
      expect(text).not.toContain(stale)
    }
  })

  it('states the real glob/grep behaviour and the local nature of pwsh', () => {
    const text = remoteGuidance(record)
    // glob/grep are served from the bound host by the workspace-search bridge,
    // and remote_search stays the tool for regex / explicit budgets.
    expect(text).toContain('直接查远端')
    expect(text).toContain('remote_search')
    expect(text).toContain('pwsh / powershell / cmd 是客户端原生二进制，在本机执行')
    // bash is remote too; without this statement a model calls the remote
    // result "本机" and cannot tell the two worlds apart in its answer.
    expect(text).toContain('bash 工具同样在远端执行')
    expect(text).toContain('不需要改用 ssh_exec')
    // The binding facts stay accurate.
    expect(text).toContain('prod')
    expect(text).toContain('/srv/app')
    // The alias is the argument every ssh_* tool takes; the title is only a
    // display name, so the guidance must say so explicitly (P0: a model used
    // the workspace title as the ssh_exec alias).
    expect(text).toContain('主机别名是 `prod`')
    expect(text).toContain('alias 参数用 `prod`')
  })

  it('keeps the local-session branch describing full local tool availability', () => {
    const text = localGuidance()
    expect(text).toContain('当前会话是本机工作区')
    expect(text).toContain('bash')
    expect(text).toContain('文件操作与 bash 命令都在本机执行')
    expect(text).not.toContain('不可用')
  })
})
