/**
 * Browser-half entry for the dsh-hardssh plugin — runs inside the dsh
 * web GUI. Registers a session-header utility (SSH workspace manager, left
 * of the session log) that lists SSH-bound workspaces, creates new ones
 * (host + remote directory picker) and deletes them. The execution-world
 * routing itself is HOST-side: a session whose cwd is the anchor path of an
 * SSH workspace routes its fs/subprocess calls remote; every other session
 * stays local. There is no global local⇄remote toggle anymore.
 * Failure policy: every DOM wiring problem is logged, never thrown — the
 * web shell fails the whole boot when a plugin apply throws.
 */
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
// Type-only: pulls the conversation SlotMap augmentation (the utilities slot).
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
// Type-only: pulls the SlotMap augmentation for the two directory-flow holes.
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client'
import type {} from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import { WorkspaceApi } from './api.ts'
import { SshApi } from './ssh/api.ts'
import { currentSessionIdOf, sessionListShapeUnsupported, type SessionListSnapshotLike } from './session-list-current.ts'
import { NS, dictionaries, type WorkspaceKey } from './locales.ts'
import { WorkspaceManager } from './state.ts'
import { setLanguage, tt } from './text.ts'
import { registerWorkspacePanel } from './workspace-panel-entry.tsx'
import { DirectoryFlow, type NativeDirectoryFlowHandle } from './directory-flow.tsx'
import { connectHost, subscribeConnectState } from './connect-host.ts'
import { badgeBindings, mountWorkspaceBadges, type NativeWorkspacesLike } from './workspace-badges.ts'
import { mountWorkspaceFilesPathRemap } from './workspace-files-path.ts'
import { makeAnchorAliasResolver, mountSessionConnectGate, type SessionGateList } from './session-connect-gate.ts'
import { mountSshOperations } from './ssh/apply.ts'
import { createSessionSshTargetSource } from './ssh/session-target.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** dsh-hardssh surface copy. */
    'dsh-hardssh': WorkspaceKey
  }
}

// Type-only re-exports of the SSH operations surfaces (merge phase 2).
export type { SshPanelProps } from './ssh/panel/SshPanel.tsx'
export type { HostFormDialogProps } from './ssh/panel/HostFormDialog.tsx'
export type { TerminalTabProps } from './ssh/panel/TerminalTab.tsx'
export type { TransferTabProps } from './ssh/panel/TransferTab.tsx'
export type { TunnelsTabProps } from './ssh/panel/TunnelsTab.tsx'
export type { ClusterTabProps } from './ssh/panel/ClusterTab.tsx'
export type { SshKey } from './ssh/locales.ts'

/** Required services: slots for the extension seats, locale for copy,
 *  sessions for the open/new-session connection gate, and sidebarRightTabs
 *  for the SSH operations console type. Keep the registry explicit: without
 *  it Cordis may activate this client before a provider offers the service;
 *  the guarded registration then degrades silently and no HardSSH surface
 *  exists. */
export const inject = ['slots', 'locale', 'sessions', 'sidebarRightTabs', 'workspaces']

/** The kernel's directory-flow registrations, as the slot ledger exposes them. */
interface LedgerEntry {
  component: unknown
  inject?: () => Record<string, unknown>
}

/**
 * Read the kernel's own directory-flow occupant registered on one hole.
 *
 * The registry keeps every registration, including the one our own occupant
 * shadows: `entries` is the ledger view, not the render winners. Our entry is
 * the one carrying this module's `DirectoryFlow` component, so the first
 * other entry is the composed kernel surface (native chooser or in-app
 * browser), reused verbatim.
 * @param ctx - client root context carrying the slot registry.
 * @param hole - directory-flow hole name.
 * @returns the reusable handle, or undefined when no kernel occupant exists.
 */
function readNativeDirectoryFlow(
  ctx: ClientContext,
  hole: 'conversation.hero.workspace.directoryFlow' | 'sidebar.workspaces.directoryFlow',
): NativeDirectoryFlowHandle | undefined {
  let entries: readonly unknown[] = []
  try {
    entries = ctx.slots.entries(hole) as readonly unknown[]
  } catch {
    return undefined
  }
  const native = (entries as readonly LedgerEntry[]).find((entry) => entry.component !== DirectoryFlow)
  if (native === undefined) return undefined
  if (typeof native.component !== 'function') return undefined
  let injected: Record<string, unknown> = {}
  try {
    injected = typeof native.inject === 'function' ? native.inject() : {}
  } catch {
    return undefined
  }
  return { component: native.component as NativeDirectoryFlowHandle['component'], injected }
}

/**
 * Mount the directory-flow occupant on both `single` seats.
 *
 * Mirror the native picker's registration shape exactly: nested
 * `inject(hero) -> inject(sidebar) -> generator`, so the declarations are
 * re-checked each activation and our occupant lands once ui-workspace is
 * live. A negative priority beats the kernel occupant (priority 0) under the
 * single-slot "lowest wins" rule; the local branch then renders that kernel
 * occupant by reference.
 */
function registerDirectoryFlow(ctx: ClientContext, deps: { api: WorkspaceApi; sshApi: SshApi }): void {
  const flowInject = (
    hole: 'conversation.hero.workspace.directoryFlow' | 'sidebar.workspaces.directoryFlow',
  ): (() => Record<string, unknown>) => () => ({
    resolveLocalFlow: () => readNativeDirectoryFlow(ctx, hole),
    createSshWorkspace: (input: { title: string; alias: string; remoteRoot: string }) => deps.api.createWorkspace(input),
    listHosts: () => deps.sshApi.listHosts(),
    createHost: (input: {
      alias: string
      host: string
      port?: number
      user: string
      auth: { kind: 'password'; password: string } | { kind: 'key'; keyPath: string; passphrase?: string }
    }) => deps.sshApi.createHost(input),
    listRemoteDir: (alias: string, path?: string) => deps.api.listRemoteDir(alias, path),
    createRemoteDir: (alias: string, path: string, name: string) => deps.api.createRemoteDir(alias, path, name),
    ensureConnected: (alias: string) => connectHost(deps.sshApi, alias),
  })
  ctx.slots.inject('conversation.hero.workspace.directoryFlow', () => ctx.slots.inject('sidebar.workspaces.directoryFlow', function* () {
    yield (ctx.slots.register as unknown as (options: {
      name: 'conversation.hero.workspace.directoryFlow'
      priority?: number
      inject: () => Record<string, unknown>
    }, component: unknown) => () => void)(
      { name: 'conversation.hero.workspace.directoryFlow', priority: -1, inject: flowInject('conversation.hero.workspace.directoryFlow') },
      DirectoryFlow,
    )
    yield (ctx.slots.register as unknown as (options: {
      name: 'sidebar.workspaces.directoryFlow'
      priority?: number
      inject: () => Record<string, unknown>
    }, component: unknown) => () => void)(
      { name: 'sidebar.workspaces.directoryFlow', priority: -1, inject: flowInject('sidebar.workspaces.directoryFlow') },
      DirectoryFlow,
    )
  }))
}

/** Apply the browser half. */
export function apply(ctx: ClientContext): void {
  const api = new WorkspaceApi()
  const sshApi = new SshApi()
  const manager = new WorkspaceManager(api)
  // Native client workspace state: the source of row identity. A sidebar row's
  // `data-row-key` carries the native workspace id, and the native registry
  // owns the canonical path — titles are display-only and may repeat.
  const nativeWorkspaces = ctx.get('workspaces') as unknown as NativeWorkspacesLike | undefined
  const sessionList = ctx.sessions.list
  let warnedSessionListShape = false
  const sessions: SessionGateList = {
    subscribe: (listener) => sessionList.subscribe(listener),
    phase: () => sessionList.getSnapshot().phase,
    // 0.2.0 removed the list state's single `current`; the displayed Session is
    // now the row the main view retains. See ./session-list-current.ts.
    currentSessionId: () => {
      const snapshot = sessionList.getSnapshot() as unknown as SessionListSnapshotLike
      if (!warnedSessionListShape && sessionListShapeUnsupported(snapshot)) {
        warnedSessionListShape = true
        console.warn('[dsh-hardssh] the client session list matches neither the pre-0.2.0 nor the 0.2.0 shape — the SSH console and its connection prompt cannot follow the open session on this dsh version')
      }
      return currentSessionIdOf(snapshot)
    },
    sessionIds: () => sessionList.getSnapshot().ids,
    sessionCwd: (id) => {
      const byId = sessionList.getSnapshot().byId as unknown as
        Record<string, { cwd?: string } | undefined>
      return byId[id]?.cwd
    },
  }

  // The operations console inherits its ONLY target from the selected Session's
  // workspace. A local Session resolves to null and the panel renders disabled;
  // individual operation tabs never own a host picker.
  mountSshOperations(ctx, sshApi, createSessionSshTargetSource(sessions, manager))

  ctx.effect(() => ctx.locale.register(NS, dictionaries), 'dsh-hardssh: dictionaries')

  const disposers: Array<() => void> = []
  try {
    // The SSH workspace manager is a GLOBAL surface: a left-sidebar entry row
    // (sidebar.panellist) opening a center panel (main). The shell owns the
    // row, its label and its active highlight; selecting it switches the
    // center column, and selecting the Conversation row switches back.
    registerWorkspacePanel(ctx, { manager, sshApi })

    registerDirectoryFlow(ctx, { api, sshApi })

    manager.start()

    // Sidebar row decoration: label the host workspace rows that BIND to an
    // SSH workspace (canonical anchor path → native workspace id) with a compact
    // `alias` badge, tinted by whether the server currently holds a pooled
    // connection. Titles are display-only natively and may repeat, so a
    // same-named local workspace is never decorated. The shell still exposes no
    // row-decoration slot, so this stays the documented DOM extension it always
    // was (MutationObserver self-heal), unlike the session list below.
    let badgesDispose: (() => void) | undefined
    let filesPathDispose: (() => void) | undefined
    let connectedAliases: ReadonlySet<string> = new Set<string>()
    let connectingAliases: ReadonlySet<string> = new Set<string>()
    const refreshBadges = (): void => {
      try {
        const workspaces = manager.getSnapshot().workspaces
        const nativeRows = nativeWorkspaces?.list.getSnapshot().items ?? []
        badgesDispose?.()
        badgesDispose = mountWorkspaceBadges(
          workspaces,
          badgeBindings(nativeRows, workspaces),
          connectedAliases,
          connectingAliases,
        )
        // The native file panel's address (anchor) is rewritten to the remote
        // root by the same workspace state (P1/UX-1).
        filesPathDispose?.()
        filesPathDispose = mountWorkspaceFilesPathRemap(workspaces.map((workspace) => ({
          anchorPath: workspace.anchorPath,
          remoteRoot: workspace.remoteRoot,
        })))
      } catch (error) {
        console.warn('[dsh-hardssh] badge refresh failed:', error)
      }
    }
    disposers.push(() => { badgesDispose?.(); filesPathDispose?.() })
    // Same-source sync: no independent workspace fetch — the manager emits on
    // its 3s poll and on create/remove/rename.
    disposers.push(manager.subscribe(() => { refreshBadges() }))
    // Native workspace rows arrive/rename/delete through their own store; the
    // anchor path → workspace id binding must refresh with it.
    if (nativeWorkspaces !== undefined) {
      disposers.push(nativeWorkspaces.list.subscribe(() => { refreshBadges() }))
    }

    // Connecting-state feed: while `connectHost` probes/prompts an alias the
    // sidebar badge shows the spinner; on settle (success or failure) it flips
    // back. Wrong-password / rejected connections re-open the password dialog
    // with the SSH reason inside connectHost itself.
    disposers.push(subscribeConnectState((alias, state) => {
      const next = new Set(connectingAliases)
      if (state === 'connecting') next.add(alias)
      else next.delete(alias)
      connectingAliases = next
      refreshBadges()
    }))

    // Connection-state poll: badge colors AND the gate's pass cache both key off
    // "which servers have a live pooled transport right now".
    const refreshConnections = async (): Promise<void> => {
      try {
        connectedAliases = new Set(await sshApi.connectedAliases())
      } catch (error) {
        console.warn('[dsh-hardssh] connection-state poll failed:', error)
        connectedAliases = new Set<string>()
      }
      refreshBadges()
    }
    const connTimer = window.setInterval(() => { void refreshConnections() }, 3000)
    disposers.push(() => { window.clearInterval(connTimer) })
    void refreshConnections()

    // Session-open connection gate: opening a session (or creating a New
    // Session) inside an SSH workspace probes the owning server first, so the
    // fingerprint / session-password dialogs appear before any remote operation
    // fails. Driven by the public session list — not by DOM rows — so it
    // survives any sidebar restyle.
    disposers.push(mountSessionConnectGate({
      sessions,
      aliasForCwd: makeAnchorAliasResolver(() => manager.getSnapshot().workspaces),
      ensureConnected: (alias) => connectHost(sshApi, alias),
    }))
  } catch (error) {
    console.warn('[dsh-hardssh] mount failed:', error)
  }

  // Language mirroring (the shell owns <html lang>; the dictionary follows).
  const syncLanguage = (): void => {
    setLanguage(document.documentElement.lang?.startsWith('zh') ?? false)
  }
  const langObserver = new MutationObserver(syncLanguage)
  langObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['lang'] })
  syncLanguage()

  ctx.effect(() => () => {
    manager.stop()
    langObserver.disconnect()
    for (const dispose of disposers.splice(0)) dispose()
  }, 'dsh-hardssh: wiring')
}