/**
 * SSH-bound workspace path helpers.
 *
 * Anchor/path helpers the generic runtime shares: the managed SSH anchor
 * layout (`~/.dsh/ssh-workspaces/<id>`), the client DTO title default, and the
 * lexical anchor-containment helpers used by fs/subprocess fail-closed gating.
 * Record persistence itself is owned by the generic `WorkspaceLedger`
 * (`./base/ledger.ts`).
 *
 * @module dsh-hardssh/ledger
 */

import { join, posix } from 'node:path'
import { dshHomePath } from './dsh-home.ts'

/**
 * Normalize a remote POSIX root: keep '/' as '/', collapse repeated
 * separators and dot segments, reject relative paths and NUL.
 */
export function normalizeRemoteRoot(raw: string): string {
  if (raw.includes('\0')) {
    throw new Error(`remoteRoot must not contain NUL (got '${raw}')`)
  }
  const normalized = posix.normalize(raw.trim())
  if (!normalized.startsWith('/')) {
    throw new Error(`remoteRoot must be an absolute POSIX path (got '${raw}')`)
  }
  return normalized === '/' ? '/' : normalized.replace(/\/+$/, '')
}

/** Anchor roots: `~/.dsh/workspace-anchors/<id>/` — visible in the sidebar as
 *  ordinary host workspaces (and thus selectable for sessions). The name is
 *  deliberately neutral: it is part of a session's cwd, so it must not say
 *  anything about how the files are reached. */
export function anchorRoot(): string {
  return dshHomePath('workspace-anchors')
}

/** Pre-rename anchor root (`~/.dsh/ssh-workspaces`). Existing workspaces keep
 *  their record's anchor path; this root stays recognised so those sessions
 *  still route and fail closed correctly. New workspaces never use it. */
export function legacyAnchorRoot(): string {
  return dshHomePath('ssh-workspaces')
}

/** Every anchor root the routing facades must treat as reserved. */
export function anchorRoots(): readonly string[] {
  return [anchorRoot(), legacyAnchorRoot()]
}

/** The anchor directory for one id. */
export function anchorPathFor(id: string): string {
  return join(anchorRoot(), id)
}

/** Default record title when the user gives none. */
export function defaultTitle(remoteRoot: string, alias: string): string {
  return `${alias}:${remoteRoot.split('/').filter(Boolean).pop() ?? remoteRoot}`
}

/**
 * Anchor-path comparison is owned by ONE implementation (`base/ledger.ts`):
 * two copies had already drifted in their Windows/UNC root handling, and the
 * seams, the store, and the client all compare anchors. Re-exported here so
 * existing `from './ledger.ts'` imports keep working.
 */
export { isPathUnderAnchor, normalizeAnchorPath } from './base/ledger.ts'
