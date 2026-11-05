/**
 * The directory-flow occupant that adds the SSH workspace branch to the
 * kernel's "Add workspace…" interaction.
 *
 * When the operator clicks the native "Add workspace…" entry, this component
 * opens a small chooser with two options:
 *
 *  - "Local workspace": renders the kernel's OWN directory-flow occupant,
 *    looked up by reference in the slot ledger (`ctx.slots.entries`). The
 *    composed surface decides what that is — the native OS chooser or the
 *    in-app browse dialog — so this plugin never re-implements that
 *    interaction and never drives the wrong capability.
 *  - "SSH workspace": picks a host and then opens the same kernel browse
 *    dialog over SFTP (one configured server skips the chooser; the
 *    workspace title follows the picked directory's basename). On success
 *    it calls
 *    `onPicked(anchorPath)` so the host adopts the LOCAL ANCHOR directory as
 *    a normal workspace (the seams route that workspace remote by its anchor
 *    path). On cancel it calls `onCancel`.
 *
 * Occupancy: both directory-flow holes are `kind: 'single'`, so registering
 * here shadows the kernel's occupant for the menu itself; the local branch
 * delegates back to that same registration.
 *
 * @module dsh-hardssh/client/directory-flow
 */

import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ComponentType, type ReactElement } from 'react'
import { createPortal } from 'react-dom'
// Type-only: pulls the SlotMap augmentation (the directory-flow holes) from
// the ui-workspace package, plus the DirectoryFlowOwnerProps contract.
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client'
import type { DirectoryFlowOwnerProps } from '@deepseek-ai/dsh-client-ui-workspace/client'
import type { SshWorkspaceRecord } from '../protocol.ts'
import { tt } from './text.ts'
import css from './workspace.module.css'
import { CloudIcon, ComputerIcon } from './icons.tsx'
import { checkLocalWorkspacePath } from './local-workspace-path.ts'
import { remoteWorkspaceTitle, toPickerListing } from './remote-listing.ts'
import { SshAddServerDialog, SshServerPickerDialog, type SshHostOption } from './ssh-server-picker.tsx'

/** A kernel-registered directory-flow occupant, reusable by reference. */
export interface NativeDirectoryFlowHandle {
  /** The component the composed kernel surface registered on this hole. */
  component: ComponentType<Record<string, unknown>>
  /** That registration's injected business face (picker or browse primitives). */
  injected: Record<string, unknown>
}

/** The injected face: the kernel flow handle resolver + our workspace manager API. */
export interface DirectoryFlowInjected {
  /**
   * Look up the kernel's own directory-flow occupant currently registered on
   * this hole. Rendering it reuses the native picking interaction of the
   * composed host (OS chooser or in-app browser) instead of re-implementing
   * either. `undefined` means no kernel occupant is registered.
   */
  resolveLocalFlow: () => NativeDirectoryFlowHandle | undefined
  /** Create an SSH workspace (host API). */
  createSshWorkspace: (input: { title: string; alias: string; remoteRoot: string }) => Promise<SshWorkspaceRecord>
  /** List configured SSH hosts (host API). */
  listHosts: () => Promise<Array<{ alias: string; host: string; port: number; user: string }>>
  /** Create a new SSH host (dsh-hardssh-ssh host store; auth is required). */
  createHost: (input: {
    alias: string
    host: string
    port?: number
    user: string
    auth: { kind: 'password'; password: string } | { kind: 'key'; keyPath: string; passphrase?: string }
  }) => Promise<{ alias: string; host: string; port: number; user: string }>
  /** Register an add-server password in the engine's session secret table.
   *  With `secretStorage='none'` (or a plain host whose password was not
   *  saved) the first directory browse would ask for the same password again;
   *  seeding it here avoids that second prompt. */
  rememberSessionSecret: (alias: string, password: string) => Promise<void>
  /** Browse a remote directory (host API). */
  listRemoteDir: (alias: string, path?: string) => Promise<{ path: string; entries: Array<{ name: string; type: 'dir' | 'file' | 'other'; size: number; mtimeMs: number }> }>
  /** Create one remote child directory (host API; the picker's New folder). */
  createRemoteDir: (alias: string, path: string, name: string) => Promise<{ path: string }>
  /** Interactive SSH connection gate: host-key TOFU + session-password
   *  dialogs. Resolves true when the alias is connected (or the user
   *  cancelled the prompts). Used to retry browsing. */
  ensureConnected: (alias: string) => Promise<boolean>
}

/** The two entry choices after "Add workspace…". */
type Choice = 'menu' | 'ssh' | 'ssh-dir' | 'browsing' | 'local-native'

/** Namespace-bound translate function the kernel browse occupant supplies. */
type KernelTranslate = (key: string, params?: Record<string, unknown>) => string

/** Abort rejection a superseded kernel scan expects from its listing call. */
function abortError(): Error {
  const error = new Error('aborted')
  error.name = 'AbortError'
  return error
}

/** A resolved anchor rect for the dropdown. */
interface AnchorRect {
  top: number
  left: number
  bottom: number
  width: number
}

/** Labels the host "Add workspace…" entry can carry (zh / en). Covers the
 *  kernel's own `workspace.add` / `menu.addWorkspace` copy plus the
 *  "local workspace" wording used by newer/other surfaces, since the anchor is
 *  only a positioning hint (a miss falls back to the last known trigger or the
 *  viewport corner). */
const ADD_WORKSPACE_LABELS = [
  '添加工作区',
  '添加本地工作区',
  '新建工作区',
  'Add workspace',
  'Add local workspace',
  'New workspace',
]

/** Whether an element advertises the add-workspace action. Icon-only header
 *  buttons carry the label in `aria-label`/`title` alone, so the visible-text
 *  scan must read those attributes too. */
function isAddWorkspaceTrigger(el: Element): boolean {
  const labelled = [el.getAttribute('aria-label'), el.getAttribute('title')]
    .map((value) => value?.trim() ?? '')
    .filter((value) => value !== '')
  if (labelled.some((value) => ADD_WORKSPACE_LABELS.some((label) => value === label || value.includes(label)))) {
    return true
  }
  const text = (el.textContent ?? '').trim()
  // Cap the length so a wrapping container that merely CONTAINS the trigger
  // cannot outscore the trigger itself.
  return text.length <= 64 && ADD_WORKSPACE_LABELS.some((label) => text.includes(label))
}

/** The element's viewport rect, or undefined while it has no layout box. */
function rectOf(el: Element): AnchorRect | undefined {
  const rect = el.getBoundingClientRect()
  if (rect.width > 0 && rect.height > 0) {
    return { top: rect.top, left: rect.left, bottom: rect.bottom, width: rect.width }
  }
  return undefined
}

/**
 * Find the visible host "Add workspace…" trigger. It is a button/menu item
 * rendered by ui-workspace; the sidebar header renders it icon-only, so
 * `aria-label`/`title` are the reliable identity there. Prefer an exact label
 * match inside the workspace sidebar, then a left-half match for the
 * empty-state hero trigger; another surface's entry cannot win over those.
 * @returns the trigger rect, or undefined when no trigger is visible.
 */
function findAddWorkspaceTrigger(): AnchorRect | undefined {
  const candidates: Array<{ rect: AnchorRect; score: number }> = []
  for (const el of document.querySelectorAll<HTMLElement>('button, [role="button"], [role="menuitem"]')) {
    if (!isAddWorkspaceTrigger(el)) continue
    const rect = rectOf(el)
    if (rect === undefined) continue
    const exact = [el.getAttribute('aria-label')?.trim() ?? '', (el.textContent ?? '').trim()]
      .some((value) => ADD_WORKSPACE_LABELS.includes(value))
    const inSidebar = el.closest('[data-pane="sidebar"]') !== null
      || el.closest('[class*="workspaceBrowser"], [class*="workspace-browser"]') !== null
    const leftHalf = rect.left + rect.width / 2 < window.innerWidth / 2
    candidates.push({ rect, score: (exact ? 4 : 0) + (inSidebar ? 2 : 0) + (leftHalf ? 1 : 0) })
  }
  candidates.sort((a, b) => b.score - a.score)
  return candidates[0]?.rect
}

/**
 * The flow occupant. Each rising `open` edge shows the menu; the ref arms
 * once per open so re-renders (and an adoption keeping `open` true while
 * `busy`) never launch a second flow.
 */
export function DirectoryFlow(props: DirectoryFlowOwnerProps & DirectoryFlowInjected): ReactElement | null {
  const { open, busy, onPicked, onCancel, onError } = props
  const outcome = useRef(props)
  outcome.current = props
  const [choice, setChoice] = useState<Choice>('menu')
  const [host, setHost] = useState('')
  const [dirPath, setDirPath] = useState('')
  const [title, setTitle] = useState('')
  const [hosts, setHosts] = useState<SshHostOption[]>([])
  const [dirEntries, setDirEntries] = useState<Array<{ name: string; type: 'dir' | 'file' | 'other'; size: number; mtimeMs: number }>>([])
  const [loading, setLoading] = useState(false)
  const [creating, setCreating] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [anchor, setAnchor] = useState<AnchorRect | undefined>(undefined)
  // "Add server…" mini-form inside the SSH branch.
  const [addingHost, setAddingHost] = useState(false)
  const [newHost, setNewHost] = useState({ alias: '', host: '', port: '22', user: '', password: '' })
  const [savingHost, setSavingHost] = useState(false)
  const openRef = useRef(open)
  openRef.current = open
  /** Last trigger rect this instance anchored to: the fallback when the trigger
   *  is temporarily hidden (for example while a dialog owns the document). */
  const lastTriggerRect = useRef<AnchorRect | undefined>(undefined)
  const hostsRequestSequence = useRef(0)
  const directoryRequestSequence = useRef(0)
  const createWorkspaceRequestSequence = useRef(0)
  const createHostRequestSequence = useRef(0)
  /** Invalidates an in-flight "select server → connect" gate. */
  const serverGateRequestSequence = useRef(0)

  // The kernel browse occupant is reused for the SSH directory step. Its
  // hooks compare callback identity (a changed `listDirectory` re-runs scans),
  // so the wrappers below stay stable and read live state through refs.
  const kernelFlow = props.resolveLocalFlow()
  const kernelBrowse = kernelFlow !== undefined
    && typeof (kernelFlow.injected as { listDirectory?: unknown }).listDirectory === 'function'
  const latestProps = useRef(props)
  latestProps.current = props
  const aliasRef = useRef(host)
  aliasRef.current = host
  const remoteHome = useRef<string | undefined>(undefined)
  const kernelTranslate = useRef<KernelTranslate | undefined>(undefined)
  kernelTranslate.current = typeof kernelFlow?.injected.t === 'function'
    ? kernelFlow.injected.t as KernelTranslate
    : undefined

  /** One remote level in the kernel dialog's listing shape, with the
   *  interactive connection gate retried in place (same policy as before). */
  const listRemoteLevel = useCallback(async (path?: string, signal?: AbortSignal) => {
    if (signal?.aborted === true) throw abortError()
    const alias = aliasRef.current
    if (alias === '') throw new Error(tt('create.needHost'))
    const deps = latestProps.current
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        const result = await deps.listRemoteDir(alias, path)
        if (signal?.aborted) throw abortError()
        if (remoteHome.current === undefined) remoteHome.current = result.path
        return toPickerListing(result, remoteHome.current)
      } catch (error) {
        const code = (error as { code?: string } | null)?.code
        const interactive = code === 'NEEDS_PASSWORD' || code === 'HOST_KEY_UNKNOWN' || code === 'HOST_KEY_MISMATCH'
        if (!interactive) throw error
        const connected = await deps.ensureConnected(alias)
        if (!connected) throw new Error(tt('create.needConnect'))
      }
    }
    throw new Error(tt('create.needConnect'))
  }, [])

  /** One remote child directory (the kernel dialog's New folder call). */
  const createRemoteLevel = useCallback(async (path: string, name: string): Promise<string> => {
    const result = await latestProps.current.createRemoteDir(aliasRef.current, path, name)
    return result.path
  }, [])

  /** Kernel dialog copy: only the title changes; everything else keeps the
   *  kernel dictionaries so the wording matches the local picker. */
  const remoteTranslate = useCallback((key: string, params?: Record<string, unknown>): string => {
    if (key === 'browser.title') return tt('flow.sshDirTitle')
    return kernelTranslate.current?.(key, params) ?? key
  }, [])

  // Reset and re-locate on each open edge. Every async data source owns a
  // request sequence; cleanup invalidates outstanding work from this opening.
  // Layout phase on purpose: a previous opening may have ended in another
  // branch (the kernel picker), and that branch must not render even once for
  // the new opening before the menu is re-armed.
  useLayoutEffect(() => {
    if (!open) return
    setChoice('menu')
    setHost('')
    setDirPath('')
    setTitle('')
    setDirEntries([])
    setLoading(false)
    setCreating(false)
    setSavingHost(false)
    setError(null)
    setAddingHost(false)
    setNewHost({ alias: '', host: '', port: '22', user: '', password: '' })
    setAnchorRect()
    // Lazy-load the host list for the SSH branch. A later refresh (for
    // example after adding a host) supersedes this request.
    const request = ++hostsRequestSequence.current
    // A synchronous throw here (missing injected dep) must not break the menu
    // render: the SSH branch then degrades to "no hosts", the local branch and
    // Cancel stay usable.
    try {
      void props.listHosts().then(
        (list) => {
          if (request === hostsRequestSequence.current && openRef.current) setHosts(list)
        },
        () => {
          if (request === hostsRequestSequence.current && openRef.current) setHosts([])
        },
      )
    } catch {
      if (request === hostsRequestSequence.current && openRef.current) setHosts([])
    }
    return () => {
      hostsRequestSequence.current += 1
      directoryRequestSequence.current += 1
      createWorkspaceRequestSequence.current += 1
      createHostRequestSequence.current += 1
      serverGateRequestSequence.current += 1
    }
  }, [open])

  /** Locate the trigger that just opened the flow and anchor the menu under it.
   *
   * Focus alone is not a reliable identity: the native picking dialog restores
   * (or loses) focus on close, so the next opening can see an unrelated element
   * as `document.activeElement` — anchoring to it put the menu at a stale
   * position. Trust the active element only when it really advertises the
   * add-workspace action; otherwise scan for the trigger, and fall back to the
   * last trigger this instance saw (or the viewport corner). */
  const setAnchorRect = (): void => {
    const active = document.activeElement
    if (active !== null && active !== document.body && isAddWorkspaceTrigger(active)) {
      const rect = rectOf(active)
      if (rect !== undefined) {
        lastTriggerRect.current = rect
        setAnchor(rect)
        return
      }
    }
    const trigger = findAddWorkspaceTrigger()
    if (trigger !== undefined) {
      lastTriggerRect.current = trigger
      setAnchor(trigger)
      return
    }
    if (lastTriggerRect.current !== undefined) {
      setAnchor(lastTriggerRect.current)
      return
    }
    setAnchor({ top: 56, left: 16, bottom: 56, width: 200 })
  }

  // Close when a click lands OUTSIDE the dropdown (no full-screen capture
  // layer, so the trigger button and the rest of the UI stay clickable). The
  // modal branches below own their backdrop/dismissal; a document-level
  // listener there would swallow the dialog's own clicks.
  const menuRef = useRef<HTMLDivElement | null>(null)
  const dropdownSurface = choice === 'menu'
    || choice === 'browsing'
    || (choice === 'ssh' && !kernelBrowse)
  useEffect(() => {
    if (!open || !dropdownSurface) return
    const onMouseDown = (event: MouseEvent): void => {
      if (menuRef.current !== null && menuRef.current.contains(event.target as Node)) return
      if (!busy) outcome.current.onCancel()
    }
    document.addEventListener('mousedown', onMouseDown)
    return () => document.removeEventListener('mousedown', onMouseDown)
  }, [open, busy, dropdownSurface])

  if (!open) return null

  /** Surface a failure where the operator can see it. The kernel owner's
   *  `onError` opens its folder-error modal; a standalone mount without that
   *  callback keeps the message inside the dropdown instead of going silent. */
  const reportFailure = (reason: unknown): void => {
    const message = reason instanceof Error ? reason.message : String(reason)
    const onError = outcome.current.onError
    if (typeof onError === 'function') {
      onError(message)
      return
    }
    setError(message)
  }

  /** Validate a chosen local path and hand it to the owner. Returns false
   *  after reporting the reason, so the caller can re-arm its own view. */
  const adoptLocalPath = (path: string): boolean => {
    // The kernel's session creation runs mkdir(cwd, { recursive: true }) and
    // treats EPERM as fatal, so a drive/share ROOT would become a workspace
    // whose "＋" can never open a session. Refuse it here with the reason
    // spelled out, instead of storing a broken workspace.
    const checked = checkLocalWorkspacePath(path)
    if (!checked.ok) {
      reportFailure(new Error(tt(
        checked.problem === 'filesystem-root' ? 'flow.rootPath'
          : checked.problem === 'not-absolute' ? 'flow.relativePath'
            : 'flow.emptyPath',
      )))
      return false
    }
    outcome.current.onPicked(checked.path)
    return true
  }

  /** Create through the same interactive connection gate browsing uses.
   *  Creation now canonicalizes the remote directory on the host (native
   *  `realpath` semantics), so a first-time password / host-key prompt must be
   *  answered once and the request retried; non-interactive failures surface
   *  unchanged. */
  const createSshRecord = async (input: {
    title: string
    alias: string
    remoteRoot: string
  }): Promise<SshWorkspaceRecord> => {
    const deps = latestProps.current
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        return await deps.createSshWorkspace(input)
      } catch (e: unknown) {
        const code = (e as { code?: string } | null)?.code
        const interactive = code === 'NEEDS_PASSWORD' || code === 'HOST_KEY_UNKNOWN' || code === 'HOST_KEY_MISMATCH'
        if (!interactive) throw e
        const connected = await deps.ensureConnected(input.alias)
        if (!connected) throw e
      }
    }
    throw new Error(tt('create.needConnect'))
  }

  /**
   * Choose "Local workspace": render the kernel's own flow occupant. The
   * composed surface owns the interaction (OS chooser vs in-app browser), so
   * the plugin never answers that question itself.
   */
  const pickLocal = (): void => {
    if (props.resolveLocalFlow() === undefined) {
      reportFailure(new Error(tt('flow.noNativePicker')))
      return
    }
    setChoice('local-native')
    setError(null)
  }

  /**
   * Choose "SSH workspace". The server is always asked for first (the native
   * Remote-SSH order): the SSH intent means "which host, then which directory",
   * and a chooser that only appears after cancelling the directory dialog is
   * surprising. With the kernel browse surface available the second step is
   * that dialog over SFTP; without it, the compact fallback form stays.
   */
  const pickSsh = (): void => {
    setError(null)
    setChoice('ssh')
  }

  /** Choose one server, pass the connection gate, then open the kernel browse
   *  dialog. Gating first keeps the trust/password prompts on top of our own
   *  dialog; opening the kernel browser first put them behind its native modal,
   *  which looked like a permanent "loading" state. */
  const pickServer = (alias: string): void => {
    remoteHome.current = undefined
    const request = ++serverGateRequestSequence.current
    setHost(alias)
    setError(null)
    setLoading(true)
    void (async () => {
      try {
        const connected = await props.ensureConnected(alias)
        if (request !== serverGateRequestSequence.current || !openRef.current) return
        if (connected) setChoice('ssh-dir')
      } catch (e: unknown) {
        if (request === serverGateRequestSequence.current && openRef.current) {
          setError(e instanceof Error ? e.message : String(e))
        }
      } finally {
        if (request === serverGateRequestSequence.current && openRef.current) setLoading(false)
      }
    })()
  }

  /** Create the SSH workspace at the picked remote directory; on success hand
   *  the anchor to the owner. The title follows the native workspace rule: the
   *  directory's basename (the host alias when the root itself is picked). */
  const createSshAt = async (remoteRoot: string): Promise<void> => {
    const request = ++createWorkspaceRequestSequence.current
    setCreating(true)
    setError(null)
    try {
      const alias = aliasRef.current
      const record = await createSshRecord({
        title: remoteWorkspaceTitle(remoteRoot, alias),
        alias,
        remoteRoot,
      })
      if (request !== createWorkspaceRequestSequence.current || !openRef.current) return
      outcome.current.onPicked(record.anchorPath)
    } catch (e: unknown) {
      if (request === createWorkspaceRequestSequence.current && openRef.current) {
        setError(e instanceof Error ? e.message : String(e))
      }
    } finally {
      if (request === createWorkspaceRequestSequence.current && openRef.current) setCreating(false)
    }
  }

  /** Browse a remote dir level for the SSH branch. When the connection needs
   *  a credential (host key untrusted / session password), run the interactive
   *  gate first, then retry — the operator never sees a raw "connect" error. */
  const browse = async (alias: string, path?: string): Promise<void> => {
    const request = ++directoryRequestSequence.current
    if (alias === '') {
      setError(tt('create.needHost'))
      return
    }
    setLoading(true)
    setError(null)
    try {
      // Same gate as pickServer: answer trust/password while THIS dialog is the
      // top layer. The retry loop below stays for a dropped connection.
      const connected = await props.ensureConnected(alias)
      if (request !== directoryRequestSequence.current || !openRef.current) return
      if (!connected) return
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          const result = await props.listRemoteDir(alias, path)
          if (request !== directoryRequestSequence.current || !openRef.current) return
          setDirPath(result.path)
          setDirEntries(result.entries)
          setChoice('browsing')
          return
        } catch (e: unknown) {
          if (request !== directoryRequestSequence.current || !openRef.current) return
          const code = (e as { code?: string })?.code
          const interactive = code === 'NEEDS_PASSWORD' || code === 'HOST_KEY_UNKNOWN' || code === 'HOST_KEY_MISMATCH'
          if (!interactive) {
            setError(e instanceof Error ? e.message : String(e))
            return
          }
          const connected = await props.ensureConnected(alias)
          if (request !== directoryRequestSequence.current || !openRef.current) return
          if (!connected) return // user cancelled
        }
      }
      if (request === directoryRequestSequence.current && openRef.current) setError(tt('create.needConnect'))
    } finally {
      if (request === directoryRequestSequence.current && openRef.current) setLoading(false)
    }
  }

  /** Create the SSH workspace; on success hand the anchor to the owner. */
  const createSsh = async (): Promise<void> => {
    if (host === '' || dirPath === '' || title.trim() === '') {
      setError(host === '' ? tt('create.needHost') : dirPath === '' ? tt('create.needDir') : tt('create.needTitle'))
      return
    }
    const request = ++createWorkspaceRequestSequence.current
    setCreating(true)
    setError(null)
    try {
      const record = await createSshRecord({ title: title.trim(), alias: host, remoteRoot: dirPath })
      if (request !== createWorkspaceRequestSequence.current || !openRef.current) return
      // The anchor is a REAL local dir (host workspace registration happens on
      // the server); adopt it so the host workspace list refreshes.
      outcome.current.onPicked(record.anchorPath)
    } catch (e: unknown) {
      if (request === createWorkspaceRequestSequence.current && openRef.current) {
        setError(e instanceof Error ? e.message : String(e))
      }
    } finally {
      // Always reset for the active opening: the owner may keep the flow open
      // after onPicked (e.g. a host-side adoption error).
      if (request === createWorkspaceRequestSequence.current && openRef.current) setCreating(false)
    }
  }

  /** Save a newly-added SSH host, refresh the list, select it, and close the
   *  add-server form. The password is OPTIONAL at creation — adding never
   *  connects; the credential is asked when browsing/connecting starts. */
  const saveHost = async (): Promise<void> => {
    if (newHost.alias.trim() === '' || newHost.host.trim() === '' || newHost.user.trim() === '') {
      setError(tt('host.needFields'))
      return
    }
    const request = ++createHostRequestSequence.current
    setSavingHost(true)
    setError(null)
    try {
      const created = await props.createHost({
        alias: newHost.alias.trim(),
        host: newHost.host.trim(),
        port: Number.parseInt(newHost.port, 10) || 22,
        user: newHost.user.trim(),
        auth: { kind: 'password', password: newHost.password },
      })
      if (request !== createHostRequestSequence.current || !openRef.current) return
      // 'none' storage deliberately does not persist the password, but this
      // session still needs it for the first browse: seed the in-memory table so
      // the operator is not asked to type the same password twice.
      if (newHost.password !== '') {
        await props.rememberSessionSecret(created.alias, newHost.password).catch(() => undefined)
      }
      const hostsRequest = ++hostsRequestSequence.current
      const list = await props.listHosts()
      if (
        request !== createHostRequestSequence.current
        || hostsRequest !== hostsRequestSequence.current
        || !openRef.current
      ) return
      setHosts(list)
      setHost(created.alias)
      setAddingHost(false)
      setNewHost({ alias: '', host: '', port: '22', user: '', password: '' })
    } catch (e: unknown) {
      if (request === createHostRequestSequence.current && openRef.current) {
        setError(e instanceof Error ? e.message : String(e))
      }
    } finally {
      if (request === createHostRequestSequence.current && openRef.current) setSavingHost(false)
    }
  }

  // Position the dropdown under the trigger, clamped inside the viewport.
  // The "add server" mini-form is taller — give it room so nothing clips.
  const menuWidth = choice === 'menu' ? 200 : 360
  const menuHeight = addingHost ? Math.min(560, window.innerHeight - 16) : 320
  const rawTop = anchor !== undefined ? anchor.bottom + 4 : 56
  const rawLeft = anchor !== undefined ? anchor.left : Math.max(8, window.innerWidth - menuWidth - 8)
  const top = Math.max(8, Math.min(rawTop, window.innerHeight - menuHeight - 8))
  const left = Math.max(8, Math.min(rawLeft, window.innerWidth - menuWidth - 8))
  // Never exceed the space actually available to the RIGHT of the anchor: a
  // trigger near the right edge (or a narrow window) shrinks the card instead of
  // letting its content overflow and be clipped.
  const width = Math.max(220, Math.min(menuWidth, window.innerWidth - left - 8))
  if (kernelBrowse && kernelFlow !== undefined && choice === 'ssh') {
    return (
      <>
        <SshServerPickerDialog
          hosts={hosts}
          busy={busy || creating || savingHost || loading}
          error={addingHost ? null : error}
          onPick={pickServer}
          onAddServer={() => {
            setError(null)
            setAddingHost(true)
          }}
          onCancel={() => outcome.current.onCancel()}
        />
        {addingHost && (
          <SshAddServerDialog
            form={newHost}
            busy={savingHost}
            error={error}
            onChange={(field, value) => setNewHost((previous) => ({ ...previous, [field]: value }))}
            onSave={() => { void saveHost() }}
            onCancel={() => {
              setAddingHost(false)
              setError(null)
            }}
          />
        )}
      </>
    )
  }

  if (kernelBrowse && kernelFlow !== undefined && choice === 'ssh-dir') {
    const NativeFlow = kernelFlow.component
    return (
      <>
        <NativeFlow
          {...kernelFlow.injected}
          open
          busy={creating}
          listDirectory={listRemoteLevel}
          createDirectory={createRemoteLevel}
          t={remoteTranslate}
          onPicked={(path: unknown) => {
            if (typeof path === 'string') void createSshAt(path)
          }}
          onCancel={() => outcome.current.onCancel()}
          onError={(message: unknown) => {
            setError(message instanceof Error ? message.message : String(message))
          }}
        />
        {error !== null && <div className={css.flowErrorToast} role="alert">{error}</div>}
      </>
    )
  }

  if (choice === 'local-native') {
    const handle = props.resolveLocalFlow()
    if (handle !== undefined) {
      const NativeFlow = handle.component
      return (
        <NativeFlow
          open
          busy={busy}
          onPicked={(path: unknown) => {
            if (typeof path !== 'string') return
            if (!adoptLocalPath(path)) setChoice('menu')
          }}
          onCancel={() => { outcome.current.onCancel() }}
          onError={(message: unknown) => {
            outcome.current.onError(message instanceof Error ? message.message : String(message))
          }}
          {...handle.injected}
        />
      )
    }
  }

  return createPortal(
    <div
      ref={menuRef}
      className={css.menuDropdown}
      data-ssh-workspace-flow-menu=""
      role="menu"
      style={{
        top,
        left,
        width,
        maxHeight: menuHeight,
        overflowY: 'auto',
      }}
      onClick={(event) => event.stopPropagation()}
    >
      {error !== null && <div className={css.dialogFail}>{error}</div>}

        {choice === 'menu' && (
          <>
            <button
              type="button"
              className={css.menuItem}
              role="menuitem"
              disabled={busy}
              onClick={pickLocal}
            >
              <span className={css.menuItemIcon}><ComputerIcon size={14} /></span>
              <span>{tt('flow.local')}</span>
            </button>
            <button
              type="button"
              className={css.menuItem}
              role="menuitem"
              disabled={busy}
              onClick={pickSsh}
            >
              <span className={css.menuItemIcon}><CloudIcon size={14} /></span>
              <span>{tt('flow.ssh')}</span>
            </button>
            <div className={css.menuDivider} />
            <button
              type="button"
              className={css.menuItem}
              role="menuitem"
              onClick={() => outcome.current.onCancel()}
            >
              <span>{tt('create.cancel')}</span>
            </button>
          </>
        )}

        {choice === 'ssh' && (
          <div className={css.dialogGrid}>
            {addingHost ? (
              <>
                <div style={{ gridColumn: '1 / -1', display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
                  <label className={css.field}>
                    <span>{tt('dialog.alias')}</span>
                    <input value={newHost.alias} onChange={(e) => setNewHost((p) => ({ ...p, alias: e.target.value }))} placeholder="my-server" spellCheck={false} />
                  </label>
                  <label className={css.field}>
                    <span>{tt('dialog.host')}</span>
                    <input value={newHost.host} onChange={(e) => setNewHost((p) => ({ ...p, host: e.target.value }))} placeholder="1.2.3.4" spellCheck={false} />
                  </label>
                  <label className={css.field}>
                    <span>{tt('dialog.port')}</span>
                    <input value={newHost.port} onChange={(e) => setNewHost((p) => ({ ...p, port: e.target.value }))} inputMode="numeric" spellCheck={false} />
                  </label>
                  <label className={css.field}>
                    <span>{tt('dialog.user')}</span>
                    <input value={newHost.user} onChange={(e) => setNewHost((p) => ({ ...p, user: e.target.value }))} placeholder="root" spellCheck={false} />
                  </label>
                  <label className={css.field} style={{ gridColumn: '1 / -1' }}>
                    <span>{tt('dialog.password')}</span>
                    <input type="password" value={newHost.password} onChange={(e) => setNewHost((p) => ({ ...p, password: e.target.value }))} spellCheck={false} />
                    <span className={css.hostMeta}>{tt('dialog.passwordHint')}</span>
                  </label>
                </div>
                <div className={css.dialogActions} style={{ gridColumn: '1 / -1' }}>
                  <button type="button" className={css.button} onClick={() => setAddingHost(false)} disabled={savingHost}>{tt('create.cancel')}</button>
                  <button type="button" className={`${css.button} ${css.buttonPrimary}`} onClick={() => void saveHost()} disabled={savingHost}>
                    {savingHost ? tt('create.connecting') : tt('host.save')}
                  </button>
                </div>
              </>
            ) : (
              <>
                <label className={css.field} style={{ gridColumn: '1 / -1' }}>
                  <span>{tt('create.host')}</span>
                  <select value={host} disabled={loading} onChange={(event) => setHost(event.target.value)}>
                    <option value="">{hosts.length === 0 ? tt('create.hostEmpty') : '—'}</option>
                    {hosts.map((item) => (
                      <option key={item.alias} value={item.alias}>{item.alias} ({item.user}@{item.host}:{item.port})</option>
                    ))}
                  </select>
                </label>
                <button
                  type="button"
                  className={css.menuItem}
                  style={{ gridColumn: '1 / -1', padding: '5px 8px' }}
                  disabled={loading}
                  onClick={() => setAddingHost(true)}
                >
                  <span className={css.menuItemIcon}>＋</span>
                  <span>{tt('host.add')}</span>
                </button>
                <label className={css.field} style={{ gridColumn: '1 / -1' }}>
                  <span>{tt('create.dir')}</span>
                  <input value={dirPath} disabled={loading} onChange={(event) => setDirPath(event.target.value)} placeholder={tt('create.dirPlaceholder')} spellCheck={false} />
                </label>
                <div className={css.dialogActions} style={{ gridColumn: '1 / -1' }}>
                  <button type="button" className={css.button} disabled={busy || loading} onClick={() => void browse(host)}>
                    {loading ? tt('create.connecting') : tt('create.browse')}
                  </button>
                </div>
                <label className={css.field} style={{ gridColumn: '1 / -1' }}>
                  <span>{tt('create.titleLabel')}</span>
                  <input value={title} onChange={(event) => setTitle(event.target.value)} placeholder={tt('create.titlePlaceholder')} spellCheck={false} />
                </label>
              </>
            )}
            {!addingHost && (
              <div className={css.dialogActions} style={{ gridColumn: '1 / -1' }}>
                <button type="button" className={css.button} onClick={() => setChoice('menu')} disabled={busy || creating || loading}>{tt('create.cancel')}</button>
                <button type="button" className={`${css.button} ${css.buttonPrimary}`} disabled={busy || creating || loading} onClick={() => void createSsh()}>
                  {creating ? tt('create.connecting') : tt('create.submit')}
                </button>
              </div>
            )}
          </div>
        )}

        {choice === 'browsing' && (
          <div className={css.dialogGrid} style={{ gridTemplateColumns: '1fr' }}>
            <div className={css.field} style={{ gridColumn: '1' }}>
              <span>
                {tt('create.browse')} · <span className={css.ellipsis} title={host}>{host}</span>
              </span>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                <button
                  type="button"
                  className={css.button}
                  disabled={loading || dirPath === '/'}
                  onClick={() => {
                    const parent = dirPath.split('/').slice(0, -1).join('/') || '/'
                    void browse(host, parent)
                  }}
                >
                  {tt('create.up')}
                </button>
                <span className={css.hostMeta} style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis' }}>{tt('create.current')}{dirPath}</span>
              </div>
            </div>
            <div style={{ gridColumn: '1', maxHeight: 240, overflow: 'auto', border: '1px solid var(--aion-border, rgba(128,128,128,0.25))', borderRadius: 8, padding: 6 }}>
              {loading && <div className={css.dialogInfo}>{tt('create.connecting')}</div>}
              {dirEntries.filter((entry) => entry.type === 'dir').map((entry) => (
                <button
                  key={entry.name}
                  type="button"
                  className={css.hostRow}
                  disabled={loading}
                  style={{ width: '100%', textAlign: 'left', display: 'flex', gap: 6, alignItems: 'center', border: 'none', background: 'transparent', cursor: loading ? 'default' : 'pointer', padding: '4px 6px' }}
                  onClick={() => { void browse(host, `${dirPath.replace(/\/+$/, '')}/${entry.name}`) }}
                >
                  <span>📁</span>
                  <span className={css.hostAlias}>{entry.name}</span>
                </button>
              ))}
            </div>
            <div className={css.dialogActions} style={{ gridColumn: '1' }}>
              <button type="button" className={css.button} disabled={loading} onClick={() => setChoice('ssh')}>{tt('create.cancel')}</button>
              <button type="button" className={`${css.button} ${css.buttonPrimary}`} disabled={loading} onClick={() => setChoice('ssh')}>
                {tt('flow.useThisDir')}
              </button>
            </div>
          </div>
        )}
    </div>,
    document.body,
  )
}