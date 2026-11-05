/**
 * Sidebar workspace-row augmentation: labels every host workspace row that
 * binds to an SSH-bound workspace with a compact remote badge, so a glance
 * tells a local workspace from a remote one.
 *
 * Identity comes from the native workspace id the shell puts on the row
 * (`data-row-key="workspace:<id>"`): the badge a row gets is looked up in the
 * binding table computed by the host half. The pass never derives a row's
 * identity from text — in particular never from the title element the badge is
 * appended to. Titles are display-only natively and may repeat, and reading
 * the title back after appending the badge made the text match flip between
 * "bound" and "unbound" on every pass: the badge was removed and re-added in a
 * microtask loop that froze the page. Rows without a native workspace key are
 * therefore left alone.
 *
 * Badge content is static for a workspace's lifetime (alias + remote root);
 * only the connection state (connected / connecting / disconnected) changes,
 * and only a changed connection set triggers a re-render.
 *
 * A React re-render can displace the injected badge, so a MutationObserver
 * re-attaches it. Its passes are coalesced to one per animation frame and are
 * idempotent: an unchanged row produces no DOM write, so the observer cannot
 * feed itself.
 *
 * @module dsh-hardssh/client/workspace-badges
 */

import { anchorLabels, normalizeDisplayPath, replaceAnchorPaths } from './anchor-display.ts'

const PROJECT_ROW_SELECTOR = '[class*="projectRow"]'
const TITLE_SELECTOR = '[class*="title"]'
/** Native row attribute prefix carrying the workspace id. */
const WORKSPACE_KEY_PREFIX = 'workspace:'

/** The slice of one native client workspace row the badge binding needs. */
export interface NativeWorkspaceRowLike {
  workspaceId: string
  /** Canonical directory the native registry created the workspace for. */
  path: string
}

/** The slice of the native client workspace service (`ctx.get('workspaces')`). */
export interface NativeWorkspacesLike {
  list: {
    getSnapshot(): { items: readonly NativeWorkspaceRowLike[] }
    subscribe(listener: () => void): () => void
  }
}

/** One SSH workspace record, as the badge binder sees it. */
export interface SshWorkspaceLike {
  id: string
  title: string
  alias: string
  remoteRoot: string
  anchorPath?: string
}

/** The badge a bound native workspace row shows. */
export interface WorkspaceBadgeTarget {
  alias: string
  remoteRoot: string
}

/** The mounted row-decoration pass. */
export interface WorkspaceBadgesHandle {
  /**
   * Replace the records, bindings and connection state, then re-apply.
   * @param workspaces - SSH-bound workspaces (anchor labels for tooltips).
   * @param bindings - native workspace id → badge.
   * @param connected - aliases with a live pooled connection.
   * @param connecting - aliases currently probing/connecting.
   */
  update(
    workspaces: ReadonlyArray<SshWorkspaceLike>,
    bindings: ReadonlyMap<string, WorkspaceBadgeTarget>,
    connected?: ReadonlySet<string>,
    connecting?: ReadonlySet<string>,
  ): void
  /** Stop observing and strip every badge this pass injected. */
  dispose(): void
}

/** One pass's inputs. */
interface DecorationState {
  bindings: ReadonlyMap<string, WorkspaceBadgeTarget>
  labels: ReadonlyMap<string, string>
  connected: ReadonlySet<string> | undefined
  connecting: ReadonlySet<string> | undefined
}

/**
 * Bind native workspace ids to the SSH records that own them.
 *
 * Native identity is the canonical workspace PATH (the registry's uniqueness
 * key), so the anchor path is the join: the native workspace whose `path` is
 * the record's anchor directory gets the badge. Titles never take part — two
 * workspaces may legitimately share one.
 *
 * @param nativeWorkspaces - native client workspace rows (`items`).
 * @param sshWorkspaces - SSH-bound workspace records.
 * @returns native workspace id → the badge to render for that row.
 */
export function badgeBindings(
  nativeWorkspaces: readonly NativeWorkspaceRowLike[],
  sshWorkspaces: readonly SshWorkspaceLike[],
): Map<string, WorkspaceBadgeTarget> {
  const byAnchor = new Map<string, SshWorkspaceLike>()
  for (const workspace of sshWorkspaces) {
    if (workspace.anchorPath === undefined || workspace.anchorPath === '') continue
    byAnchor.set(normalizeDisplayPath(workspace.anchorPath), workspace)
  }
  const bindings = new Map<string, WorkspaceBadgeTarget>()
  for (const row of nativeWorkspaces) {
    const ssh = byAnchor.get(normalizeDisplayPath(row.path))
    if (ssh !== undefined) bindings.set(row.workspaceId, { alias: ssh.alias, remoteRoot: ssh.remoteRoot })
  }
  return bindings
}

/** Render a small remote badge element. The cloud icon marks "remote";
 *  connected servers render in DeepSeek blue, disconnected stay gray; a
 *  connecting server rotates a small spinner instead. The tooltip shows the
 *  REMOTE directory plus the server, e.g. `/data/app (prod-01)`. */
export function makeBadge(
  alias: string,
  remoteRoot: string,
  state: 'connected' | 'disconnected' | 'connecting',
): HTMLElement {
  const badge = document.createElement('span')
  badge.dataset.sshBadge = state
  badge.title = `${remoteRoot}（${alias}）`
  badge.setAttribute(
    'style',
    state === 'connected'
      ? 'display:inline-flex;align-items:center;gap:3px;margin-left:6px;max-width:120px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:11px;line-height:16px;color:#1476E6;border:1px solid #1476E6;border-radius:999px;padding:0 6px;background:#D4E0F7;flex:none'
      : 'display:inline-flex;align-items:center;gap:3px;margin-left:6px;max-width:120px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary,rgba(128,128,128,.75));border:1px solid var(--dsw-alias-line-secondary,rgba(128,128,128,.28));border-radius:999px;padding:0 6px;background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.10));flex:none',
  )
  const icon = document.createElement('span')
  icon.setAttribute('style', 'display:inline-flex;flex:none;line-height:1')
  if (state === 'connecting') {
    // CSS border spinner that rotates until the connect probe settles.
    icon.innerHTML =
      '<svg viewBox="0 0 24 24" width="11" height="11" fill="none" aria-hidden="true" style="animation:dsh-hardssh-spin 0.9s linear infinite">'
      + '<circle cx="12" cy="12" r="9" stroke="currentColor" stroke-opacity="0.25" stroke-width="3"></circle>'
      + '<path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" stroke-width="3" stroke-linecap="round"></path>'
      + '</svg>'
  } else {
    icon.innerHTML = '<svg viewBox="0 0 1024 1024" width="11" height="11" fill="currentColor" aria-hidden="true"><path d="M743.936 758.499556h-273.066667c-17.066667 0-34.133333-17.066667-34.133333-34.133334s17.066667-34.133333 34.133333-34.133333h273.066667c28.444444 0 153.6-5.688889 153.6-130.844445 0-142.222222-153.6-164.977778-159.288889-164.977777-17.066667 0-28.444444-11.377778-28.444444-22.755556-22.755556-85.333333-108.088889-142.222222-193.422223-130.844444-136.533333 0-176.355556 79.644444-199.111111 164.977777-5.688889 5.688889-22.755556 17.066667-39.822222 17.066667 0 0-153.6 5.688889-153.6 142.222222 0 119.466667 130.844444 125.155556 153.6 125.155556 17.066667 0 34.133333 17.066667 34.133333 34.133333s-17.066667 34.133333-34.133333 34.133334c-113.777778 0-227.555556-62.577778-227.555555-193.422223 0-142.222222 119.466667-204.8 199.111111-210.488889 22.755556-68.266667 79.644444-193.422222 261.688889-193.422222 113.777778-11.377778 216.177778 56.888889 256 164.977778 79.644444 17.066667 199.111111 79.644444 199.111111 233.244444 5.688889 136.533333-108.088889 199.111111-221.866667 199.111112z"/><path d="M573.269333 866.588444c-11.377778 0-17.066667-5.688889-22.755555-11.377777l-108.088889-108.088889c-5.688889-5.688889-11.377778-17.066667-11.377778-22.755556s5.688889-17.066667 11.377778-22.755555l108.088889-108.088889c11.377778-11.377778 34.133333-11.377778 51.2 0 11.377778 11.377778 11.377778 34.133333 0 51.2l-79.644445 79.644444 79.644445 79.644445c11.377778 11.377778 11.377778 34.133333 0 51.2-5.688889 5.688889-17.066667 11.377778-28.444445 11.377777z"/></svg>'
  }
  const label = document.createElement('span')
  label.textContent = alias
  label.setAttribute('style', 'font-weight:400')
  badge.append(icon, label)
  return badge
}

/** Inject the spinner keyframe once per document (idempotent). */
function ensureSpinnerStyle(): void {
  if (document.getElementById('dsh-hardssh-spinner-style') !== null) return
  const style = document.createElement('style')
  style.id = 'dsh-hardssh-spinner-style'
  style.textContent = '@keyframes dsh-hardssh-spin { to { transform: rotate(360deg); } }'
  document.head.append(style)
}

/**
 * Mount the row-decoration pass.
 *
 * One observer lives for the whole mount; inputs arrive through
 * {@link WorkspaceBadgesHandle.update} whenever the SSH record set, the native
 * binding or the connection state really changes — not on every DOM mutation.
 *
 * @param workspaces - the SSH workspace records (anchor/title/alias/remoteRoot).
 * @param bindings - native workspace id → badge, from {@link badgeBindings}.
 * @param connected - aliases with a live pooled connection (badge coloring).
 * @param connecting - aliases currently probing/connecting (spinner badge).
 * @returns the mounted pass.
 */
export function mountWorkspaceBadges(
  workspaces: ReadonlyArray<SshWorkspaceLike>,
  bindings: ReadonlyMap<string, WorkspaceBadgeTarget>,
  connected?: ReadonlySet<string>,
  connecting?: ReadonlySet<string>,
): WorkspaceBadgesHandle {
  ensureSpinnerStyle()
  let state: DecorationState = {
    bindings,
    labels: anchorLabels(workspaces),
    connected,
    connecting,
  }
  let disposed = false
  let scheduled = false

  /** Resolve the badge a row shows from its native workspace id alone. */
  const targetForRow = (row: HTMLElement): WorkspaceBadgeTarget | undefined => {
    const key = row.getAttribute('data-row-key')
    if (key === null || !key.startsWith(WORKSPACE_KEY_PREFIX)) return undefined
    const workspaceId = key.slice(WORKSPACE_KEY_PREFIX.length)
    return workspaceId === '' ? undefined : state.bindings.get(workspaceId)
  }

  /** Decorate one project row: mount/replace the badge with the row's live
   *  connection state (connected / connecting / disconnected).
   *
   *  The row tooltip is NOT ours to own: the shell renders its own styled
   *  bubble showing the workspace PATH — the local anchor for an SSH
   *  workspace — and an extra `<title>` here produced a SECOND tooltip. The
   *  shell's bubble text is rewritten by `patchTooltips()`, so there is exactly
   *  one tooltip and it shows the remote directory. A stale `<title>` left by
   *  an older build of this plugin is cleared here. */
  const decorate = (row: HTMLElement): void => {
    const target = targetForRow(row)
    const existing = row.querySelector<HTMLElement>('[data-ssh-badge]')
    if (target === undefined) {
      // A row without a readable native workspace id cannot be matched safely;
      // guessing by title is what made the badge add/remove itself in a loop.
      if (existing !== null) existing.remove()
      return
    }
    const titleEl = row.querySelector<HTMLElement>(TITLE_SELECTOR)
    if (titleEl === null || titleEl === undefined) return
    // Heal a title this plugin used to set, and drop a shell-provided <title>
    // whose text is the local anchor (that would be a native duplicate of the
    // bubble `patchTooltips` already fixes).
    if (row.title !== '') row.removeAttribute('title')
    const stale = titleEl.getAttribute('title')
    if (stale !== null && replaceAnchorPaths(stale, state.labels) !== stale) titleEl.removeAttribute('title')
    const badgeState = state.connecting?.has(target.alias) === true
      ? 'connecting'
      : state.connected?.has(target.alias) === true ? 'connected' : 'disconnected'
    const expectedTitle = `${target.remoteRoot}（${target.alias}）`
    if (existing !== null) {
      // Update in place so a connect-state flip (spinner ⇄ cloud) is visible
      // without remounting the row; replace when the bound target changed.
      if (
        existing.dataset.sshBadge !== badgeState
        || existing.title !== expectedTitle
        || existing.textContent !== target.alias
      ) {
        existing.replaceWith(makeBadge(target.alias, target.remoteRoot, badgeState))
      }
      return
    }
    titleEl.appendChild(makeBadge(target.alias, target.remoteRoot, badgeState))
  }

  /** Rewrite the shell's hover card: its `hoverPath` row prints the workspace
   *  PATH — the local anchor for an SSH workspace — which is meaningless to the
   *  user; show the remote directory instead.
   *
   *  dsh 0.2.1 renders this card as `WorkspaceHoverContent` with hashed classes
   *  (`…_hoverPath`, `…_hoverContent`), NOT a `role="tooltip"` bubble, so both
   *  shapes are matched. Runs on every pass (the card mounts on hover) and is
   *  idempotent: once the text no longer contains an anchor nothing changes. */
  const patchTooltips = (): void => {
    if (state.labels.size === 0) return
    const tips = document.querySelectorAll<HTMLElement>(
      '[class*="hoverPath"], [class*="hoverContent"], [role="tooltip"], [class*="tooltip"], [class*="Tooltip"]',
    )
    for (const tip of tips) {
      if (tip.closest('[data-ssh-workspace-flow-menu]') !== null) continue
      const walker = document.createTreeWalker(tip, NodeFilter.SHOW_TEXT)
      for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
        const value = node.nodeValue ?? ''
        const replaced = replaceAnchorPaths(value, state.labels)
        if (replaced !== value) node.nodeValue = replaced
      }
    }
  }

  /** Scan the sidebar column for project rows and decorate each. */
  const scan = (): void => {
    for (const row of document.querySelectorAll<HTMLElement>(PROJECT_ROW_SELECTOR)) decorate(row)
  }

  /** One complete pass; idempotent, so an unchanged row writes nothing. */
  const run = (): void => {
    scheduled = false
    if (disposed) return
    scan()
    patchTooltips()
  }

  /** Coalesce observer notifications into at most one pass per frame. */
  const schedule = (): void => {
    if (scheduled || disposed) return
    scheduled = true
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(run)
    else setTimeout(run, 0)
  }

  // Watch the document for the sidebar column arriving / re-rendering and for
  // the shell's tooltip bubble mounting on hover.
  const observer = new MutationObserver(() => { schedule() })
  observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['title'] })
  run()

  return {
    update(nextWorkspaces, nextBindings, nextConnected, nextConnecting) {
      state = {
        bindings: nextBindings,
        labels: anchorLabels(nextWorkspaces),
        connected: nextConnected,
        connecting: nextConnecting,
      }
      run()
    },
    dispose() {
      disposed = true
      observer.disconnect()
      // Remove injected badges.
      for (const badge of document.querySelectorAll<HTMLElement>('[data-ssh-badge]')) badge.remove()
    },
  }
}
