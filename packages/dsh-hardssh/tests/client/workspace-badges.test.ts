// @vitest-environment jsdom
/**
 * Sidebar row decoration: binding, badge lifecycle and the mutation-loop
 * regression.
 *
 * The badge a row shows comes from the row's native workspace id
 * (`data-row-key="workspace:<id>"`) and the binding table. The pass never
 * guesses a row's identity from its title text: the badge is appended INSIDE
 * the title element, so title matching read its own output back, flipped
 * between "bound" and "unbound" on every pass, and add/removed the badge in a
 * microtask loop that froze the page while a workspace was being deleted.
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

  function mount(inputs: {
    workspaces?: readonly SshWorkspaceLike[]
    bindings?: ReadonlyMap<string, { alias: string; remoteRoot: string }>
    connected?: ReadonlySet<string>
    connecting?: ReadonlySet<string>
  } = {}) {
    return mountWorkspaceBadges(
      inputs.workspaces ?? [],
      inputs.bindings ?? new Map(),
      inputs.connected,
      inputs.connecting,
    )
  }

  it('decorates only workspace rows bound to an SSH record', () => {
    const local = row('workspace:local-tmp', 'tmp')
    const remote = row('workspace:ssh-tmp', 'tmp')
    document.body.append(local, remote)

    const handle = mount({
      workspaces: [SSH_WORKSPACE],
      bindings: new Map([['ssh-tmp', { alias: 'aliyun', remoteRoot: '/srv/tmp' }]]),
      connected: new Set(['aliyun']),
    })

    expect(local.querySelector('[data-ssh-badge]')).toBeNull()
    const badge = remote.querySelector<HTMLElement>('[data-ssh-badge]')
    expect(badge?.textContent).toBe('aliyun')
    expect(badge?.title).toBe('/srv/tmp（aliyun）')
    expect(badge?.dataset.sshBadge).toBe('connected')

    handle.dispose()
    expect(document.querySelector('[data-ssh-badge]')).toBeNull()
  })

  it('removes a stale badge when a keyed row is no longer bound', () => {
    const local = row('workspace:local-tmp', 'tmp')
    document.body.append(local)
    const stale = document.createElement('span')
    stale.dataset.sshBadge = 'connected'
    stale.textContent = 'old'
    local.firstElementChild!.append(stale)

    const handle = mount()
    expect(local.querySelector('[data-ssh-badge]')).toBeNull()
    handle.dispose()
  })

  it('never decorates a row without a native workspace key', () => {
    // The badge lives inside the title element, so matching by title text
    // would read the badge back as part of the title and flip forever.
    const legacy = row(undefined, 'tmp')
    document.body.append(legacy)

    const handle = mount({ workspaces: [SSH_WORKSPACE] })
    expect(legacy.querySelector('[data-ssh-badge]')).toBeNull()

    handle.update([SSH_WORKSPACE], new Map())
    expect(legacy.querySelector('[data-ssh-badge]')).toBeNull()
    handle.dispose()
  })

  it('is idempotent: an unchanged row produces no DOM write on a later pass', () => {
    const remote = row('workspace:ssh-tmp', 'tmp')
    document.body.append(remote)

    const handle = mount({
      workspaces: [SSH_WORKSPACE],
      bindings: new Map([['ssh-tmp', { alias: 'aliyun', remoteRoot: '/srv/tmp' }]]),
      connected: new Set(['aliyun']),
    })
    const badge = remote.querySelector<HTMLElement>('[data-ssh-badge]')
    expect(badge).not.toBeNull()

    const observer = new MutationObserver(() => {})
    observer.observe(remote, { childList: true, subtree: true, attributes: true })
    handle.update(
      [SSH_WORKSPACE],
      new Map([['ssh-tmp', { alias: 'aliyun', remoteRoot: '/srv/tmp' }]]),
      new Set(['aliyun']),
    )
    expect(observer.takeRecords()).toHaveLength(0)
    expect(remote.querySelectorAll('[data-ssh-badge]')).toHaveLength(1)
    expect(remote.querySelector('[data-ssh-badge]')).toBe(badge)

    observer.disconnect()
    handle.dispose()
  })

  it('re-renders the badge when the connection state changes', () => {
    const remote = row('workspace:ssh-tmp', 'tmp')
    document.body.append(remote)

    const handle = mount({
      workspaces: [SSH_WORKSPACE],
      bindings: new Map([['ssh-tmp', { alias: 'aliyun', remoteRoot: '/srv/tmp' }]]),
      connected: new Set(['aliyun']),
    })
    expect(remote.querySelector<HTMLElement>('[data-ssh-badge]')?.dataset.sshBadge).toBe('connected')

    handle.update(
      [SSH_WORKSPACE],
      new Map([['ssh-tmp', { alias: 'aliyun', remoteRoot: '/srv/tmp' }]]),
      new Set(),
      new Set(['aliyun']),
    )
    expect(remote.querySelector<HTMLElement>('[data-ssh-badge]')?.dataset.sshBadge).toBe('connecting')

    handle.update(
      [SSH_WORKSPACE],
      new Map([['ssh-tmp', { alias: 'aliyun', remoteRoot: '/srv/tmp' }]]),
      new Set(),
    )
    expect(remote.querySelector<HTMLElement>('[data-ssh-badge]')?.dataset.sshBadge).toBe('disconnected')
    handle.dispose()
  })
})
