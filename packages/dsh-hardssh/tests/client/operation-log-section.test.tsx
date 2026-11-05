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

describe('SSH operation log section', () => {
  it('does not poll while collapsed', async () => {
    setLanguage(true)
    const read = vi.fn(async () => ({ entries: [], dropped: 0 }))
    const api = { readOperationLog: read, clearOperationLog: vi.fn() } as unknown as WorkspaceApi
    const host = await renderSection(api)
    expect(host.textContent).toContain('SSH 操作日志')
    expect(read).not.toHaveBeenCalled()
  })

  it('shows management operations with their command and stderr when expanded', async () => {
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

    expect(read).toHaveBeenCalled()
    const text = host.textContent ?? ''
    expect(text).toContain('zen5-88')
    expect(text).toContain('sandbox.deploy')
    expect(text).toContain('failed')
    expect(text).toContain('runner directory creation failed')
    expect(text).toContain("mkdir -p -- '/home/shixianjie/.dsh-hardssh'")
    expect(text).toContain('Permission denied')
    expect(text).toContain('exit 1')
  })

  it('clears the log through the API and drops the rendered entries', async () => {
    setLanguage(true)
    const read = vi.fn(async () => ({
      entries: [{ id: 'op-1', operation: 'host.test', alias: 'box', startedAt: 1, status: 'ok', steps: [] }],
      dropped: 0,
    }))
    const clearOperationLog = vi.fn(async () => undefined)
    const api = { readOperationLog: read, clearOperationLog } as unknown as WorkspaceApi
    const host = await renderSection(api)
    await expand(host)
    expect(host.textContent).toContain('host.test')

    const button = Array.from(host.querySelectorAll('button')).find(node => node.textContent === '清空')!
    await act(async () => {
      button.click()
      await Promise.resolve()
    })
    expect(clearOperationLog).toHaveBeenCalledTimes(1)
    expect(host.textContent).toContain('暂无操作记录')
  })

  it('surfaces a read failure instead of silently showing an empty log', async () => {
    setLanguage(true)
    const read = vi.fn(async () => { throw new Error('console route unreachable') })
    const api = { readOperationLog: read, clearOperationLog: vi.fn() } as unknown as WorkspaceApi
    const host = await renderSection(api)
    await expand(host)
    expect(host.textContent).toContain('console route unreachable')
  })
})
