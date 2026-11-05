/**
 * "SSH operation log" section for the workspace manager panel.
 *
 * Rendered as ONE continuous, non-interactive output stream (VS Code Output
 * style): oldest line at the top, newest at the bottom, auto-scrolled to the
 * tail. Each line is a plain text row — the plugin's management commands and
 * their output printed in the order they ran, not collapsible per-operation
 * cards.
 *
 * Only management operations appear here (host test, remote browse, workspace
 * create, sandbox deploy). Session tools (`bash`, `read`, `write`, `glob`,
 * `grep`) never write to this log; their output belongs to the session
 * trajectory.
 */

import { useEffect, useRef, useState, type ReactElement } from 'react'
import type { OperationLogSnapshot, OperationRecord } from '../protocol.ts'
import type { WorkspaceApi } from './api.ts'
import { tt } from './text.ts'
import css from './workspace.module.css'

const POLL_MS = 1_000

export interface OperationLogSectionProps {
  api?: WorkspaceApi
}

/** One printed line of the stream. */
interface OutputLine {
  /** Stable key: the operation id plus the line's index inside it. */
  key: string
  kind: 'head' | 'command' | 'output' | 'error'
  text: string
}

/** `HH:MM:SS` for one instant (the terminal prints local wall-clock time). */
function stamp(epochMs: number): string {
  const date = new Date(epochMs)
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
}

/** Project one operation into its printed lines (header, commands, output). */
function linesOf(entry: OperationRecord): OutputLine[] {
  const lines: OutputLine[] = []
  const status = entry.status === 'running'
    ? 'running'
    : entry.status === 'failed'
      ? `failed after ${entry.durationMs ?? 0}ms`
      : `ok after ${entry.durationMs ?? 0}ms`
  lines.push({ key: `${entry.id}:head`, kind: 'head', text: `[${stamp(entry.startedAt)}] ${entry.alias} ${entry.operation} ${status}` })
  for (const [index, step] of entry.steps.entries()) {
    lines.push({ key: `${entry.id}:${index}:cmd`, kind: 'command', text: `$ ${step.command}` })
    const stream = step.stderrTail ?? step.stdoutTail
    if (stream !== undefined) {
      for (const [streamIndex, text] of stream.replace(/\n$/, '').split('\n').entries()) {
        lines.push({ key: `${entry.id}:${index}:${streamIndex}:out`, kind: 'output', text })
      }
    }
    const code = step.exitCode === null ? 'no exit code' : `exit ${step.exitCode}`
    lines.push({ key: `${entry.id}:${index}:meta`, kind: 'output', text: `  (${code}, ${step.durationMs}ms)` })
  }
  if (entry.error !== undefined) {
    lines.push({ key: `${entry.id}:err`, kind: 'error', text: `! ${entry.error}` })
    if (entry.failureDetail !== undefined) {
      lines.push({ key: `${entry.id}:cause`, kind: 'error', text: `  cause: ${entry.failureDetail}` })
    }
  }
  return lines
}

/** Flatten the snapshot into one chronological stream (oldest first). */
function streamLines(snapshot: OperationLogSnapshot): OutputLine[] {
  const ordered = [...snapshot.entries].sort((left, right) => left.startedAt - right.startedAt)
  return ordered.flatMap(entry => linesOf(entry))
}

/** Collapsed by default; polls only while the user has it open. */
export function OperationLogSection({ api }: OperationLogSectionProps): ReactElement {
  const [open, setOpen] = useState(false)
  const [snapshot, setSnapshot] = useState<OperationLogSnapshot>({ entries: [], dropped: 0 })
  const [error, setError] = useState<string | null>(null)
  const [clearing, setClearing] = useState(false)
  const terminalRef = useRef<HTMLPreElement | null>(null)
  /** Follow the tail unless the user scrolled up to read history. */
  const followTailRef = useRef(true)

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

  const lines = streamLines(snapshot)

  // Terminal behavior: keep the newest line visible while the user is at the
  // bottom; leave the scroll position alone when they scrolled up.
  useEffect(() => {
    const terminal = terminalRef.current
    if (terminal === null || !open || !followTailRef.current) return
    terminal.scrollTop = terminal.scrollHeight
  }, [open, lines.length, snapshot.entries.length])

  const onScroll = (): void => {
    const terminal = terminalRef.current
    if (terminal === null) return
    followTailRef.current = terminal.scrollHeight - terminal.scrollTop - terminal.clientHeight < 24
  }

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
        <pre
          ref={terminalRef}
          className={css.operationTerminal}
          data-operation-terminal
          onScroll={onScroll}
          aria-live="polite"
          aria-label={tt('manager.operationLog')}
        >
          {snapshot.dropped > 0 && <span className={css.operationDropped}>{tt('manager.operationLogDropped')}{'\n'}</span>}
          {lines.length === 0
            ? <span className={css.operationMuted}>{tt('manager.operationLogEmpty')}</span>
            : lines.map(line => (
                <span key={line.key} className={css.operationLine} data-kind={line.kind}>
                  {line.text}
                  {'\n'}
                </span>
              ))}
        </pre>
      </div>
    </details>
  )
}
