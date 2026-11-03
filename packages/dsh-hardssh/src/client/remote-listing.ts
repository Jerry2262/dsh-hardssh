/**
 * Adapt the plugin's remote-directory payload to the `DirectoryListing` shape
 * the kernel's browse dialog consumes.
 *
 * The kernel browse occupant is registered in the slot ledger and can be
 * rendered by reference (see `directory-flow.tsx`); giving it these wrappers
 * lets the SSH workspace picker reuse that dialog verbatim — same modal,
 * breadcrumbs, path editor, hidden-file toggle, and "New folder" — while the
 * rows come from the SSH SFTP API instead of the local filesystem.
 *
 * @module dsh-hardssh/client/remote-listing
 */

/** One picker row: a directory child or a breadcrumb ancestor. */
export interface PickerDirectoryEntry {
  /** Base name shown in a row. */
  name: string
  /** Absolute POSIX remote path. */
  path: string
  /** Dot-prefixed: hidden until the dialog's toggle asks for it. */
  hidden: boolean
}

/** One remote level plus its ancestry, in the kernel dialog's contract shape. */
export interface PickerDirectoryListing {
  /** Absolute path of the listed directory. */
  path: string
  /** The remote account's home directory (labels the breadcrumb root). */
  home: string
  /** Ancestor chain from the POSIX root to the listed directory, inclusive. */
  crumbs: PickerDirectoryEntry[]
  /** Direct child directories, name-sorted by the host. */
  entries: PickerDirectoryEntry[]
  /** The backend never truncates; kept for contract completeness. */
  truncated: boolean
}

/** Join one POSIX child name onto an absolute directory path. */
export function joinRemotePath(parent: string, name: string): string {
  return `${parent.endsWith('/') ? parent : `${parent}/`}${name}`
}

/**
 * Ancestor chain from the POSIX root to `path`, inclusive.
 * @param path - absolute remote path.
 * @returns one crumb per path segment (`/` itself for the root).
 */
export function remoteCrumbs(path: string): PickerDirectoryEntry[] {
  const normalized = path === '' ? '/' : path
  const crumbs: PickerDirectoryEntry[] = [{ name: '/', path: '/', hidden: false }]
  if (normalized === '/') return crumbs
  let current = ''
  for (const segment of normalized.replace(/^\/+/, '').split('/')) {
    if (segment === '') continue
    current = `${current}/${segment}`
    crumbs.push({ name: segment, path: current, hidden: false })
  }
  return crumbs
}

/**
 * Map one host listing to the kernel browse dialog's listing shape.
 * @param listing - the SSH API's remote directory payload.
 * @param home - the remote home directory captured on the first listing.
 * @returns rows for the dialog: directories only, dot names flagged hidden.
 */
export function toPickerListing(
  listing: { path: string; entries: ReadonlyArray<{ name: string; type: 'dir' | 'file' | 'other' }> },
  home: string,
): PickerDirectoryListing {
  const path = listing.path === '' ? '/' : listing.path
  return {
    path,
    home,
    crumbs: remoteCrumbs(path),
    entries: listing.entries
      .filter((entry) => entry.type === 'dir')
      .map((entry) => ({
        name: entry.name,
        path: joinRemotePath(path, entry.name),
        hidden: entry.name.startsWith('.'),
      })),
    truncated: false,
  }
}

/**
 * Workspace title for a picked remote root: its basename, like a local
 * workspace, falling back to the host alias when the root itself is picked.
 * @param remoteRoot - picked absolute remote path.
 * @param alias - the SSH host alias.
 * @returns the title proposed to the workspace store.
 */
export function remoteWorkspaceTitle(remoteRoot: string, alias: string): string {
  const parts = remoteRoot.replace(/\/+$/, '').split('/').filter((part) => part !== '')
  return parts.length === 0 ? (alias === '' ? remoteRoot : alias) : parts[parts.length - 1]
}
