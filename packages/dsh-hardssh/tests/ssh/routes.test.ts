/**
 * Route-layer tests for the connection-configuration family: the loopback
 * fence, hosts CRUD dispatch (one handler per path), the health snapshot, the
 * connectivity test, and the remote-directory listing fence.
 *
 * The removed SSH-operations routes (exec / cluster / upload / download /
 * tunnel / terminal) are not registered, so nothing here exercises them.
 */

import { createServer, request as httpRequest, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { makeRoutes, type SshRoutes } from '../../src/ssh/routes.ts'
import { HostStore } from '../../src/ssh/store.ts'
import { SSH_API, type SshHostSummary } from '../../src/ssh/protocol.ts'
import { HardsshHealthRegistry } from '../../src/runtime/health.ts'
import type { SshEngine } from '../../src/ssh/engine.ts'

/** In-memory engine stub for route-level tests. */
class StubEngine {
  hosts: SshHostSummary[] = []
  lsCalls: Array<{ alias: string; path: string }> = []

  list(): SshHostSummary[] {
    return this.hosts
  }
  find(): SshHostSummary | undefined {
    return undefined
  }
  async test(): Promise<{ ok: boolean }> {
    return { ok: true }
  }
  async ls(alias: string, path: string): Promise<unknown[]> {
    this.lsCalls.push({ alias, path })
    return []
  }
  redact(text: string): string {
    return text
  }
  invalidate(): void {
    // no-op in the stub
  }
}

const engine = (stub: StubEngine): SshEngine => stub as unknown as SshEngine

let server: Server
let port: number
let store: HostStore
let stub: StubEngine
const dir = mkdtempSync(join(tmpdir(), 'dsh-ssh-routes-'))

function get(path: string, headers: Record<string, string> = {}): Promise<{ status: number; text: string }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: '127.0.0.1', port, path, headers }, (res) => {
      let text = ''
      res.on('data', (chunk: Buffer) => { text += chunk.toString('utf8') })
      res.on('end', () => resolve({ status: res.statusCode ?? 0, text }))
    })
    req.on('error', reject)
    req.end()
  })
}

/** A route family on its own ephemeral HTTP server (per-test knobs). */
async function startRouteServer(options: {
  engine: SshEngine
  store?: HostStore
  health?: { snapshot: () => unknown }
}): Promise<{ routes: SshRoutes; server: Server; port: number }> {
  const routeSet = makeRoutes({
    store: options.store ?? new HostStore(join(dir, `hosts-${randomSuffix()}.json`)),
    engine: options.engine,
    health: options.health as never,
  })
  const server = createServer((req, res) => {
    const rawPath = new URL(req.url ?? '/', 'http://x').pathname
    const route = routeSet.routes.find(r => r.kind === 'exact' && r.path === rawPath)
    if (route === undefined) {
      res.writeHead(404)
      res.end()
      return
    }
    void route.handler(req, res)
  })
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })
  return { routes: routeSet, server, port: (server.address() as AddressInfo).port }
}

function closeServer(server: Server): Promise<void> {
  return new Promise<void>((resolve) => { server.close(() => resolve()) })
}

function randomSuffix(): string {
  return Math.random().toString(16).slice(2, 10)
}

beforeAll(async () => {
  store = new HostStore(join(dir, 'hosts.json'))
  stub = new StubEngine()
  const { routes } = makeRoutes({ store, engine: engine(stub) })
  server = createServer((req, res) => {
    const rawPath = new URL(req.url ?? '/', 'http://x').pathname
    const route = routes.find(r => r.kind === 'exact' && r.path === rawPath)
    if (route === undefined) {
      res.writeHead(404)
      res.end()
      return
    }
    void route.handler(req, res)
  })
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })
  port = (server.address() as AddressInfo).port
})

afterAll(async () => {
  await new Promise<void>((resolve) => { server.close(() => resolve()) })
  rmSync(dir, { recursive: true, force: true })
})

describe('loopback fence', () => {
  it('rejects cross-site requests with 403', async () => {
    const result = await get(SSH_API.hosts, { 'sec-fetch-site': 'cross-site' })
    expect(result.status).toBe(403)
  })

  it('rejects non-loopback Host headers with 403', async () => {
    const result = await get(SSH_API.hosts, { host: 'evil.example.com' })
    expect(result.status).toBe(403)
  })

  it('rejects wrong methods with 405', async () => {
    // /ls is GET-only.
    const result = await new Promise<{ status: number }>((resolve, reject) => {
      const req = httpRequest({ host: '127.0.0.1', port, path: SSH_API.ls + '?alias=a&path=/', method: 'POST' }, (res) => {
        res.resume()
        res.on('end', () => resolve({ status: res.statusCode ?? 0 }))
      })
      req.on('error', reject)
      req.end()
    })
    expect(result.status).toBe(405)
  })
})

describe('compatibility health route', () => {
  it('serves the registry snapshot read-only, and stays absent without one', async () => {
    const registry = new HardsshHealthRegistry()
    registry.set('fsRouting', { state: 'degraded', reason: 'workspaceCore is unavailable', missing: ['router'] })
    const quiet = new StubEngine()
    const withHealth = await startRouteServer({ engine: engine(quiet), health: registry })
    try {
      const ok = await fetch(`http://127.0.0.1:${withHealth.port}${SSH_API.health}`)
      expect(ok.status).toBe(200)
      const body = await ok.json() as { health: { features: Record<string, { state: string; reason?: string; missing?: string[] }>; packageVersion: string } }
      expect(body.health.features.fsRouting).toMatchObject({
        state: 'degraded',
        reason: 'workspaceCore is unavailable',
        missing: ['router'],
      })
      expect(body.health.packageVersion).toMatch(/^\d+\.\d+\.\d+/)
      expect(quiet.lsCalls).toHaveLength(0)

      const wrongMethod = await fetch(`http://127.0.0.1:${withHealth.port}${SSH_API.health}`, { method: 'POST' })
      expect(wrongMethod.status).toBe(405)
    } finally {
      await closeServer(withHealth.server)
    }

    const withoutHealth = await startRouteServer({ engine: engine(stub) })
    try {
      const empty = await fetch(`http://127.0.0.1:${withoutHealth.port}${SSH_API.health}`)
      expect(empty.status).toBe(200)
      expect(await empty.json()).toEqual({})
    } finally {
      await closeServer(withoutHealth.server)
    }
  })
})

describe('hosts CRUD (one handler per path)', () => {
  it('creates, lists, patches, and deletes through the shared route', async () => {
    const create = await fetch('http://127.0.0.1:' + port + SSH_API.hosts, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        alias: 'web-01',
        host: '10.0.0.1',
        user: 'root',
        auth: { kind: 'password', password: 'pw' },
      }),
    })
    expect(create.status).toBe(201)
    expect(store.list()).toHaveLength(1)
    expect(store.find('web-01')?.auth.password).toBe('pw')

    // The GET surface lists through the engine; the summary never carries secrets.
    stub.hosts = [store.summarize(store.find('web-01')!)]
    const list = await fetch('http://127.0.0.1:' + port + SSH_API.hosts)
    expect(list.status).toBe(200)
    const body = await list.json() as { hosts: SshHostSummary[] }
    expect(body.hosts).toHaveLength(1)
    expect(body.hosts[0]?.alias).toBe('web-01')
    expect('password' in body.hosts[0]!).toBe(false)

    const patch = await fetch('http://127.0.0.1:' + port + SSH_API.hosts + '?alias=web-01', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ description: 'renewed' }),
    })
    expect(patch.status).toBe(200)
    expect(store.find('web-01')?.description).toBe('renewed')
    expect(store.find('web-01')?.auth.password).toBe('pw')

    const del = await fetch('http://127.0.0.1:' + port + SSH_API.hosts + '?alias=web-01', { method: 'DELETE' })
    expect(del.status).toBe(200)
    expect(store.list()).toHaveLength(0)
  })

  it('rejects unknown methods on the hosts path with 405', async () => {
    const options = await new Promise<{ status: number }>((resolve, reject) => {
      const req = httpRequest({ host: '127.0.0.1', port, path: SSH_API.hosts, method: 'OPTIONS' }, (res) => {
        res.resume()
        res.on('end', () => resolve({ status: res.statusCode ?? 0 }))
      })
      req.on('error', reject)
      req.end()
    })
    expect(options.status).toBe(405)
  })
})

describe('connectivity test route', () => {
  it('reports the engine result as a 2xx diagnostic', async () => {
    const response = await fetch('http://127.0.0.1:' + port + SSH_API.test, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ alias: 'web-01' }),
    })
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ result: { ok: true } })
  })
})

describe('remote directory listing fence', () => {
  it('rejects a non-POSIX-absolute path before the engine sees it', async () => {
    const result = await fetch(`http://127.0.0.1:${port}${SSH_API.ls}?alias=web-01&path=relative/dir`)
    expect(result.status).toBe(400)
    expect(stub.lsCalls).toHaveLength(0)
  })

  it('lists the requested absolute path through the engine', async () => {
    stub.lsCalls = []
    const result = await fetch(`http://127.0.0.1:${port}${SSH_API.ls}?alias=web-01&path=/srv`)
    expect(result.status).toBe(200)
    expect(await result.json()).toEqual({ entries: [] })
    expect(stub.lsCalls).toEqual([{ alias: 'web-01', path: '/srv' }])
  })
})
