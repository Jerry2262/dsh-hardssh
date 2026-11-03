// @vitest-environment jsdom

import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DirectoryFlow, type DirectoryFlowInjected, type NativeDirectoryFlowHandle } from '../../src/client/directory-flow.tsx'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}

const host = (alias: string) => ({ alias, host: `${alias}.example`, port: 22, user: 'root' })

/** Drive a controlled React input the way a browser does (native setter + input event). */
function typeInto(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!
  setter.call(input, value)
  input.dispatchEvent(new Event('input', { bubbles: true }))
}

afterEach(() => {
  document.body.innerHTML = ''
})

describe('DirectoryFlow request sequencing', () => {
  it('ignores stale host/directory results and disables path-changing controls while browsing', async () => {
    const firstHosts = deferred<ReturnType<typeof host>[]>()
    const secondHosts = deferred<ReturnType<typeof host>[]>()
    const pendingDirectory = deferred<{ path: string; entries: [] }>()
    const listHosts = vi.fn()
      .mockReturnValueOnce(firstHosts.promise)
      .mockReturnValueOnce(secondHosts.promise)
      .mockResolvedValue([host('newest')])
    const listRemoteDir = vi.fn(() => pendingDirectory.promise)
    const injected: DirectoryFlowInjected = {
      resolveLocalFlow: () => undefined,
      createSshWorkspace: vi.fn(),
      listHosts,
      createHost: vi.fn(),
      listRemoteDir,
      createRemoteDir: vi.fn(),
      ensureConnected: vi.fn(async () => true),
    }
    const callbacks = {
      busy: false,
      onPicked: vi.fn(),
      onCancel: vi.fn(),
      onError: vi.fn(),
    }
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)

    await act(async () => { root.render(<DirectoryFlow open {...callbacks} {...injected} />) })
    await act(async () => { root.render(<DirectoryFlow open={false} {...callbacks} {...injected} />) })
    await act(async () => { root.render(<DirectoryFlow open {...callbacks} {...injected} />) })
    await act(async () => { secondHosts.resolve([host('newest')]) })
    await act(async () => { firstHosts.resolve([host('stale')]) })

    let menu = document.querySelector<HTMLElement>('[data-ssh-workspace-flow-menu]')!
    await act(async () => { menu.querySelectorAll<HTMLButtonElement>('button')[1].click() })
    let select = menu.querySelector<HTMLSelectElement>('select')!
    expect([...select.options].map(option => option.value)).toContain('newest')
    expect([...select.options].map(option => option.value)).not.toContain('stale')

    await act(async () => {
      select.value = 'newest'
      select.dispatchEvent(new Event('change', { bubbles: true }))
    })
    menu = document.querySelector<HTMLElement>('[data-ssh-workspace-flow-menu]')!
    const sshButtons = menu.querySelectorAll<HTMLButtonElement>('button')
    await act(async () => { sshButtons[1].click() })

    menu = document.querySelector<HTMLElement>('[data-ssh-workspace-flow-menu]')!
    select = menu.querySelector<HTMLSelectElement>('select')!
    const pathInput = menu.querySelectorAll<HTMLInputElement>('input')[0]
    expect(select.disabled).toBe(true)
    expect(pathInput.disabled).toBe(true)
    for (const button of menu.querySelectorAll<HTMLButtonElement>('button')) expect(button.disabled).toBe(true)

    // Closing invalidates the outstanding directory request. Its late result
    // must not leak into the next opening.
    await act(async () => { root.render(<DirectoryFlow open={false} {...callbacks} {...injected} />) })
    await act(async () => { root.render(<DirectoryFlow open {...callbacks} {...injected} />) })
    await act(async () => { pendingDirectory.resolve({ path: '/stale/path', entries: [] }) })
    menu = document.querySelector<HTMLElement>('[data-ssh-workspace-flow-menu]')!
    await act(async () => { menu.querySelectorAll<HTMLButtonElement>('button')[1].click() })
    expect(menu.querySelector<HTMLInputElement>('input')!.value).toBe('')
    expect(callbacks.onError).not.toHaveBeenCalled()

    await act(async () => { root.unmount() })
  })
})

describe('DirectoryFlow local branch delegates to the kernel flow', () => {
  interface StubOptions {
    picked?: string
    injected?: Record<string, unknown>
  }

  /** A stand-in for the kernel's registered directory-flow occupant. */
  function kernelFlow(options: StubOptions = {}): NativeDirectoryFlowHandle {
    const component = ((props: Record<string, unknown>) => (
      <div data-native-flow-stub="" data-busy={String(props.busy)}>
        <span data-has-pick={String(typeof props.pick === 'function')} />
        <button
          type="button"
          data-native-flow-pick=""
          onClick={() => (props.onPicked as (path: string) => void)(options.picked ?? '/home/u/proj')}
        >
          pick
        </button>
        <button type="button" data-native-flow-cancel="" onClick={() => (props.onCancel as () => void)()}>
          cancel
        </button>
      </div>
    )) as unknown as NativeDirectoryFlowHandle['component']
    return { component, injected: options.injected ?? {} }
  }

  /** Mount the flow open and return its menu plus the owner callbacks. */
  async function mount(resolveLocalFlow: () => NativeDirectoryFlowHandle | undefined) {
    const injected: DirectoryFlowInjected = {
      resolveLocalFlow,
      createSshWorkspace: vi.fn(),
      listHosts: vi.fn(async () => []),
      createHost: vi.fn(),
      listRemoteDir: vi.fn(),
      createRemoteDir: vi.fn(),
      ensureConnected: vi.fn(async () => true),
    }
    const onError = vi.fn()
    const onPicked = vi.fn()
    const onCancel = vi.fn()
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    await act(async () => {
      root.render(
        <DirectoryFlow
          open
          busy={false}
          onPicked={onPicked}
          onCancel={onCancel}
          onError={onError}
          {...injected}
        />,
      )
    })
    const menu = () => document.querySelector<HTMLElement>('[data-ssh-workspace-flow-menu]')!
    const openLocal = async () => {
      await act(async () => { menu().querySelectorAll<HTMLButtonElement>('button')[0].click() })
    }
    return { root, menu, openLocal, onError, onPicked, onCancel }
  }

  it('renders the kernel component with its own injected face instead of re-implementing the picker', async () => {
    const handle = kernelFlow({ injected: { pick: () => Promise.resolve(null) } })
    const { root, menu, openLocal } = await mount(() => handle)
    await openLocal()
    const stub = document.querySelector<HTMLElement>('[data-native-flow-stub]')!
    expect(stub).not.toBeNull()
    expect(stub.querySelector('[data-has-pick]')!.getAttribute('data-has-pick')).toBe('true')
    expect(menu()).toBeNull()
    await act(async () => { root.unmount() })
  })

  it('forwards the path the kernel flow picked to the owner', async () => {
    const { root, openLocal, onPicked } = await mount(() => kernelFlow({ injected: { pick: vi.fn() } }))
    await openLocal()
    await act(async () => { document.querySelector<HTMLButtonElement>('[data-native-flow-pick]')!.click() })
    expect(onPicked).toHaveBeenCalledWith('/home/u/proj')
    await act(async () => { root.unmount() })
  })

  it('still refuses a filesystem root before handing it to the owner', async () => {
    const { root, menu, openLocal, onError, onPicked } = await mount(() =>
      kernelFlow({ picked: 'C:\\', injected: { pick: vi.fn() } }),
    )
    await openLocal()
    await act(async () => { document.querySelector<HTMLButtonElement>('[data-native-flow-pick]')!.click() })
    expect(onPicked).not.toHaveBeenCalled()
    expect(onError).toHaveBeenCalledTimes(1)
    expect(String(onError.mock.calls[0]?.[0])).toMatch(/root/i)
    // The failure re-arms the menu instead of leaving an empty dropdown.
    expect(menu()).not.toBeNull()
    await act(async () => { root.unmount() })
  })

  it('forwards the kernel flow cancellation to the owner', async () => {
    const { root, openLocal, onCancel } = await mount(() => kernelFlow({ injected: { pick: vi.fn() } }))
    await openLocal()
    await act(async () => { document.querySelector<HTMLButtonElement>('[data-native-flow-cancel]')!.click() })
    expect(onCancel).toHaveBeenCalledTimes(1)
    await act(async () => { root.unmount() })
  })

  it('reports a missing kernel occupant at click time and keeps the menu usable', async () => {
    const { root, menu, openLocal, onError } = await mount(() => undefined)
    await openLocal()
    expect(onError).toHaveBeenCalledTimes(1)
    expect(String(onError.mock.calls[0]?.[0])).toContain('no local directory picker')
    expect(menu()).not.toBeNull()
    expect(menu().querySelectorAll('button').length).toBeGreaterThanOrEqual(2)
    await act(async () => { root.unmount() })
  })

  it('passes the owner busy flag through to the kernel flow', async () => {
    const { root, openLocal } = await mount(() => kernelFlow({ injected: { pick: vi.fn() } }))
    await openLocal()
    expect(document.querySelector<HTMLElement>('[data-native-flow-stub]')!.dataset.busy).toBe('false')
    await act(async () => { root.unmount() })
  })
})

describe('DirectoryFlow menu anchoring', () => {
  interface Rect { top: number; left: number; width: number; height: number }

  /** Give an element a layout box (jsdom reports zero rects otherwise). */
  function stubRect(el: Element, rect: Rect): void {
    const domRect = {
      ...rect,
      bottom: rect.top + rect.height,
      right: rect.left + rect.width,
      x: rect.left,
      y: rect.top,
      toJSON: () => domRect,
    } as DOMRect
    vi.spyOn(el, 'getBoundingClientRect').mockReturnValue(domRect)
  }

  /** A visible "Add workspace" trigger and an unrelated focused element. */
  function makeTriggers(): { trigger: HTMLButtonElement; stale: HTMLButtonElement } {
    const trigger = document.createElement('button')
    trigger.setAttribute('aria-label', 'Add workspace')
    stubRect(trigger, { top: 100, left: 20, width: 24, height: 24 })
    document.body.appendChild(trigger)

    // The bug: after the native dialog closes, focus can land on this button,
    // which has nothing to do with the add-workspace flow.
    const stale = document.createElement('button')
    stale.setAttribute('aria-label', 'Close')
    stubRect(stale, { top: 300, left: 500, width: 28, height: 28 })
    document.body.appendChild(stale)
    return { trigger, stale }
  }

  function injected(): DirectoryFlowInjected {
    return {
      resolveLocalFlow: () => undefined,
      createSshWorkspace: vi.fn(),
      listHosts: vi.fn(async () => []),
      createHost: vi.fn(),
      listRemoteDir: vi.fn(),
      createRemoteDir: vi.fn(),
      ensureConnected: vi.fn(async () => true),
    }
  }

  function mountFlow(): { root: ReturnType<typeof createRoot>; callbacks: Record<string, ReturnType<typeof vi.fn>> } {
    const callbacks = {
      busy: false,
      onPicked: vi.fn(),
      onCancel: vi.fn(),
      onError: vi.fn(),
    }
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    return { root, callbacks }
  }

  const menu = (): HTMLElement => document.querySelector<HTMLElement>('[data-ssh-workspace-flow-menu]')!

  it('anchors under an icon-only trigger identified by aria-label, not under a stale focus', async () => {
    const { trigger, stale } = makeTriggers()
    stale.focus()
    expect(document.activeElement).toBe(stale)
    const { root, callbacks } = mountFlow()
    await act(async () => { root.render(<DirectoryFlow open {...callbacks} {...injected()} />) })
    // Trigger rect: top 100, left 20, bottom 124 → menu 4px below.
    expect(menu().style.top).toBe('128px')
    expect(menu().style.left).toBe('20px')
    await act(async () => { root.unmount() })
    trigger.remove()
    stale.remove()
  })

  it('re-anchors under the trigger on the second opening after a dialog stole focus', async () => {
    const { trigger, stale } = makeTriggers()
    const { root, callbacks } = mountFlow()
    await act(async () => { root.render(<DirectoryFlow open {...callbacks} {...injected()} />) })
    expect(menu().style.top).toBe('128px')
    // The flow closes; the native dialog's focus restoration leaves an
    // unrelated element focused.
    await act(async () => { root.render(<DirectoryFlow open={false} {...callbacks} {...injected()} />) })
    stale.focus()
    await act(async () => { root.render(<DirectoryFlow open {...callbacks} {...injected()} />) })
    expect(menu().style.top).toBe('128px')
    expect(menu().style.left).toBe('20px')
    await act(async () => { root.unmount() })
    trigger.remove()
    stale.remove()
  })

  it('keeps the last known position when the trigger is temporarily hidden', async () => {
    const { trigger, stale } = makeTriggers()
    const { root, callbacks } = mountFlow()
    await act(async () => { root.render(<DirectoryFlow open {...callbacks} {...injected()} />) })
    await act(async () => { root.render(<DirectoryFlow open={false} {...callbacks} {...injected()} />) })
    trigger.remove()
    stale.focus()
    await act(async () => { root.render(<DirectoryFlow open {...callbacks} {...injected()} />) })
    expect(menu().style.top).toBe('128px')
    expect(menu().style.left).toBe('20px')
    await act(async () => { root.unmount() })
    stale.remove()
  })
})

describe('DirectoryFlow SSH branch reuses the kernel browse dialog', () => {
  type HostOption = { alias: string; host: string; port: number; user: string }

  function hostOption(alias: string): HostOption {
    return { alias, host: `${alias}.example`, port: 22, user: 'root' }
  }

  function record(input: { title: string; alias: string; remoteRoot: string }): {
    id: string
    title: string
    alias: string
    remoteRoot: string
    anchorPath: string
    createdAt: string
  } {
    return {
      id: 'w1',
      title: input.title,
      alias: input.alias,
      remoteRoot: input.remoteRoot,
      anchorPath: '/home/jerry/.dsh/ssh-workspaces/w1',
      createdAt: '2026-11-03T00:00:00.000Z',
    }
  }

  function kernelHandle(capture: (props: Record<string, unknown>) => void): NativeDirectoryFlowHandle {
    return {
      component: ((props: Record<string, unknown>) => {
        capture(props)
        return <div data-kernel-browse="" />
      }) as unknown as NativeDirectoryFlowHandle['component'],
      injected: {
        listDirectory: () => Promise.resolve(),
        createDirectory: () => Promise.resolve(''),
        t: (key: string) => `kernel:${key}`,
      },
    }
  }

  interface Mounted {
    root: ReturnType<typeof createRoot>
    injected: DirectoryFlowInjected
    kernelProps: () => Record<string, unknown>
    openSsh: () => Promise<void>
    openDir: (alias?: string) => Promise<void>
    onPicked: ReturnType<typeof vi.fn>
    onCancel: ReturnType<typeof vi.fn>
    onError: ReturnType<typeof vi.fn>
  }

  async function mountSsh(
    overrides: Partial<DirectoryFlowInjected> = {},
    hostList: HostOption[] = [hostOption('aliyun')],
  ): Promise<Mounted> {
    let captured: Record<string, unknown> | undefined
    const injected: DirectoryFlowInjected = {
      resolveLocalFlow: () => kernelHandle((props) => { captured = props }),
      createSshWorkspace: vi.fn(async (input) => record(input)),
      listHosts: vi.fn(async () => hostList),
      createHost: vi.fn(),
      listRemoteDir: vi.fn(async (_alias: string, path?: string) => ({
        path: path ?? '/home/u',
        entries: [
          { name: 'proj', type: 'dir' as const, size: 0, mtimeMs: 0 },
          { name: 'README.md', type: 'file' as const, size: 12, mtimeMs: 0 },
          { name: '.config', type: 'dir' as const, size: 0, mtimeMs: 0 },
        ],
      })),
      createRemoteDir: vi.fn(async (_alias: string, path: string, name: string) => ({ path: `${path}/${name}` })),
      ensureConnected: vi.fn(async () => true),
      ...overrides,
    }
    const onPicked = vi.fn()
    const onCancel = vi.fn()
    const onError = vi.fn()
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    await act(async () => {
      root.render(
        <DirectoryFlow
          open
          busy={false}
          onPicked={onPicked}
          onCancel={onCancel}
          onError={onError}
          {...injected}
        />,
      )
    })
    // The host list resolves in the open-edge effect.
    await act(async () => {})
    const menu = (): HTMLElement => document.querySelector<HTMLElement>('[data-ssh-workspace-flow-menu]')!
    const openSsh = async (): Promise<void> => {
      await act(async () => { menu().querySelectorAll<HTMLButtonElement>('button')[1].click() })
    }
    const pickServerRow = async (alias = 'aliyun'): Promise<void> => {
      const row = document.querySelector<HTMLButtonElement>(`[data-ssh-server-row="${alias}"]`)
      if (row === null) throw new Error(`server row '${alias}' not found`)
      await act(async () => { row.click() })
    }
    const openDir = async (alias = 'aliyun'): Promise<void> => {
      await openSsh()
      await pickServerRow(alias)
    }
    return { root, injected, kernelProps: () => captured!, openSsh, openDir, onPicked, onCancel, onError }
  }

  it('asks for the server before the directory dialog, even with one configured server', async () => {
    const { root, openSsh } = await mountSsh()
    await openSsh()
    expect(document.querySelector('[data-ssh-server-picker]')).not.toBeNull()
    expect(document.querySelector('[data-kernel-browse]')).toBeNull()
    const row = document.querySelector<HTMLButtonElement>('[data-ssh-server-row="aliyun"]')!
    await act(async () => { row.click() })
    expect(document.querySelector('[data-kernel-browse]')).not.toBeNull()
    await act(async () => { root.unmount() })
  })

  it('closing the server chooser cancels the whole add-workspace flow', async () => {
    const { root, openSsh, onCancel } = await mountSsh()
    await openSsh()
    const cancel = [...document.querySelectorAll<HTMLButtonElement>('[data-ssh-server-picker] button')]
      .find(button => (button.textContent ?? '').trim() === 'Cancel')!
    await act(async () => { cancel.click() })
    expect(onCancel).toHaveBeenCalledTimes(1)
    await act(async () => { root.unmount() })
  })

  it('closing the directory dialog cancels the flow instead of dropping back to the server chooser', async () => {
    const { root, openDir, kernelProps, onCancel } = await mountSsh()
    await openDir()
    await act(async () => {
      (kernelProps().onCancel as () => void)()
    })
    expect(onCancel).toHaveBeenCalledTimes(1)
    expect(document.querySelector('[data-ssh-server-picker]')).toBeNull()
    await act(async () => { root.unmount() })
  })

  it('overrides only the kernel dialog title, keeping its own copy for everything else', async () => {
    const { root, openDir, kernelProps } = await mountSsh()
    await openDir()
    const t = kernelProps().t as (key: string, params?: Record<string, unknown>) => string
    expect(t('browser.title')).toMatch(/SSH/)
    expect(t('browser.home')).toBe('kernel:browser.home')
    await act(async () => { root.unmount() })
  })

  it('lists remote directories in the kernel dialog listing shape', async () => {
    const { root, openDir, kernelProps, injected } = await mountSsh()
    await openDir()
    const listDirectory = kernelProps().listDirectory as (path?: string, signal?: AbortSignal) => Promise<unknown>
    const listing = await listDirectory()
    expect(listing).toEqual({
      path: '/home/u',
      home: '/home/u',
      crumbs: [
        { name: '/', path: '/', hidden: false },
        { name: 'home', path: '/home', hidden: false },
        { name: 'u', path: '/home/u', hidden: false },
      ],
      entries: [
        { name: 'proj', path: '/home/u/proj', hidden: false },
        { name: '.config', path: '/home/u/.config', hidden: true },
      ],
      truncated: false,
    })
    expect(injected.listRemoteDir).toHaveBeenCalledWith('aliyun', undefined)
    // A deeper level keeps the home captured by the first listing.
    const deeper = await listDirectory('/home/u/proj')
    expect((deeper as { home: string }).home).toBe('/home/u')
    await act(async () => { root.unmount() })
  })

  it('forwards "New folder" to the remote mkdir API', async () => {
    const { root, openDir, kernelProps, injected } = await mountSsh()
    await openDir()
    const createDirectory = kernelProps().createDirectory as (path: string, name: string) => Promise<string>
    const created = await createDirectory('/home/u', 'new')
    expect(created).toBe('/home/u/new')
    expect(injected.createRemoteDir).toHaveBeenCalledWith('aliyun', '/home/u', 'new')
    await act(async () => { root.unmount() })
  })

  it('creates the SSH workspace from the picked directory and adopts its anchor', async () => {
    const { root, openDir, kernelProps, injected, onPicked } = await mountSsh()
    await openDir()
    await act(async () => {
      (kernelProps().onPicked as (path: string) => void)('/home/u/proj')
      await Promise.resolve()
    })
    expect(injected.createSshWorkspace).toHaveBeenCalledWith({
      title: 'proj',
      alias: 'aliyun',
      remoteRoot: '/home/u/proj',
    })
    expect(onPicked).toHaveBeenCalledWith('/home/jerry/.dsh/ssh-workspaces/w1')
    await act(async () => { root.unmount() })
  })

  it('answers the interactive connection gate before creating (canonical create needs a live host)', async () => {
    const createSshWorkspace = vi.fn()
      .mockRejectedValueOnce(Object.assign(new Error('password required'), { code: 'NEEDS_PASSWORD' }))
      .mockResolvedValueOnce(record({ title: 'proj', alias: 'aliyun', remoteRoot: '/home/u/proj' }))
    const ensureConnected = vi.fn(async () => true)
    const { root, openDir, kernelProps, onPicked } = await mountSsh({ createSshWorkspace, ensureConnected })
    await openDir()
    await act(async () => {
      void (kernelProps().onPicked as (path: string) => void)('/home/u/proj')
    })
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) })
    expect(ensureConnected).toHaveBeenCalledWith('aliyun')
    expect(createSshWorkspace).toHaveBeenCalledTimes(2)
    expect(onPicked).toHaveBeenCalledWith('/home/jerry/.dsh/ssh-workspaces/w1')
    await act(async () => { root.unmount() })
  })

  it('shows a configured server list when several servers exist', async () => {
    const { root, openSsh, injected, kernelProps } = await mountSsh({}, [hostOption('aliyun'), hostOption('backup')])
    await openSsh()
    expect(document.querySelector('[data-ssh-server-picker]')).not.toBeNull()
    const backup = document.querySelector<HTMLButtonElement>('[data-ssh-server-row="backup"]')!
    await act(async () => { backup.click() })
    expect(document.querySelector('[data-kernel-browse]')).not.toBeNull()
    // The dialog's listings now target the picked server.
    const listDirectory = kernelProps().listDirectory as (path?: string) => Promise<unknown>
    await listDirectory()
    expect(injected.listRemoteDir).toHaveBeenCalledWith('backup', undefined)
    await act(async () => { root.unmount() })
  })

  it('adds a server from the picker and enters its directory dialog', async () => {
    const createdHost = hostOption('newhost')
    let listCalls = 0
    const listHosts = vi.fn(async () => {
      listCalls += 1
      return listCalls === 1 ? [] : [createdHost]
    })
    const createHost = vi.fn(async () => createdHost)
    const { root, openSsh } = await mountSsh({ listHosts, createHost }, [])
    await openSsh()
    expect(document.querySelector('[data-ssh-server-picker]')).not.toBeNull()
    await act(async () => { document.querySelector<HTMLButtonElement>('[data-ssh-add-server]')!.click() })
    expect(document.querySelector('[data-ssh-add-server-dialog]')).not.toBeNull()
    const fill = async (field: string, value: string): Promise<void> => {
      const input = document.querySelector<HTMLInputElement>(`[data-ssh-host-field="${field}"]`)!
      await act(async () => { typeInto(input, value) })
    }
    await fill('alias', 'newhost')
    await fill('host', 'newhost.example')
    await fill('user', 'root')
    await act(async () => { document.querySelector<HTMLButtonElement>('[data-ssh-host-save]')!.click() })
    await act(async () => {})
    expect(createHost).toHaveBeenCalledWith(expect.objectContaining({
      alias: 'newhost',
      host: 'newhost.example',
      user: 'root',
    }))
    // Saving returns to the chooser (the server choice stays explicit); the
    // refreshed list shows the new host and clicking it opens the dialog.
    expect(document.querySelector('[data-ssh-server-picker]')).not.toBeNull()
    expect(document.querySelector('[data-ssh-server-row="newhost"]')).not.toBeNull()
    await act(async () => {
      document.querySelector<HTMLButtonElement>('[data-ssh-server-row="newhost"]')!.click()
    })
    expect(document.querySelector('[data-kernel-browse]')).not.toBeNull()
    await act(async () => { root.unmount() })
  })

  it('keeps the dialog and reports a creation failure', async () => {
    const { root, openDir, kernelProps } = await mountSsh({
      createSshWorkspace: vi.fn(async () => { throw new Error('registration failed') }),
    })
    await openDir()
    await act(async () => {
      (kernelProps().onPicked as (path: string) => void)('/home/u/proj')
      await Promise.resolve()
    })
    expect(document.querySelector('[data-kernel-browse]')).not.toBeNull()
    expect(document.querySelector('[role="alert"]')?.textContent).toContain('registration failed')
    await act(async () => { root.unmount() })
  })
})
