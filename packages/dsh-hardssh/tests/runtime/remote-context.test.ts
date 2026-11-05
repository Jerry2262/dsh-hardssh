import { describe, expect, it } from 'vitest'
import {
  bindingsForCwd,
  remoteBindings,
  remoteExecutionNotice,
  rewriteGenerateOptions,
  rewriteValue,
  translateAnchorText,
  translateString,
  type RemoteBinding,
} from '../../src/runtime/remote-context.ts'
import type { WorkspaceCore } from '../../src/runtime/workspace-core.ts'

const binding: RemoteBinding = {
  anchorPath: '/home/me/.dsh/workspace-anchors/ws-1',
  remoteRoot: '/srv/app',
}

describe('remote wire path translation', () => {
  it('rewrites the anchor and every path beneath it to the remote root', () => {
    expect(translateAnchorText(
      `Current working directory: "${binding.anchorPath}".\nWorkspace: "${binding.anchorPath}/src".`,
      binding,
    )).toBe(`Current working directory: "/srv/app".\nWorkspace: "/srv/app/src".`)
  })

  it('rewrites the JSON-escaped Windows spelling as well', () => {
    const windows: RemoteBinding = {
      anchorPath: 'C:\\Users\\me\\.dsh\\workspace-anchors\\ws-1',
      remoteRoot: '/srv/app',
    }
    expect(translateAnchorText(`workspace: ${JSON.stringify(windows.anchorPath)}`, windows))
      .toBe(`workspace: ${JSON.stringify(windows.remoteRoot)}`)
  })

  it('applies every binding and leaves unrelated text alone', () => {
    const other: RemoteBinding = { anchorPath: '/home/me/.dsh/workspace-anchors/ws-2', remoteRoot: '/srv/other' }
    expect(translateString(`a=${binding.anchorPath} b=${other.anchorPath} c=/tmp/x`, [binding, other]))
      .toBe('a=/srv/app b=/srv/other c=/tmp/x')
    expect(translateString('nothing here', [])).toBe('nothing here')
  })

  it('rewrites nested request blocks and leaves class instances untouched', () => {
    const bytes = new Uint8Array([1, 2, 3])
    const value = {
      content: [
        { type: 'text', text: `see ${binding.anchorPath}/a.txt` },
        { type: 'tool-call', arguments: `{"cwd":"${binding.anchorPath}"}` },
        { type: 'image', attachment: { bytes } },
      ],
    }
    const rewritten = rewriteValue(value, [binding]) as typeof value
    expect(rewritten.content[0]?.text).toBe('see /srv/app/a.txt')
    expect(rewritten.content[1]?.arguments).toBe('{"cwd":"/srv/app"}')
    expect(rewritten.content[2]?.attachment.bytes).toBe(bytes)
    // The frozen input is never assigned into.
    expect(value.content[0]?.text).toBe(`see ${binding.anchorPath}/a.txt`)
  })

  it('leaves an unchanged request untouched (copy-on-write)', () => {
    const options = { messages: [{ role: 'user', content: [{ type: 'text', text: 'plain' }] }] }
    expect(rewriteGenerateOptions(options, [binding])).toBe(options)
    expect(rewriteValue(options.messages, [binding])).toBe(options.messages)
  })

  it('is a no-op without bindings', () => {
    const options = { system: `workspace: ${binding.anchorPath}`, messages: [] as unknown[] }
    expect(rewriteGenerateOptions(options, [])).toBe(options)
  })

  it('clones frozen options with translated messages instead of mutating them', () => {
    const frozenMessage = Object.freeze({
      role: 'user',
      content: Object.freeze([Object.freeze({ type: 'text', text: binding.anchorPath })]),
    })
    const options = Object.freeze({
      provider: 'deepseek',
      model: 'm',
      messages: Object.freeze([frozenMessage]),
      someSignal: undefined,
    })
    const rewritten = rewriteGenerateOptions(options, [binding]) as typeof options
    expect(rewritten).not.toBe(options)
    expect(rewritten.messages[0]).toEqual({
      role: 'user',
      content: [{ type: 'text', text: '/srv/app' }],
    })
    expect(options.messages[0]?.content[0]?.text).toBe(binding.anchorPath)
    // No binding → the exact original object is passed through.
    expect(rewriteGenerateOptions(options, [])).toBe(options)
  })

  it('selects the binding that owns a session cwd, and nothing otherwise', () => {
    const other: RemoteBinding = { anchorPath: '/home/me/.dsh/workspace-anchors/ws-2', remoteRoot: '/srv/other' }
    expect(bindingsForCwd([binding, other], binding.anchorPath)).toEqual([binding])
    expect(bindingsForCwd([binding, other], binding.anchorPath + '/src')).toEqual([binding])
    expect(bindingsForCwd([binding, other], other.anchorPath)).toEqual([other])
    expect(bindingsForCwd([binding], '/home/me/local')).toEqual([])
    expect(bindingsForCwd([binding], undefined)).toEqual([])
  })

  it('states the remote execution fact once, without connection configuration', () => {
    const notice = remoteExecutionNotice()
    expect(notice).toContain('远端执行环境')
    expect(notice).toContain('DSH 本体')
    expect(notice).not.toMatch(/ssh|ssh_|alias|密码|端口/i)
  })

  it('collects SSH bindings from the ledger snapshot only', () => {
    const core = {
      ledger: {
        snapshotSync: () => ({
          records: [
            { provider: { id: 'ssh' }, anchor: { path: '/a/ws-1' }, location: { root: '/srv/app' } },
            { provider: { id: 'local' }, anchor: { path: '/a/local' }, location: { root: '/a/local' } },
            { provider: { id: 'ssh' }, anchor: undefined, location: { root: '/srv/x' } },
            { provider: { id: 'ssh' }, anchor: { path: '/a/same' }, location: { root: '/a/same' } },
          ],
        }),
      },
    } as unknown as WorkspaceCore
    expect(remoteBindings(core)).toEqual([{ anchorPath: '/a/ws-1', remoteRoot: '/srv/app' }])
  })
})
