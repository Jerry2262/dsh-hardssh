/**
 * Collapsible "SSH operation log" section for the workspace manager panel.
 *
 * It only ever displays operations the plugin itself initiated (host test,
 * remote browse, workspace create/delete, sandbox deploy). Session tools such
 * as `bash` / `read` / `write` never write to this log; their execution
 * information stays in the session trajectory.
 */

import { useEffect, useState, type ReactElement } from 'react'
import type { OperationLogSnapshot, OperationRecord, OperationStep } from '../protocol.ts'
import type { WorkspaceApi } from './api.ts'
import { tt } from './text.ts'
import css from './workspace.module.css'

const POLL_MS = 1_000

export interface OperationLogSectionProps {
  api?: WorkspaceApi
}

/** One command line inside an expanded operation. */
function StepView({ step }: { step: OperationStep }): ReactElement {
  return (
    <div className={css.operationStep}>
      <code className={css.operationCommand}>{step.command}</code>
      <span className={css.operationMeta}>
        {step.exitCode === null ? '—' : `exit ${step.exitCode}`} · {step.durationMs}ms
      </span>
      {step.stderrTail !== undefined && <pre className={css.operationOutput}>{step.stderrTail}</pre>}
      {step.stderrTail === undefined && step.stdoutTail !== undefined && <pre className={css.operationOutput}>{step.stdoutTail}</pre>}
    </div>
  )
}

/** One operation row; expanding it reveals its steps. */
function EntryView({ entry }: { entry: OperationRecord }): ReactElement {
  const duration = entry.durationMs === undefined ? '…' : `${entry.durationMs}ms`
  return (
    <details className={css.operationEntry} data-operation-entry={entry.id}>
      <summary className={css.operationSummary}>
        <span className={css.operationTime}>{new Date(entry.startedAt).toLocaleTimeString()}</span>
        <span className={css.operationAlias}>{entry.alias}</span>
        <span className={css.operationName}>{entry.operation}</span>
        <span className={css.operationStatus} data-state={entry.status}>{entry.status}</span>
        <span className={css.operationDuration}>{duration}</span>
      </summary>
      {entry.error !== undefined && <div className={css.operationError}>{entry.error}</div>}
      {entry.steps.map((step, index) => <StepView key={`${entry.id}-${index}`} step={step} />)}
    </details>
  )
}

/** Collapsed by default; polls only while the user has it open. */
export function OperationLogSection({ api }: OperationLogSectionProps): ReactElement {
  const [open, setOpen] = useState(false)
  const [snapshot, setSnapshot] = useState<OperationLogSnapshot>({ entries: [], dropped: 0 })
  const [error, setError] = useState<string | null>(null)
  const [clearing, setClearing] = useState(false)

  useEffect(() => {
    if (!open || api === undefined) return undefined
    let cancelled = false
    const load = async (): Promise<void> => {
      try {
        const next = await api.readOperationLog()
        if (cancelled) return
        setSnapshot(next)
        setError(null)
      } catch (loadError) {
        if (!cancelled) setError(loadError instanceof Error ? loadError.message : String(loadError))
      }
    }
    void load()
    const timer = setInterval(() => { void load() }, POLL_MS)
    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [open, api])

  const clear = async (): Promise<void> => {
    if (api === undefined || clearing) return
    setClearing(true)
    try {
      await api.clearOperationLog()
      setSnapshot({ entries: [], dropped: 0 })
      setError(null)
    } catch (clearError) {
      setError(clearError instanceof Error ? clearError.message : String(clearError))
    } finally {
      setClearing(false)
    }
  }

  return (
    <details
      className={css.operationLog}
      data-operation-log
      open={open}
      onToggle={event => { setOpen(event.currentTarget.open) }}
    >
      <summary className={css.operationLogSummary}>
        <span>{tt('manager.operationLog')}</span>
        {snapshot.entries.length > 0 && <span className={css.operationCount}>{snapshot.entries.length}</span>}
      </summary>
      <div className={css.operationLogBody}>
        <div className={css.operationLogToolbar}>
          <span>{tt('manager.operationLogHint')}</span>
          <button
            type="button"
            className={css.operationClear}
            disabled={api === undefined || clearing || snapshot.entries.length === 0}
            onClick={() => { void clear() }}
          >
            {tt('manager.operationLogClear')}
          </button>
        </div>
        {error !== null && <div className={css.operationError}>{error}</div>}
        {snapshot.dropped > 0 && <div className={css.operationDropped}>{tt('manager.operationLogDropped')}</div>}
        {snapshot.entries.length === 0 && <div className={css.dialogInfo}>{tt('manager.operationLogEmpty')}</div>}
        {snapshot.entries.map(entry => <EntryView key={entry.id} entry={entry} />)}
      </div>
    </details>
  )
}
