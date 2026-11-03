/**
 * Generic workspace ledger recovery for the boot gate.
 *
 * `WorkspaceLedger` treats a missing file as an empty workspace set and throws
 * on an unparseable one. Silently reading a lost/corrupt ledger as "no
 * workspaces" is data loss, so the boot classifies the file first and rebuilds
 * it from the rolling `.last-good` snapshot or the newest `.backup-*` before
 * initializing the core.
 *
 * This is recovery for the CURRENT ledger format only. Older plugin versions
 * stored SSH workspaces in a separate legacy ledger; that import path has been
 * removed with the rest of the old-version compatibility code.
 *
 * @module dsh-hardssh/runtime/workspace-recovery
 */

import { randomUUID } from 'node:crypto'
import { mkdir, readFile, readdir, rename, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { assertValidRecords } from '../base/ledger.ts'
import type { WorkspaceRecord } from '../base/model.ts'

/** Error.message cannot reliably identify ENOENT, so reads inspect Node's machine-readable code. */
function isNodeErrorCode(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && (error as { code?: unknown }).code === code
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch (error) {
    if (isNodeErrorCode(error, 'ENOENT')) return false
    throw error
  }
}

/** Where a recovered ledger came from. */
export type GenericLedgerRecoverySource = 'last-good' | 'backup'

/** Outcome of one recovery attempt. */
export interface GenericLedgerRecoveryResult {
  recovered: boolean
  source?: GenericLedgerRecoverySource
  /** The file the records were restored from. */
  path?: string
  /** How many records the restored ledger holds. */
  recordCount?: number
  /** Why recovery failed, when it did. */
  reason?: string
}

/** Options for {@link recoverGenericLedger}. */
export interface GenericLedgerRecoveryOptions {
  /** The missing/unreadable generic ledger target. */
  genericPath: string
  /**
   * Record ids that are known to have existed. A candidate that cannot produce
   * ALL of them is rejected: recovery must never silently restore a SMALLER
   * workspace set than expected. An empty/absent list disables the id check.
   */
  expectedIds?: readonly string[]
  /** Sink for recovery diagnostics (defaults to console.warn). */
  log?: (message: string) => void
}

/** Whether a candidate record set satisfies the expected identities. */
function candidateProblem(records: readonly WorkspaceRecord[], expectedIds?: readonly string[]): string | undefined {
  if (records.length === 0) return 'it holds no records'
  if (expectedIds === undefined || expectedIds.length === 0) return undefined
  const present = new Set(records.map(record => record.id))
  const missing = expectedIds.filter(id => !present.has(id))
  if (missing.length > 0) {
    return `it is missing ${missing.length} of the ${expectedIds.length} expected workspace id(s) (${missing.slice(0, 3).join(', ')}${missing.length > 3 ? ', …' : ''})`
  }
  return undefined
}

/** Read and validate a ledger file; returns undefined when absent/unreadable. */
async function readLedgerRecords(path: string): Promise<WorkspaceRecord[] | undefined> {
  try {
    const parsed = JSON.parse(await readFile(path, 'utf8')) as unknown
    if (!Array.isArray(parsed)) return undefined
    assertValidRecords(parsed)
    return parsed.map(record => structuredClone(record))
  } catch {
    return undefined
  }
}

/**
 * Classify the generic ledger file so the boot can tell "legitimately empty"
 * (the user deleted every workspace, the file exists with `[]`) from "lost or
 * damaged" (missing, truncated, or unparseable).
 *
 * @param path - the generic ledger path.
 * @returns the ledger state, never throwing.
 */
export async function inspectGenericLedger(path: string): Promise<'absent' | 'readable' | 'corrupt'> {
  if (!(await fileExists(path))) return 'absent'
  return (await readLedgerRecords(path)) === undefined ? 'corrupt' : 'readable'
}

/** Newest-first `.backup-<timestamp>` files beside one ledger target. */
async function listLedgerBackups(genericPath: string): Promise<string[]> {
  const directory = dirname(genericPath)
  const base = genericPath.slice(directory.length + 1)
  let entries: string[]
  try {
    entries = await readdir(directory)
  } catch (error) {
    if (isNodeErrorCode(error, 'ENOENT')) return []
    throw error
  }
  return entries
    .filter(entry => entry.startsWith(`${base}.backup-`))
    .sort()
    .reverse()
    .map(entry => join(directory, entry))
}

/**
 * Restore a generic ledger from the rolling `.last-good` snapshot, then the
 * newest `.backup-*` file. Every candidate must validate as a workspace ledger
 * and (when `expectedIds` is supplied) contain every expected id.
 *
 * @param options - ledger path, optional identity expectations, optional logger.
 * @returns which source was used, or `recovered: false` plus the reason.
 */
export async function recoverGenericLedger(options: GenericLedgerRecoveryOptions): Promise<GenericLedgerRecoveryResult> {
  const log = options.log ?? ((message: string) => { console.warn(message) })
  const candidates: Array<{ source: GenericLedgerRecoverySource; path: string }> = []
  const lastGood = `${options.genericPath}.last-good`
  if (await fileExists(lastGood)) candidates.push({ source: 'last-good', path: lastGood })
  for (const backup of await listLedgerBackups(options.genericPath)) {
    candidates.push({ source: 'backup', path: backup })
  }

  for (const candidate of candidates) {
    const parsed = await readLedgerRecords(candidate.path)
    if (parsed === undefined) {
      log(`[dsh-hardssh] ledger recovery candidate '${candidate.path}' is unusable: not a valid workspace ledger`)
      continue
    }
    const problem = candidateProblem(parsed, options.expectedIds)
    if (problem !== undefined) {
      log(`[dsh-hardssh] ledger recovery candidate '${candidate.path}' is insufficient: ${problem}`)
      continue
    }
    try {
      await mkdir(dirname(options.genericPath), { recursive: true })
      const temporary = `${options.genericPath}.tmp-${process.pid}-${randomUUID()}`
      await writeFile(temporary, JSON.stringify(parsed, null, 2), 'utf8')
      await rename(temporary, options.genericPath)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      log(`[dsh-hardssh] ledger recovery from '${candidate.path}' failed while writing: ${message}`)
      continue
    }
    log(`[dsh-hardssh] restored ${parsed.length} workspace(s) into '${options.genericPath}' from ${candidate.source} '${candidate.path}'`)
    return { recovered: true, source: candidate.source, path: candidate.path, recordCount: parsed.length }
  }

  return { recovered: false, reason: 'no .last-good copy and no backup' }
}
