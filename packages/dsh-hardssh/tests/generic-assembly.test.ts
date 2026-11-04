/**
 * Phase 4+5+7 assembly tests for the single production runtime:
 * 1. the generic startup migration is idempotent and aborts on same-id
 *    conflicts, a corrupt generic ledger fails closed (no silent local
 *    fallback) — at the boot gate AND at the fs seam,
 * 2. the generic fs + subprocess seams resolve the same cwd to the same
 *    workspace connection, fail closed for unowned anchors and after a
 *    removed workspace, and stay local for everything else (fake engine only),
 * 3. the unready-routing gate refuses an anchor-root cwd (B-01).
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname, sep } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { FileSystem } from '@deepseek-ai/dsh-fs'
import type { SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import { WorkspaceLedger } from '../src/base/ledger.ts'
import { WorkspaceProviderRegistry } from '../src/base/registry.ts'
import { DefaultWorkspaceCore, type WorkspaceCore } from '../src/runtime/workspace-core.ts'
import type { WorkspaceRecord } from '../src/base/model.ts'
import { createSshWorkspaceProvider } from '../src/providers/ssh/provider.ts'
import { createLocalWorkspaceProvider, RootedLocalFileSystem, RootedLocalSubprocessRuntime } from '../src/providers/local/provider.ts'
import { WFS_NAMESPACE_MARKER, SwitchFileSystem } from '../src/switch/switch-fs.ts'
import { SwitchSubprocessRuntime } from '../src/switch/switch-subprocess.ts'
import { anchorWorldFor, genericFsWorldFor, genericFsWorldForNamespace } from '../src/fs.ts'
import { genericRemoteCwdFor, genericSubprocessFor } from '../src/subprocess.ts'
import { GenericWorkspaceStore } from '../src/backend.ts'
import { bootstrapGenericWorkspaceCore } from '../src/index.ts'
import { FakeEngine, asSshEngine } from './providers/fake-ssh-engine.ts'
import type { SshWorkspaceRecord } from '../src/protocol.ts'

/** Project one SSH workspace fixture into a generic ledger record (what a
 *  cutover-era record looks like on disk). */
function toWorkspaceRecord(record: SshWorkspaceRecord): WorkspaceRecord {
  return {
    schemaVersion: 1,
    id: record.id,
    title: record.title,
    provider: { id: 'ssh', connectionRef: { id: record.alias, alias: record.alias } },
    location: { kind: 'posix', root: record.remoteRoot },
    anchor: { path: record.anchorPath, mode: 'managed' },
    createdAt: record.createdAt,
    updatedAt: record.createdAt,
  }
}

function makeCore(genericPath: string, sshAnchorRoot: string): DefaultWorkspaceCore {
  const providers = new WorkspaceProviderRegistry()
  providers.register(createSshWorkspaceProvider(asSshEngine(new FakeEngine()), new Context()))
  return new DefaultWorkspaceCore(new WorkspaceLedger(genericPath, sshAnchorRoot), providers)
}

describe('generic startup (ledger recovery + initialize)', () => {
  it('initializes a fresh ledger and keeps records across a restart', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'generic-boot-fresh-'))
    const genericPath = join(dir, 'index.json')
    const anchorRoot = join(dir, 'ssh-anchors')
    mkdirSync(anchorRoot, { recursive: true })

    const core = makeCore(genericPath, anchorRoot)
    await bootstrapGenericWorkspaceCore(core, { genericPath })
    expect(core.isReady()).toBe(true)
    await core.create({
      schemaVersion: 1,
      id: 'kept',
      title: 'proj',
      provider: { id: 'ssh', connectionRef: { id: 'host', alias: 'host' } },
      location: { kind: 'posix', root: '/srv/app' },
      anchor: { path: join(anchorRoot, 'kept'), mode: 'managed' },
    })
    await core.closeAll()

    const restarted = makeCore(genericPath, anchorRoot)
    await bootstrapGenericWorkspaceCore(restarted, { genericPath })
    expect(restarted.isReady()).toBe(true)
    expect((await restarted.list()).map(record => record.id)).toEqual(['kept'])
    await restarted.closeAll()
  })

  it('restores a corrupt ledger from the .last-good snapshot', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'generic-boot-recover-'))
    const genericPath = join(dir, 'index.json')
    const anchorRoot = join(dir, 'ssh-anchors')
    mkdirSync(anchorRoot, { recursive: true })

    const first = makeCore(genericPath, anchorRoot)
    await bootstrapGenericWorkspaceCore(first, { genericPath })
    await first.create({
      schemaVersion: 1,
      id: 'recovered',
      title: 'proj',
      provider: { id: 'ssh', connectionRef: { id: 'host', alias: 'host' } },
      location: { kind: 'posix', root: '/srv/app' },
      anchor: { path: join(anchorRoot, 'recovered'), mode: 'managed' },
    })
    await first.closeAll()
    // Every ledger save also writes the rolling `.last-good` snapshot.
    expect(existsSync(`${genericPath}.last-good`)).toBe(true)
    writeFileSync(genericPath, '{broken', 'utf8')

    const restarted = makeCore(genericPath, anchorRoot)
    await bootstrapGenericWorkspaceCore(restarted, { genericPath })
    expect(restarted.isReady()).toBe(true)
    expect((await restarted.list()).map(record => record.id)).toEqual(['recovered'])
    await restarted.closeAll()
  })

  it('fails closed on a corrupt ledger with no recovery source: boot rejects and the store/fs seam refuse', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'generic-boot-corrupt-'))
    const genericPath = join(dir, 'index.json')
    writeFileSync(genericPath, '{broken', 'utf8')
    const before = readFileSync(genericPath, 'utf8')
    const sshAnchorRoot = join(dir, 'ssh-anchors')
    mkdirSync(sshAnchorRoot, { recursive: true })
    // A plausible existing anchor under the reserved root, so we can prove a
    // cwd there is refused (never routed to the local host).
    const anchor = join(sshAnchorRoot, 'ws-1')
    mkdirSync(anchor, { recursive: true })

    const core = makeCore(genericPath, sshAnchorRoot)
    const boot = bootstrapGenericWorkspaceCore(core, { genericPath })
    await expect(boot).rejects.toThrow()
    expect(core.isReady()).toBe(false)
    // The corrupt file is never overwritten with an empty ledger.
    expect(readFileSync(genericPath, 'utf8')).toBe(before)

    // The workspace store (routes/tools) fails closed through its gate.
    const store = new GenericWorkspaceStore(core, boot, sshAnchorRoot)
    await expect(store.list()).rejects.toThrow()

    // The fs seam fails closed for a cwd under the reserved anchor root while
    // the core is unready — a silent local fallback here would operate a bound
    // remote workspace's files on the host.
    expect(() => genericFsWorldFor(core, anchor, [sshAnchorRoot])).toThrow(/not ready/)
  })
})

describe('generic boot recovery (current ledger format)', () => {
  it('recovers from the newest .backup- snapshot when the ledger and .last-good are both gone', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'generic-boot-backup-'))
    const genericPath = join(dir, 'index.json')
    const anchorRoot = join(dir, 'ssh-anchors')
    mkdirSync(anchorRoot, { recursive: true })

    const first = makeCore(genericPath, anchorRoot)
    await bootstrapGenericWorkspaceCore(first, { genericPath })
    await first.create({
      schemaVersion: 1,
      id: 'from-backup',
      title: 'proj',
      provider: { id: 'ssh', connectionRef: { id: 'host', alias: 'host' } },
      location: { kind: 'posix', root: '/srv/app' },
      anchor: { path: join(anchorRoot, 'from-backup'), mode: 'managed' },
    })
    await first.closeAll()
    const ledger = readFileSync(genericPath, 'utf8')
    rmSync(genericPath)
    rmSync(`${genericPath}.last-good`, { force: true })
    writeFileSync(`${genericPath}.backup-2026-01-01T00-00-00-000Z`, ledger, 'utf8')

    const restarted = makeCore(genericPath, anchorRoot)
    await bootstrapGenericWorkspaceCore(restarted, { genericPath })
    expect(restarted.isReady()).toBe(true)
    expect((await restarted.list()).map(record => record.id)).toEqual(['from-backup'])
    await restarted.closeAll()
  })

  it('keeps an existing but EMPTY ledger authoritative (deleting every workspace is a real intent)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'generic-boot-empty-'))
    const genericPath = join(dir, 'index.json')
    const anchorRoot = join(dir, 'ssh-anchors')
    mkdirSync(anchorRoot, { recursive: true })
    writeFileSync(genericPath, '[]', 'utf8')

    const core = makeCore(genericPath, anchorRoot)
    await expect(bootstrapGenericWorkspaceCore(core, { genericPath })).resolves.toBeUndefined()
    expect(core.isReady()).toBe(true)
    expect(await core.list()).toEqual([])
    await core.closeAll()
  })
})

describe('GenericWorkspaceStore provider boundary', () => {
  it('does not rename or remove a non-SSH workspace id', async () => {
    const localRecord: WorkspaceRecord = {
      schemaVersion: 1,
      id: 'local-1',
      title: 'local project',
      provider: { id: 'local' },
      location: { kind: 'native', root: 'C:\\repo' },
      anchor: { path: 'C:\\repo', mode: 'existing' },
      createdAt: '2025-01-01T00:00:00.000Z',
      updatedAt: '2025-01-01T00:00:00.000Z',
    }
    const get = vi.fn(async () => localRecord)
    const update = vi.fn(async () => localRecord)
    const remove = vi.fn(async () => true)
    const core = { get, update, remove } as unknown as WorkspaceCore
    const store = new GenericWorkspaceStore(core, Promise.resolve(), 'C:\\anchors')

    await expect(store.rename(localRecord.id, 'must not change')).resolves.toBeUndefined()
    await expect(store.remove(localRecord.id)).resolves.toBe(false)
    expect(get).toHaveBeenCalledTimes(2)
    expect(update).not.toHaveBeenCalled()
    expect(remove).not.toHaveBeenCalled()
  })
})

/** Build a generic core over one ssh record + a fake engine (the shape the
 *  generic assembly produces after a successful migration + initialize). */
async function makeGenericCore(dir: string, record: SshWorkspaceRecord): Promise<{
  core: DefaultWorkspaceCore
  fake: FakeEngine
  ctx: Context
}> {
  const genericPath = join(dir, 'index.json')
  writeFileSync(genericPath, JSON.stringify([toWorkspaceRecord(record)]), 'utf8')
  const ctx = new Context()
  const fake = new FakeEngine()
  const providers = new WorkspaceProviderRegistry()
  providers.register(createSshWorkspaceProvider(asSshEngine(fake), ctx))
  const core = new DefaultWorkspaceCore(new WorkspaceLedger(genericPath, dir), providers)
  await core.initialize()
  return { core, fake, ctx }
}

describe('generic fs/subprocess seams (fake engine)', () => {
  it('routes the same cwd to the same connection for fs and subprocess', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'generic-seam-'))
    const anchor = join(dir, 'ssh-anchor')
    mkdirSync(anchor, { recursive: true })
    const record: SshWorkspaceRecord = {
      id: 'ws-1', title: 'proj', alias: 'host', remoteRoot: '/srv/app', anchorPath: anchor, createdAt: '2025-01-01T00:00:00.000Z',
    }

    // Generic core + its own fake engine.
    const generic = await makeGenericCore(dir, record)
    generic.fake.seedFile('/srv/app/app.txt', 'hello remote')
    const connection = generic.core.router.fromAnchor(anchor)
    expect(connection?.workspaceId).toBe('ws-1')

    // fs + subprocess for the SAME cwd resolve through the SAME connection:
    // both come from core.router.fromAnchor, so they can never disagree.
    const fsWorld = genericFsWorldFor(generic.core, anchor, [dir])
    expect(fsWorld?.namespace).toBe(`${WFS_NAMESPACE_MARKER}ws-1/`)
    expect(fsWorld?.anchorPath).toBe(anchor)
    expect(fsWorld?.remoteRoot).toBe('/srv/app')
    expect(fsWorld?.backend).toBe(connection?.get('workspace.fs'))
    const processRuntime = genericSubprocessFor(generic.core, anchor, [dir])
    expect(processRuntime).toBe(connection?.get('workspace.process'))
    // Unbound cwds stay local (undefined) and never hit the connection.
    expect(genericFsWorldFor(generic.core, join(dir, 'unrelated'), [dir])).toBeUndefined()
    expect(genericSubprocessFor(generic.core, join(dir, 'unrelated'), [dir])).toBeUndefined()

    // Local backends spy on resolve/spawn so we can prove nothing local ran.
    const localFs = { resolve: vi.fn(async (path: string) => ({ targetKey: `local:${path}`, displayPath: path })) } as unknown as FileSystem
    const genericFacade = new SwitchFileSystem(new Context(), {
      local: localFs,
      worldFor: (cwd) => genericFsWorldFor(generic.core, cwd, [dir]) ?? { backend: localFs, namespace: '' },
      worldForNamespace: (namespace) => genericFsWorldForNamespace(generic.core, namespace),
    })

    const genericTarget = await genericFacade.resolve('app.txt', { cwd: anchor })
    const genericText = await genericFacade.readText(genericTarget)
    expect(genericText).toBe('hello remote')
    expect(localFs.resolve).not.toHaveBeenCalled()
    // The remote file resolves to its canonical remote path under the wfs namespace.
    expect(String(genericTarget.targetKey)).toBe(`${WFS_NAMESPACE_MARKER}ws-1//srv/app/app.txt`)

    // Subprocess: spawn from the bound cwd reaches the REMOTE engine, cd-ing
    // into the remote root; an unbound cwd falls back to the local runtime.
    const localSpawn = vi.fn(() => ({ pid: 1 }) as never)
    const localSub = { spawn: localSpawn, spawnTerminal: vi.fn() } as unknown as SubprocessRuntime
    const genericSub = new SwitchSubprocessRuntime(new Context(), {
      local: localSub,
      worldFor: (cwd) => genericSubprocessFor(generic.core, cwd, [dir]),
      // Wired exactly like src/subprocess.ts apply(): a remote runtime must get
      // the workspace's remote root, not this machine's anchor (see the seam's
      // `remoteCwd` contract). Without it the seam is only correct on Windows,
      // where the anchor is not a POSIX path.
      remoteCwd: (cwd) => (cwd === undefined ? undefined : genericRemoteCwdFor(generic.core, cwd)),
    })

    const spec = (cwd: string) => ({ argv: ['bash', '-lc', 'echo hi'], cwd, stdio: { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' }, graceMs: 60_000 })
    const genericHandle = genericSub.spawn(spec(anchor))
    genericSub.spawn(spec(join(dir, 'other')))
    expect(localSpawn).toHaveBeenCalledTimes(1)

    await vi.waitFor(() => expect(generic.fake.liveExec).toHaveLength(1))
    expect(generic.fake.liveExec[0]!.command).toContain(`cd -- '/srv/app' && exec env -i`)

    for (const session of generic.fake.liveExec) session.signal('KILL')
    await (genericHandle as unknown as { waitForExit(): Promise<boolean> }).waitForExit()

    await generic.core.closeAll()
  })

  it('fails closed for a removed workspace instead of falling back to local', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'generic-seam-removed-'))
    const anchor = join(dir, 'ssh-anchor')
    mkdirSync(anchor, { recursive: true })
    const record: SshWorkspaceRecord = {
      id: 'ws-1', title: 'proj', alias: 'host', remoteRoot: '/srv/app', anchorPath: anchor, createdAt: '2025-01-01T00:00:00.000Z',
    }
    const generic = await makeGenericCore(dir, record)
    generic.fake.seedFile('/srv/app/app.txt', 'hello remote')

    const namespace = `${WFS_NAMESPACE_MARKER}ws-1/`
    expect(genericFsWorldFor(generic.core, anchor, [dir])?.remoteRoot).toBe('/srv/app')
    expect(genericFsWorldForNamespace(generic.core, namespace)?.remoteRoot).toBe('/srv/app')

    // The router drops a removed workspace synchronously, so the same cwd and
    // the stale target key resolve to NOTHING (never to the local backend).
    await generic.core.remove('ws-1')
    expect(generic.core.router.fromAnchor(anchor)).toBeUndefined()
    expect(genericFsWorldFor(generic.core, anchor, [dir])).toBeUndefined()
    expect(genericSubprocessFor(generic.core, anchor, [dir])).toBeUndefined()
    expect(genericFsWorldForNamespace(generic.core, namespace)).toBeUndefined()

    // Deleting the anchor directory must not make the seam read anything local:
    // the deployment facade owns that fail-closed rule.
    rmSync(anchor, { recursive: true, force: true })
    expect(genericFsWorldFor(generic.core, anchor, [dir])).toBeUndefined()

    await generic.core.closeAll()
  })
})

describe('anchor-window probes answer NOT FOUND (regression: a run aborted with fs-ssh … fail closed)', () => {
  it('lets the project-root walk step over the anchor root instead of killing the run', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'anchor-window-'))
    // The managed anchor root, with ONE workspace anchor inside it.
    const anchorRootDir = join(dir, 'ssh-workspaces')
    const anchor = join(anchorRootDir, '2b0f-uuid')
    mkdirSync(anchor, { recursive: true })
    const record: SshWorkspaceRecord = {
      id: 'ws-1', title: 'enhancement', alias: 'host', remoteRoot: '/srv/app', anchorPath: anchor, createdAt: '2025-01-01T00:00:00.000Z',
    }
    const generic = await makeGenericCore(dir, record)

    const localFs = {
      resolve: vi.fn(async (path: string) => ({ targetKey: path, displayPath: path })),
      stat: vi.fn(async () => undefined),
    } as unknown as FileSystem
    const facade = new SwitchFileSystem(new Context(), {
      local: localFs,
      worldForAnchorPath: (path) => anchorWorldFor(generic.core, [anchorRootDir], path),
      worldFor: (cwd) => genericFsWorldFor(generic.core, cwd, [anchorRootDir]) ?? { backend: localFs, namespace: '' },
      worldForNamespace: (namespace) => genericFsWorldForNamespace(generic.core, namespace),
    })

    // 1. An unowned path inside the anchor window is an ABSENCE with the code
    //    the harness knows, and it never reaches the local backend.
    for (const path of [join(anchorRootDir, '.git'), join(anchorRootDir, 'no-such-sibling')]) {
      await expect(facade.resolve(path, { cwd: anchor })).rejects.toMatchObject({ code: 'FS_NOT_FOUND' })
    }
    expect(localFs.resolve).not.toHaveBeenCalled()

    // 2. Owned paths still route to the workspace connection (no regression).
    const owned = await facade.resolve('app.txt', { cwd: anchor })
    expect(String(owned.targetKey)).toContain(`${WFS_NAMESPACE_MARKER}ws-1/`)
    // ...and a path outside the anchor root stays local as before.
    await facade.resolve(join(dir, 'local.txt'))
    expect(localFs.resolve).toHaveBeenCalledWith(join(dir, 'local.txt'), undefined)

    // 3. Replay what `dsh-agent-instructions.existsAsMarker` does at the start
    //    of every run: resolve + stat a `<dir>/.git` marker while walking up,
    //    where ONLY a not-found answer means "keep walking" — any other error
    //    aborts the whole run (that is exactly how the reported failure hit).
    const probed: string[] = []
    const markerExists = async (path: string): Promise<boolean> => {
      try {
        return await facade.stat(await facade.resolve(path, { cwd: anchor })) !== undefined
      } catch (error) {
        expect((error as { code?: string }).code).toBe('FS_NOT_FOUND')
        return false
      }
    }
    const findProjectRoot = async (cwd: string): Promise<string> => {
      let current = cwd
      for (;;) {
        const marker = join(current, '.git')
        probed.push(marker)
        if (await markerExists(marker)) return current
        const parent = dirname(current)
        if (parent === current) return cwd
        current = parent
      }
    }
    await expect(findProjectRoot(anchor)).resolves.toBe(anchor)
    // The exact path from the reported failure must be among the probes stepped over.
    expect(probed).toContain(join(anchorRootDir, '.git'))

    await generic.core.closeAll()
  })
})

describe('production-shaped anchor routing (D-01)', () => {
  it('routes anchors nested under a declared local root to the remote world and keeps client infra local', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'generic-anchor-overlap-'))
    // Real shape: localRoot = <home>/.dsh, anchors live under
    // <home>/.dsh/ssh-workspaces/<id>.
    const localRoot = join(dir, '.dsh')
    const anchorsRoot = join(localRoot, 'ssh-workspaces')
    const anchor = join(anchorsRoot, 'ws-1')
    mkdirSync(anchor, { recursive: true })
    const record: SshWorkspaceRecord = {
      id: 'ws-1', title: 'proj', alias: 'host', remoteRoot: '/srv/app', anchorPath: anchor, createdAt: '2025-01-01T00:00:00.000Z',
    }
    const generic = await makeGenericCore(dir, record)
    generic.fake.seedFile('/srv/app/app.txt', 'hello remote')

    const localResolve = vi.fn(async (path: string) => ({ targetKey: `local:${path}`, displayPath: path }))
    const local = { resolve: localResolve, readText: vi.fn(async () => 'local text') } as unknown as FileSystem
    // Wired EXACTLY like fs.ts apply() (generic branch).
    const facade = new SwitchFileSystem(new Context(), {
      local,
      localRoots: [localRoot, join(dir, '.agents')],
      localRootExclusions: [anchorsRoot],
      worldForAnchorPath: (path) => {
        const world = genericFsWorldFor(generic.core, path, [anchorsRoot])
        if (world !== undefined) return world
        if (path === anchorsRoot || path.startsWith(`${anchorsRoot}${sep}`)) {
          throw new Error(`fs-ssh: '${path}' is inside the workspace anchor root but no registered workspace owns it (fail closed)`)
        }
        return undefined
      },
      worldFor: cwd => {
        const world = genericFsWorldFor(generic.core, cwd, [anchorsRoot])
        if (world !== undefined) return world
        if (cwd !== undefined && (cwd === anchorsRoot || cwd.startsWith(`${anchorsRoot}${sep}`))) {
          throw new Error(`fs-ssh: '${cwd}' is inside the workspace anchor root but no registered workspace owns it (fail closed)`)
        }
        return { backend: local, namespace: '' }
      },
      worldForNamespace: namespace => genericFsWorldForNamespace(generic.core, namespace),
    })

    // The model passes the session cwd (the anchor) verbatim -> REMOTE.
    const viaAnchor = await facade.resolve('app.txt', { cwd: anchor })
    expect(await facade.readText(viaAnchor)).toBe('hello remote')
    const viaAnchorAbsolute = await facade.resolve(join(anchor, 'app.txt'))
    expect(await facade.readText(viaAnchorAbsolute)).toBe('hello remote')

    // Client infrastructure OUTSIDE the anchors window stays LOCAL.
    const skill = await facade.resolve(join(localRoot, 'skills', 'x.md'))
    expect(localResolve).toHaveBeenCalledTimes(1)
    expect(await facade.readText(skill)).toBe('local text')

    // A stale anchor dir with no ledger record fails closed — never local.
    const stale = join(anchorsRoot, 'removed-workspace', 'old.txt')
    await expect(facade.resolve(stale)).rejects.toThrow(/no registered workspace owns it/)
    // ...including when only the SESSION CWD is stale and the path is relative.
    const staleCwd = join(anchorsRoot, 'removed-workspace')
    await expect(facade.resolve('old.txt', { cwd: staleCwd })).rejects.toThrow(/no registered workspace owns it/)
    await expect(facade.lstat('old.txt', { cwd: staleCwd })).rejects.toThrow(/no registered workspace owns it/)

    await generic.core.closeAll()
  })
})

describe('local provider v2 generic seam', () => {
  it('routes local records through official rooted fs/process capabilities without provider-id branching', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'generic-local-v2-'))
    const ledgerPath = join(dir, 'index.json')
    const record = {
      schemaVersion: 1,
      id: 'local-v2',
      title: 'local v2',
      provider: { id: 'local' },
      location: { kind: 'native', root: dir },
      anchor: { path: dir, mode: 'existing' as const },
      createdAt: '2025-01-01T00:00:00.000Z',
      updatedAt: '2025-01-01T00:00:00.000Z',
    }
    writeFileSync(ledgerPath, JSON.stringify([record]), 'utf8')

    const providers = new WorkspaceProviderRegistry()
    providers.register(createLocalWorkspaceProvider(new Context()))
    const core = new DefaultWorkspaceCore(new WorkspaceLedger(ledgerPath), providers)
    await core.initialize()

    const world = genericFsWorldFor(core, join(dir, 'child'), [])
    expect(world?.backend).toBeInstanceOf(RootedLocalFileSystem)
    expect(genericFsWorldForNamespace(core, `${WFS_NAMESPACE_MARKER}local-v2/`)?.backend).toBe(world?.backend)
    await expect((world!.backend as RootedLocalFileSystem).resolve('../outside')).rejects.toThrow('workspace.local-outside-root')

    const runtime = genericSubprocessFor(core, dir, [])
    expect(runtime).toBeInstanceOf(RootedLocalSubprocessRuntime)
    expect(() => (runtime as unknown as RootedLocalSubprocessRuntime).spawn({
      argv: [process.execPath, '-e', ''],
      cwd: join(dir, '..'),
      stdio: { stdin: 'ignore', stdout: 'ignore', stderr: 'ignore' },
      graceMs: 100,
    })).toThrow('workspace.local-outside-root')

    await core.closeAll()
  })
})
