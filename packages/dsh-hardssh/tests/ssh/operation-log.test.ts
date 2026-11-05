/**
 * The management-operation log: bounded ring buffer, redaction before storage,
 * step recording on success and failure, and the guarantee that logging can
 * never affect the operation's own result.
 *
 * Scope guard: nothing here represents a session tool call — the log is only
 * written by management entry points.
 */

import { describe, expect, it } from 'vitest'
import { OperationLog } from '../../src/ssh/operation-log.ts'

describe('OperationLog', () => {
  it('records one operation with its steps and finishes ok', async () => {
    const log = new OperationLog()
    const record = log.begin('sandbox.deploy', 'host-a')
    const value = await log.step(record, 'uname -s', async () => 'Linux', result => ({ exitCode: 0, stdout: result }))
    expect(value).toBe('Linux')
    log.finish(record, 'ok')

    const snapshot = log.snapshot()
    expect(snapshot.entries).toHaveLength(1)
    const entry = snapshot.entries[0]!
    expect(entry.operation).toBe('sandbox.deploy')
    expect(entry.alias).toBe('host-a')
    expect(entry.status).toBe('ok')
    expect(entry.durationMs).toEqual(expect.any(Number))
    expect(entry.steps).toEqual([
      { command: 'uname -s', exitCode: 0, durationMs: expect.any(Number), stdoutTail: 'Linux' },
    ])
  })

  it('keeps the failed step and the error when the operation throws', async () => {
    const log = new OperationLog()
    const record = log.begin('workspace.create', 'host-b')
    await expect(log.step(record, 'sftp realpath /srv/x', async () => {
      throw new Error('No such file')
    })).rejects.toThrow('No such file')
    log.finish(record, 'failed', 'remote directory does not exist')

    const entry = log.snapshot().entries[0]!
    expect(entry.status).toBe('failed')
    expect(entry.error).toBe('remote directory does not exist')
    expect(entry.steps[0]!.command).toBe('sftp realpath /srv/x')
    expect(entry.steps[0]!.stderrTail).toContain('No such file')
  })

  it('returns newest first and evicts the oldest beyond the ring size', () => {
    const log = new OperationLog({ limit: 2 })
    log.begin('host.test', 'one')
    log.begin('host.test', 'two')
    log.begin('host.test', 'three')

    const snapshot = log.snapshot()
    expect(snapshot.entries.map(entry => entry.alias)).toEqual(['three', 'two'])
    expect(snapshot.dropped).toBe(1)
  })

  it('redacts commands and output before storing them', async () => {
    const log = new OperationLog({ redact: text => text.replace('hunter2', '***') })
    const record = log.begin('host.test', 'host-c')
    await log.step(record, 'connect --password hunter2', async () => 'token hunter2 leaked', result => ({ exitCode: 0, stdout: result }))
    log.finish(record, 'failed', 'auth hunter2 rejected')

    const entry = log.snapshot().entries[0]!
    expect(entry.steps[0]!.command).not.toContain('hunter2')
    expect(entry.steps[0]!.stdoutTail).not.toContain('hunter2')
    expect(entry.error).not.toContain('hunter2')
    expect(entry.steps[0]!.stdoutTail).toContain('***')
  })

  it('truncates long output to its tail and leaves absent output undefined', async () => {
    const log = new OperationLog()
    const record = log.begin('workspace.browse', 'host-d')
    const longOutput = `${'x'.repeat(10_000)}END`
    await log.step(record, 'ls', async () => longOutput, result => ({ exitCode: 0, stdout: result }))
    await log.step(record, 'noop', async () => undefined)

    const steps = log.snapshot().entries[0]!.steps
    expect(steps[0]!.stdoutTail).toHaveLength(4_096)
    expect(steps[0]!.stdoutTail!.endsWith('END')).toBe(true)
    expect(steps[1]!.stdoutTail).toBeUndefined()
    expect(steps[1]!.stderrTail).toBeUndefined()
  })

  it('never fails the operation when the log itself throws', async () => {
    const log = new OperationLog({ redact: () => { throw new Error('redactor exploded') } })
    const record = log.begin('host.test', 'host-e')
    const value = await log.step(record, 'ssh test', async () => 'ok', result => ({ exitCode: 0, stdout: result }))
    expect(value).toBe('ok')
    log.finish(record, 'ok')
    expect(log.snapshot().entries[0]!.steps[0]!.command).toBe('ssh test')
  })

  it('clears the buffer and its eviction count', () => {
    const log = new OperationLog({ limit: 1 })
    log.begin('host.test', 'one')
    log.begin('host.test', 'two')
    log.clear()
    expect(log.snapshot()).toEqual({ entries: [], dropped: 0 })
  })

  it('runs the step unchanged when no record is supplied', async () => {
    const log = new OperationLog()
    const value = await log.step(undefined, 'ignored', async () => 42)
    expect(value).toBe(42)
    expect(log.snapshot().entries).toHaveLength(0)
  })
})
