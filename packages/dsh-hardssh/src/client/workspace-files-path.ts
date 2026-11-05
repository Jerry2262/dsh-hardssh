/**
 * Sidebar "工作区文件" (native file panel) address rewrite: the panel anchors
 * its displayed root at the session's header cwd, which for an SSH-bound
 * workspace is the LOCAL anchor directory — so the panel breadcrumb/title shows
 * `~/.dsh/workspace-anchors/<id>/…` instead of the real remote directory.
 *
 * The panel's CONTENT is already remote (the fs seam resolves anchor→remote);
 * only the displayed address is wrong. This is a pure-DOM augmentation eating
 * the same self-healing style as `workspace-badges.ts`: it rewrites the anchor
 * prefix in the panel header (`.path` element title + visible breadcrumb text)
 * into the workspace's `remoteRoot`, and re-applies when React re-renders the
 * panel back to the anchor string.
 *
 * Inputs are pushed in through {@link WorkspaceFilesPathHandle.update}; the
 * observer only re-applies them. Its passes are coalesced to one per animation
 * frame and are idempotent (a rewritten header no longer matches the anchor),
 * so the observer cannot feed itself.
 *
 * Follow-up opens are NOT affected: they route through the session resource
 * (the anchor), which the seam resolves remote — addresses keep working.
 *
 * @module dsh-hardssh/client/workspace-files-path
 */

import { normalizeDisplayPath, remapAnchorToRemote } from './anchor-display.ts'

/** Native panel root marker (rendered as `data-files-root={root}` by
 *  `dsh-client-ui-sidebar-files`, verified in the 0.1.5-rc.1 bundle). */
const PANEL_SELECTOR = '[data-files-root]'
/** The header element whose `title` carries the panel root. */
const ROOT_TITLE_SELECTOR = '[title]'

/** One SSH workspace record as the address rewrite sees it. */
export interface FilesPathWorkspace {
  anchorPath: string
  remoteRoot: string
}

/** The mounted address-rewrite pass. */
export interface WorkspaceFilesPathHandle {
  /**
   * Replace the workspace records and re-apply.
   * @param workspaces - SSH workspace records carrying anchor and remote root.
   */
  update(workspaces: ReadonlyArray<FilesPathWorkspace>): void
  /** Stop observing; already-rewritten headers stay as they are. */
  dispose(): void
}

/**
 * Mount the address-rewrite pass. Scans the document for native file panels
 * whose root belongs to an SSH-bound workspace and rewrites the header path
 * (breadcrumb text + `title` tooltip) to the remote address.
 *
 * @param workspaces - SSH workspace records carrying their anchor path and
 *   remote root.
 * @returns the mounted pass.
 */
export function mountWorkspaceFilesPathRemap(
  workspaces: ReadonlyArray<FilesPathWorkspace>,
): WorkspaceFilesPathHandle {
  let byRoot = indexByRoot(workspaces)
  let disposed = false
  let scheduled = false

  /** Rewrite one panel's root header into the remote form, if it is ours. */
  const decorate = (panel: Element): void => {
    const root = panel.getAttribute('data-files-root') ?? ''
    const owner = byRoot.get(normalizeDisplayPath(root))
    if (owner === undefined) return
    // The header `.path` element is the one whose `title` equals the root.
    const pathEl = [...panel.querySelectorAll<HTMLElement>(ROOT_TITLE_SELECTOR)]
      .find(element => normalizeDisplayPath(element.getAttribute('title') ?? '') === normalizeDisplayPath(root))
    if (pathEl === undefined) return
    const base = remapAnchorToRemote(root, owner.remoteRoot, root)
    if (pathEl.title !== base) pathEl.title = base
    const text = pathEl.textContent ?? ''
    const nextText = remapAnchorToRemote(root, owner.remoteRoot, text)
    if (nextText !== text) pathEl.textContent = nextText
  }

  const scan = (): void => {
    for (const panel of document.querySelectorAll(PANEL_SELECTOR)) decorate(panel)
  }

  /** One complete pass; idempotent, so an unchanged panel writes nothing. */
  const run = (): void => {
    scheduled = false
    if (disposed) return
    scan()
  }

  /** Coalesce observer notifications into at most one pass per frame. */
  const schedule = (): void => {
    if (scheduled || disposed) return
    scheduled = true
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(run)
    else setTimeout(run, 0)
  }

  const observer = new MutationObserver(() => { schedule() })
  observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['title'] })
  run()

  return {
    update(nextWorkspaces) {
      byRoot = indexByRoot(nextWorkspaces)
      run()
    },
    dispose() {
      disposed = true
      observer.disconnect()
    },
  }
}

/** Index the records by their normalized anchor root. */
function indexByRoot(workspaces: ReadonlyArray<FilesPathWorkspace>): Map<string, FilesPathWorkspace> {
  const byRoot = new Map<string, FilesPathWorkspace>()
  for (const workspace of workspaces) byRoot.set(normalizeDisplayPath(workspace.anchorPath), workspace)
  return byRoot
}
