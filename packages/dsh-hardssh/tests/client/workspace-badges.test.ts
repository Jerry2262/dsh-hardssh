// @vitest-environment jsdom
/**
 * The shell-tooltip rewrite for SSH workspaces.
 *
 * DSH renders its own styled tooltip bubble for a sidebar row and prints the
 * workspace PATH there. For an SSH workspace that path is the LOCAL anchor
 * directory (`~/.dsh/ssh-workspaces/<id>`) — meaningless to the user, who asked
 * to see the remote directory instead. The plugin added a second tooltip via a
 * row `<title>` attribute, which produced two cards in a row: the shell's (local
 * anchor) and then the plugin's (remote). The fix is one implementation: keep
 * the shell bubble and rewrite its text, which is what `replaceAnchorPaths`
 * does (the DOM walk itself needs a browser and is exercised in the GUI).
 */
import { afterEach, describe, expect, it } from 'vitest'
import { replaceAnchorPaths } from '../../src/client/anchor-display.ts'
import {
  badgeBindings,
  mountWorkspaceBadges,
  type SshWorkspaceLike,
} from '../../src/client/workspace-badges.ts'

const ANCHOR = 'C:\\Users\\Kether\\.dsh\\ssh-workspaces\\7821e2ce'
const LABEL = '/yutiancheng/2026/regvelo（regvelo）'

function labels(): Map<string, string> {
  return new Map([
    [ANCHOR, LABEL],
    [ANCHOR.replace(/\\/g, '/'), LABEL],
  ])
}

describe('replaceAnchorPaths', () => {
  it('replaces the local anchor with the remote label', () => {
    expect(replaceAnchorPaths(ANCHOR, labels())).toBe(LABEL)
  })

  it('rewrites an anchor embedded in a longer tooltip line', () => {
    expect(replaceAnchorPaths(`打开 ${ANCHOR} 中的文件`, labels())).toBe(`打开 ${LABEL} 中的文件`)
  })

  it('matches case-insensitively and with forward slashes', () => {
    expect(replaceAnchorPaths(ANCHOR.toLowerCase(), labels())).toBe(LABEL)
    expect(replaceAnchorPaths(ANCHOR.replace(/\\/g, '/'), labels())).toBe(LABEL)
  })

  it('leaves unrelated text untouched', () => {
    const text = 'C:\\Users\\Kether\\.dsh\\ssh-workspaces\\other-id'
    expect(replaceAnchorPaths(text, labels())).toBe(text)
    expect(replaceAnchorPaths('普通文本', labels())).toBe('普通文本')
  })

  it('is idempotent and tolerates `$` in the label', () => {
    const map = new Map([['/tmp/anchor', 'cost $1 path']])
    const once = replaceAnchorPaths('/tmp/anchor', map)
    expect(once).toBe('cost $1 path')
    expect(replaceAnchorPaths(once, map)).toBe(once)
  })

  it('ignores an empty anchor entry', () => {
    const map = new Map([['', 'should-not-apply']])
    expect(replaceAnchorPaths('anything', map)).toBe('anything')
  })
})


/** One SSH-bound workspace fixture, local anchor path under the client home. */
const SSH_WORKSPACE: SshWorkspaceLike = {
  id: 'ssh-1',
  title: 'tmp',
  alias: 'aliyun',
  remoteRoot: '/srv/tmp',
  anchorPath: '/home/jerry/.dsh/ssh-workspaces/ssh-1',
}

describe('badgeBindings', () => {
  it('binds by canonical anchor path, so same-titled local workspaces stay unbound', () => {
    const bindings = badgeBindings([
      { workspaceId: 'local-tmp', path: '/home/jerry/tmp' },
      { workspaceId: 'chat-tmp', path: '/home/jerry/chat/tmp' },
      { workspaceId: 'ssh-tmp', path: '/home/jerry/.dsh/ssh-workspaces/ssh-1' },
    ], [SSH_WORKSPACE])
    expect(bindings.has('local-tmp')).toBe(false)
    expect(bindings.has('chat-tmp')).toBe(false)
    expect(bindings.get('ssh-tmp')).toEqual({ alias: 'aliyun', remoteRoot: '/srv/tmp' })
  })

  it('normalizes trailing separators and Windows spelling', () => {
    const windows: SshWorkspaceLike = {
      ...SSH_WORKSPACE,
      anchorPath: 'C:\\Users\\Kether\\.dsh\\ssh-workspaces\\ssh-1',
    }
    const bindings = badgeBindings([
      { workspaceId: 'ssh-tmp', path: 'c:/users/kether/.dsh/ssh-workspaces/ssh-1/' },
    ], [windows])
    expect(bindings.get('ssh-tmp')).toEqual({ alias: 'aliyun', remoteRoot: '/srv/tmp' })
  })

  it('never binds by title, even when the anchor is missing', () => {
    const bindings = badgeBindings([
      { workspaceId: 'local-tmp', path: '/home/jerry/tmp' },
    ], [{ ...SSH_WORKSPACE, anchorPath: undefined }])
    expect(bindings.size).toBe(0)
  })
})

describe('mountWorkspaceBadges', () => {
  afterEach(() => {
    document.body.innerHTML = ''
  })

  function row(key: string | undefined, title: string): HTMLElement {
    const element = document.createElement('div')
    element.className = 'Row_projectRow'
    if (key !== undefined) element.setAttribute('data-row-key', key)
    const titleEl = document.createElement('span')
    titleEl.className = 'Row_title'
    titleEl.textContent = title
    element.append(titleEl)
    return element
  }

  it('decorates only workspace rows bound to an SSH record', () => {
    const local = row('workspace:local-tmp', 'tmp')
    const remote = row('workspace:ssh-tmp', 'tmp')
    document.body.append(local, remote)

    const dispose = mountWorkspaceBadges(
      [SSH_WORKSPACE],
      new Map([['ssh-tmp', { alias: 'aliyun', remoteRoot: '/srv/tmp' }]]),
      new Set(['aliyun']),
    )

    expect(local.querySelector('[data-ssh-badge]')).toBeNull()
    const badge = remote.querySelector<HTMLElement>('[data-ssh-badge]')
    expect(badge?.textContent).toBe('aliyun')
    expect(badge?.title).toBe('/srv/tmp（aliyun）')

    dispose()
    expect(document.querySelector('[data-ssh-badge]')).toBeNull()
  })

  it('removes a stale badge when a row is no longer bound', () => {
    const local = row('workspace:local-tmp', 'tmp')
    document.body.append(local)
    const stale = document.createElement('span')
    stale.dataset.sshBadge = 'connected'
    stale.textContent = 'old'
    local.firstElementChild!.append(stale)

    const dispose = mountWorkspaceBadges([], new Map())
    expect(local.querySelector('[data-ssh-badge]')).toBeNull()
    dispose()
  })

  it('falls back to a UNIQUE title only for rows without a native workspace key', () => {
    const legacy = row(undefined, 'tmp')
    document.body.append(legacy)
    const dispose = mountWorkspaceBadges(
      [SSH_WORKSPACE],
      new Map(),
    )
    expect(legacy.querySelector('[data-ssh-badge]')?.textContent).toBe('aliyun')
    dispose()

    // Two SSH records sharing the title make the fallback ambiguous: no badge.
    document.body.innerHTML = ''
    const ambiguous = row(undefined, 'tmp')
    document.body.append(ambiguous)
    const disposeAmbiguous = mountWorkspaceBadges(
      [SSH_WORKSPACE, { ...SSH_WORKSPACE, id: 'ssh-2', anchorPath: '/home/jerry/.dsh/ssh-workspaces/ssh-2' }],
      new Map(),
    )
    expect(ambiguous.querySelector('[data-ssh-badge]')).toBeNull()
    disposeAmbiguous()
  })
})
