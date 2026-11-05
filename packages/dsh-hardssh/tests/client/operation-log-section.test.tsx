// @vitest-environment jsdom

import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { WorkspaceApi } from '../../src/client/api.ts'
import { OperationLogSection } from '../../src/client/operation-log.tsx'
import { setLanguage } from '../../src/client/text.ts'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const roots: Array<ReturnType<typeof createRoot>> = []
afterEach(async () => {
  for (const root of roots.splice(0)) await act(async () => { root.unmount() })
  document.body.innerHTML = ''
  vi.restoreAllMocks()
})

/** Render the section into a detached host and return it. */
async function renderSection(api: WorkspaceApi): Promise<HTMLElement> {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  roots.push(root)
  await act(async () => {
    root.render(<OperationLogSection api={api} />)
    await Promise.resolve()
  })
  return host
}

/** jsdom does not toggle a <details> by itself: set the flag and fire toggle. */
async function expand(host: HTMLElement): Promise<void> {
  const details = host.querySelector('details')!
  details.open = true
  await act(async () => {
    details.dispatchEvent(new Event('toggle'))
    await Promise.resolve()
  })
}

const terminal = (host: HTMLElement): HTMLPreElement => host.querySelector<HTMLPreElement>('[data-operation-terminal]')!

describe('SSH operation log section', () => {
  it('does not poll while collapsed', async () => {
    setLanguage(true)
    const read = vi.fn(async () => ({ entries: [], dropped: 0 }))
    const api = { readOperationLog: read, clearOperationLog: vi.fn() } as unknown as WorkspaceApi
    const host = await renderSection(api)
    expect(host.textContent).toContain('SSH 操作日志')
    expect(read).not.toHaveBeenCalled()
  })

  it('prints one continuous stream with commands, output and the failure', async () => {
    setLanguage(true)
    const read = vi.fn(async () => ({
      entries: [{
        id: 'op-1',
        operation: 'sandbox.deploy',
        alias: 'zen5-88',
        startedAt: 1_700_000_000_000,
        durationMs: 820,
        status: 'failed',
        error: 'remote sandbox: runner directory creation failed',
        steps: [{
          command: "mkdir -p -- '/home/shixianjie/.dsh-hardssh'",
          exitCode: 1,
          durationMs: 12,
          stderrTail: 'mkdir: cannot create directory: Permission denied',
        }],
      }],
      dropped: 0,
    }))
    const api = { readOperationLog: read, clearOperationLog: vi.fn() } as unknown as WorkspaceApi
    const host = await renderSection(api)
    await expand(host)

    const text = terminal(host).textContent ?? ''
    expect(text).toContain('zen5-88 sandbox.deploy failed after 820ms')
    expect(text).toContain("$ mkdir -p -- '/home/shixianjie/.dsh-hardssh'")
    expect(text).toContain('mkdir: cannot create directory: Permission denied')
    expect(text).toContain('(exit 1, 12ms)')
    expect(text).toContain('! remote sandbox: runner directory creation failed')
    // The panel is one stream, not one collapsible card per operation.
    expect(host.querySelectorAll('details')).toHaveLength(1)
    expect(host.querySelectorAll('summary')).toHaveLength(1)
  })

  it('orders lines oldest-first even though the API answers newest-first', async () => {
    setLanguage(true)
    const read = vi.fn(async () => ({
      entries: [
        {
          id: 'newer', operation: 'workspace.create', alias: 'box', startedAt: 2_000,
          status: 'ok', durationMs: 5, steps: [{ command: 'echo newer', exitCode: 0, durationMs: 1 }],
        },
        {
          id: 'older', operation: 'host.test', alias: 'box', startedAt: 1_000,
          status: 'ok', durationMs: 7, steps: [{ command: 'echo older', exitCode: 0, durationMs: 1 }],
        },
      ],
      dropped: 0,
    }))
    const api = { readOperationLog: read, clearOperationLog: vi.fn() } as unknown as WorkspaceApi
    const host = await renderSection(api)
    await expand(host)

    const text = terminal(host).textContent ?? ''
    expect(text.indexOf('$ echo older')).toBeGreaterThanOrEqual(0)
    expect(text.indexOf('$ echo newer')).toBeGreaterThan(text.indexOf('$ echo older'))
  })

  it('shows a running operation without inventing a duration', async () => {
    setLanguage(true)
    const read = vi.fn(async () => ({
      entries: [{
        id: 'running-op', operation: 'workspace.browse', alias: 'box', startedAt: 1_000,
        status: 'running', steps: [{ command: 'printf %s "$HOME"', exitCode: null, durationMs: 3 }],
      }],
      dropped: 0,
    }))
    const api = { readOperationLog: read, clearOperationLog: vi.fn() } as unknown as WorkspaceApi
    const host = await renderSection(api)
    await expand(host)
    const text = terminal(host).textContent ?? ''
    expect(text).toContain('workspace.browse running')
    expect(text).toContain('(no exit code, 3ms)')
  })

  it('clears the log through the API and shows the empty state', async () => {
    setLanguage(true)
    const read = vi.fn(async () => ({
      entries: [{ id: 'op-1', operation: 'host.test', alias: 'box', startedAt: 1, status: 'ok', steps: [] }],
      dropped: 0,
    }))
    const clearOperationLog = vi.fn(async () => undefined)
    const api = { readOperationLog: read, clearOperationLog } as unknown as WorkspaceApi
    const host = await renderSection(api)
    await expand(host)
    expect(terminal(host).textContent).toContain('host.test')

    const button = Array.from(host.querySelectorAll('button')).find(node => node.textContent === '清空')!
    await act(async () => {
      button.click()
      await Promise.resolve()
    })
    expect(clearOperationLog).toHaveBeenCalledTimes(1)
    expect(terminal(host).textContent).toContain('暂无操作记录')
  })

  it('surfaces a read failure instead of silently showing an empty stream', async () => {
    setLanguage(true)
    const read = vi.fn(async () => { throw new Error('console route unreachable') })
    const api = { readOperationLog: read, clearOperationLog: vi.fn() } as unknown as WorkspaceApi
    const host = await renderSection(api)
    await expand(host)
    expect(host.textContent).toContain('console route unreachable')
  })
})
