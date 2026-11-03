/**
 * Resolve the DeepSeek Harness user-data home the same way the kernel does:
 * `$DSH_HOME` (tilde-expanded, then made absolute) when set and non-blank,
 * else `~/.dsh`.
 *
 * User-data files this plugin persists (SSH host store, known hosts, vault,
 * workspace ledger, managed SSH anchors) must live under that shared root.
 * Resolving `~/.dsh` directly breaks isolated profiles: a process started
 * with a custom `DSH_HOME` still writes into the real home — where a sandboxed
 * trial process may have it mounted read-only, failing the write.
 *
 * @module dsh-hardssh/dsh-home
 */

import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

/** Expand the supported tilde prefixes (`~`, `~/`, `~\`) against the OS home. */
function expandTilde(path: string): string {
  if (path === '~') return homedir()
  if (path.startsWith('~/') || path.startsWith('~\\')) return join(homedir(), path.slice(2))
  return path
}

/**
 * Resolve the absolute harness home.
 * @param env - environment mapping to read `DSH_HOME` from (defaults to the process env).
 * @returns the normalized absolute home path.
 */
export function dshHome(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.DSH_HOME?.trim()
  return resolve(expandTilde(configured !== undefined && configured !== '' ? configured : join(homedir(), '.dsh')))
}

/**
 * Join segments onto the resolved harness home.
 * @param segments - path segments appended to the home; empty returns the home itself.
 * @returns the joined absolute path.
 */
export function dshHomePath(...segments: string[]): string {
  return join(dshHome(), ...segments)
}
