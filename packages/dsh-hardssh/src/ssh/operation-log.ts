/**
 * In-memory log of the plugin's own SSH management operations.
 *
 * Scope is deliberately narrow: only operations a management surface initiated
 * (host test, directory browse, workspace create/delete, sandbox deploy) call
 * `begin`/`step`/`finish`. Session tools (`bash`, `read`, `write`, …) never
 * touch this class, so their execution information stays in the session
 * trajectory. The log is a bounded ring buffer, memory-only, and redacts before
 * storing.
 *
 * @module dsh-hardssh/ssh/operation-log
 */

import { randomUUID } from 'node:crypto'
import type { OperationLogSnapshot, OperationRecord, OperationStep } from '../protocol.ts'

export type { OperationLogSnapshot, OperationRecord, OperationStep } from '../protocol.ts'

/** Bounded by default: a debugging surface must not become an unbounded leak. */
const DEFAULT_LIMIT = 200
const DEFAULT_MAX_COMMAND_CHARS = 8_192
const DEFAULT_MAX_TAIL_CHARS = 4_096

/** Facts one step wants in the log; absent fields are left out. */
export interface StepFacts {
  exitCode?: number | null
  stdout?: string
  stderr?: string
}

export interface OperationLogOptions {
  /** Ring size; oldest entries are evicted first. */
  limit?: number
  /** Redactor applied to commands/output before they are stored (engine.redact). */
  redact?: (text: string) => string
  /** Clock override for tests. */
  now?: () => number
}

/**
 * Record one operation, run its steps through `step`, and finish it exactly
 * once. A step failure never changes control flow: the caller still receives
 * the original error and decides how to report it.
 */
export class OperationLog {
  private readonly records: OperationRecord[] = []
  private droppedCount = 0
  private readonly limit: number
  private readonly maxCommandChars: number
  private readonly maxTailChars: number
  private readonly redact: (text: string) => string
  private readonly now: () => number

  constructor(options: OperationLogOptions = {}) {
    this.limit = Math.max(1, options.limit ?? DEFAULT_LIMIT)
    this.maxCommandChars = DEFAULT_MAX_COMMAND_CHARS
    this.maxTailChars = DEFAULT_MAX_TAIL_CHARS
    this.redact = options.redact ?? (text => text)
    this.now = options.now ?? Date.now
  }

  /** Open one operation; it is visible as `running` until finished. */
  begin(operation: OperationRecord['operation'], alias: string): OperationRecord {
    const record: OperationRecord = {
      id: randomUUID(),
      operation,
      alias,
      startedAt: this.now(),
      status: 'running',
      steps: [],
    }
    this.records.push(record)
    while (this.records.length > this.limit) {
      this.records.shift()
      this.droppedCount += 1
    }
    return record
  }

  /**
   * Run one command inside an operation and record its outcome.
   * `describe` extracts exit code / output tails from the call's result.
   * Without a record this is a plain pass-through (logging is optional).
   */
  async step<T>(
    record: OperationRecord | undefined,
    command: string,
    run: () => Promise<T>,
    describe?: (value: T) => StepFacts,
  ): Promise<T> {
    if (record === undefined) return run()
    const started = this.now()
    const loggableCommand = this.command(command)
    try {
      const value = await run()
      const facts = describe?.(value) ?? {}
      record.steps.push(this.stepOf(loggableCommand, started, facts))
      return value
    } catch (error: unknown) {
      record.steps.push(this.stepOf(loggableCommand, started, { stderr: errorMessage(error) }))
      throw error
    }
  }

  /** Close one operation. Logging failures here must never mask the operation. */
  finish(record: OperationRecord | undefined, status: 'ok' | 'failed', error?: string, failureDetail?: string): void {
    if (record === undefined) return
    try {
      record.status = status
      record.durationMs = this.now() - record.startedAt
      if (error !== undefined && error !== '') record.error = this.safe(error, this.maxCommandChars)
      if (failureDetail !== undefined && failureDetail !== '') {
        record.failureDetail = this.safe(failureDetail, this.maxCommandChars)
      }
    } catch {
      // The operation result is authoritative; diagnostics are best effort.
    }
  }

  /** Newest-first snapshot for the panel. */
  snapshot(): OperationLogSnapshot {
    const entries = [...this.records].reverse().map(record => ({
      ...record,
      steps: record.steps.map(step => ({ ...step })),
    }))
    return { entries, dropped: this.droppedCount }
  }

  clear(): void {
    this.records.length = 0
    this.droppedCount = 0
  }

  private stepOf(command: string, startedAt: number, facts: StepFacts): OperationStep {
    const step: OperationStep = {
      command,
      exitCode: facts.exitCode ?? null,
      durationMs: Math.max(0, this.now() - startedAt),
    }
    const stdout = this.tail(facts.stdout)
    const stderr = this.tail(facts.stderr)
    if (stdout !== undefined) step.stdoutTail = stdout
    if (stderr !== undefined) step.stderrTail = stderr
    return step
  }

  private command(command: string): string {
    return this.safe(command, this.maxCommandChars)
  }

  private tail(text: string | undefined): string | undefined {
    if (text === undefined || text === '') return undefined
    const redacted = this.safe(text, Number.MAX_SAFE_INTEGER)
    return redacted.length > this.maxTailChars ? redacted.slice(-this.maxTailChars) : redacted
  }

  private safe(text: string, maxChars: number): string {
    let redacted: string
    try {
      redacted = this.redact(text)
    } catch {
      redacted = text
    }
    return redacted.length > maxChars ? redacted.slice(0, maxChars) : redacted
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
