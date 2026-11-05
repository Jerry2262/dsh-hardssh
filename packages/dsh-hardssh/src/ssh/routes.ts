/**
 * The connection-configuration route family: host CRUD, ssh-config import,
 * known-hosts, credential vault, session secrets, health, connection state,
 * connectivity test, and remote directory listing for workspace creation.
 *
 * Every route carries a loopback-only trust fence (plus browser same-origin
 * markers). The removed SSH-operations routes (exec / cluster / transfer /
 * tunnel / terminal) are not built.
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'
import type { SshEngine } from './engine.ts'
import type { OperationLog, OperationRecord } from './operation-log.ts'
import { SSH_API, type HostPayload, type ApiErrorBody } from './protocol.ts'
import type { HostStore } from './store.ts'
import { HostKeyMismatchError, HostKeyUnknownError, type KnownHostsStore } from './known-hosts.ts'
import { NeedsPasswordError } from './engine.ts'
import { MIN_MASTER_PASSWORD_LENGTH } from './vault.ts'
// Shared host HTTP boundary (A-05): one loopback fence, one JSON body reader,
// one JSON writer for every host route family — copies drift apart silently.
import { isLoopbackRequest, queryParam, readJsonBody as readJsonBodyResult, writeJson } from '../host-http.ts'

/** Cap on JSON request bodies (host entries are small). */
const MAX_JSON_BODY_BYTES = 64 * 1024

/** Abort one HTTP operation when its caller disconnects. */
function requestAbort(req: IncomingMessage, res: ServerResponse): { signal: AbortSignal; dispose: () => void } {
  const controller = new AbortController()
  const abort = (message: string): void => {
    if (controller.signal.aborted) return
    controller.abort(Object.assign(new Error(message), { name: 'AbortError' }))
  }
  const onAborted = (): void => { abort('request aborted by the client') }
  const onRequestClose = (): void => {
    if (!req.complete) abort('request connection closed before completion')
  }
  const onResponseClose = (): void => {
    if (!res.writableFinished) abort('response connection closed before completion')
  }
  req.once('aborted', onAborted)
  req.once('close', onRequestClose)
  res.once('close', onResponseClose)
  return {
    signal: controller.signal,
    dispose: () => {
      req.off('aborted', onAborted)
      req.off('close', onRequestClose)
      res.off('close', onResponseClose)
    },
  }
}

/**
 * THE error mapper for the connection route family (B-14): one status policy
 * and one body shape everywhere, so identical auth/TOFU failures are
 * recognizable by status + code no matter which endpoint produced them.
 *
 * Status policy (a single status per code, never 2xx):
 * - 500 — interactive gates (NEEDS_PASSWORD / HOST_KEY_UNKNOWN /
 *   HOST_KEY_MISMATCH), so a client's `readJson` on 2xx can never mis-parse a
 *   structured error as a successful result — and every other failure.
 * - 400/404/409/413/423/429 are reserved for the request/vault-specific
 *   checks each route performs BEFORE calling the engine.
 */
function errorBody(error: unknown, redact?: (text: string) => string): ApiErrorBody {
  const safe = (text: string): string => redact?.(text) ?? text
  if (error instanceof HostKeyUnknownError) {
    return { error: safe(error.message), code: 'HOST_KEY_UNKNOWN', hostKeyFingerprint: error.fingerprintSha256 }
  }
  if (error instanceof HostKeyMismatchError) {
    return { error: safe(error.message), code: 'HOST_KEY_MISMATCH', hostKeyFingerprint: error.actual, hostKeyMismatch: { expected: error.expected, actual: error.actual } }
  }
  if (error instanceof NeedsPasswordError) {
    return { error: safe(error.message), code: 'NEEDS_PASSWORD', secret: error.secret }
  }
  return { error: safe(error instanceof Error ? error.message : String(error)) }
}

/**
 * Read a JSON request body, collapsing every failure (too large, malformed,
 * non-object) to `undefined` — the call sites only distinguish "no usable
 * body" and keep their own 400 text, matching the historical local reader.
 */
async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown> | undefined> {
  const result = await readJsonBodyResult(req, MAX_JSON_BODY_BYTES)
  return result.ok ? result.body : undefined
}

/** Route family dependencies. */
export interface SshRoutesDeps {
  /** The host store (CRUD; vault-backed for secrets). */
  store: import('./store.ts').SecureHostStore
  /** The shared ssh2 connection pool. */
  engine: SshEngine
  /** Host-key trust store (TOFU); absent → host-key verification disabled. */
  knownHosts?: KnownHostsStore
  /** Credential vault (optional; enables /api/dsh-hardssh/ssh/vault endpoints). */
  vault?: import('./vault.ts').Vault
  /** SSH-bound workspace record source (host-delete reference check). */
  ledger?: import('../backend.ts').WorkspaceStoreView
  /** Called after a host PATCH/DELETE persisted, so derived caches (e.g. the
   *  remote environment cache) can drop that alias. */
  onHostInvalidated?: (alias: string) => void
  /** Read-only compatibility/degradation registry (`/health` serves a copy). */
  health?: { snapshot: () => import('./protocol.ts').HardsshHealthSnapshot }
  /** In-memory log of management operations for the sidebar console. */
  operationLog?: OperationLog
}

/** The connection-configuration routes, owned by one call. */
export interface SshRoutes {
  routes: WebRoute[]
}

/**
 * Build the connection-configuration routes (exact paths). The removed
 * SSH-operations routes (exec / cluster / transfer / tunnel / terminal) are
 * not built at all.
 * @param deps - store, engine, host-key store, vault.
 * @returns the exact routes.
 */
export function makeRoutes(deps: SshRoutesDeps): SshRoutes {
  const { store, engine } = deps
  /** Every route error string passes the engine leak guard. Tolerates engine
   *  doubles that predate the redactor (tests inject minimal fakes). */
  const redact = typeof engine.redact === 'function' ? (text: string): string => engine.redact(text) : (text: string): string => text
  const safeMessage = (error: unknown): string => redact(error instanceof Error ? error.message : String(error))
  const safeErrorBody = (error: unknown): ApiErrorBody => errorBody(error, redact)

  /** Guard helper: fence + method check. */
  const guard = (req: IncomingMessage, res: ServerResponse, method: string): boolean => {
    if (!isLoopbackRequest(req)) {
      writeJson(res, 403, { error: 'forbidden: loopback-only' })
      return false
    }
    if (req.method !== method) {
      writeJson(res, 405, { error: `method not allowed: ${req.method}` })
      return false
    }
    return true
  }

  const routes: WebRoute[] = [
    // ------------------------------------------------------------ hosts
    {
      kind: 'exact',
      path: SSH_API.hosts,
      handler: async (req, res) => {
        // One handler per path (the webserver keyed route registry rejects
        // duplicate (kind, path)); dispatch by HTTP method here.
        const method = req.method ?? 'GET'
        if (!isLoopbackRequest(req)) {
          writeJson(res, 403, { error: 'forbidden: loopback-only' })
          return
        }
        const url = new URL(req.url ?? '/', 'http://localhost')
        if (method === 'GET') {
          writeJson(res, 200, { hosts: engine.list(queryParam(url, 'query')) })
          return
        }
        if (method === 'POST') {
          const body = await readJsonBody(req)
          if (body === undefined) {
            writeJson(res, 400, { error: 'invalid JSON body' })
            return
          }
          try {
            const entry = await store.create(body as unknown as HostPayload)
            writeJson(res, 201, { host: store.summarize(entry) })
          } catch (error) {
            writeJson(res, 400, { error: safeMessage(error) })
          }
          return
        }
        if (method !== 'PATCH' && method !== 'DELETE') {
          writeJson(res, 405, { error: `method not allowed: ${method}` })
          return
        }
        const alias = queryParam(url, 'alias')
        if (alias === undefined || alias === '') {
          writeJson(res, 400, { error: 'alias query parameter is required' })
          return
        }
        if (method === 'PATCH') {
          const body = await readJsonBody(req)
          if (body === undefined) {
            writeJson(res, 400, { error: 'invalid JSON body' })
            return
          }
          try {
            const entry = await store.update(alias, body as unknown as Partial<HostPayload>)
            // Persist first. A validation/save failure must leave all
            // existing connections untouched. drain lets in-flight
            // operations finish while generation invalidation guarantees
            // subsequent acquisitions cannot reuse the old config's
            // connection (or publish one built from it).
            engine.invalidate(alias, { includeDependents: true, mode: 'drain' })
            deps.onHostInvalidated?.(alias)
            writeJson(res, 200, { host: store.summarize(entry) })
          } catch (error) {
            writeJson(res, 400, { error: safeMessage(error) })
          }
          return
        }
        if (method === 'DELETE') {
          // Reference guard: a host still backing SSH-bound workspaces must
          // not be deleted (the workspaces would silently lose their
          // transport). Return 409 with the referencing workspace titles.
          if (deps.ledger !== undefined) {
            let referenced: import('../protocol.ts').SshWorkspaceRecord[]
            try {
              referenced = (await deps.ledger.list()).filter(record => record.alias === alias)
            } catch (error) {
              // The generic workspace store can reject when the runtime failed
              // to initialize (corrupt ledger). Deleting the host then could
              // strand live SSH workspaces, so the guard refuses instead of
              // guessing — fail closed.
              writeJson(res, 409, {
                error: `cannot verify references for alias '${alias}' because the workspace runtime is unavailable: ${safeMessage(error)}`,
                code: 'HOST_IN_USE_GUARD_UNAVAILABLE',
              })
              return
            }
            if (referenced.length > 0) {
              writeJson(res, 409, {
                error: `alias '${alias}' is still referenced by ${referenced.length} SSH workspace(s) (${referenced.map(r => r.title).join('、')}) — delete those workspaces first`,
                code: 'HOST_IN_USE',
                workspaces: referenced.map(record => ({ id: record.id, title: record.title })),
              })
              return
            }
          }
          try {
            // Delete first so a missing alias or failed store write does not
            // disturb a live connection.
            await store.delete(alias)
            engine.invalidate(alias, { mode: 'force' })
            deps.onHostInvalidated?.(alias)
            writeJson(res, 200, { ok: true })
          } catch (error) {
            writeJson(res, 400, { error: safeMessage(error) })
          }
          return
        }
        writeJson(res, 405, { error: `method not allowed: ${method}` })
      },
    },
    {
      kind: 'exact',
      path: SSH_API.importSshConfig,
      handler: async (req, res) => {
        if (!guard(req, res, 'POST')) return
        try {
          const result = await store.importFromSshConfig()
          writeJson(res, 200, { result })
        } catch (error) {
          writeJson(res, 500, { error: safeMessage(error) })
        }
      },
    },
    // -------------------------------------------------------- known-hosts
    {
      kind: 'exact',
      path: SSH_API.knownHosts,
      handler: async (req, res) => {
        if (!isLoopbackRequest(req)) {
          writeJson(res, 403, { error: 'forbidden: loopback-only' })
          return
        }
        const method = req.method ?? 'GET'
        const url = new URL(req.url ?? '/', 'http://localhost')
        const knownHosts = deps.knownHosts
        if (knownHosts === undefined) {
          writeJson(res, 404, { error: 'host-key trust store is not enabled' })
          return
        }
        if (method === 'GET') {
          const alias = queryParam(url, 'alias')
          const records = knownHosts.list()
            .filter(record => alias === undefined || alias === '' || record.alias === alias)
            .map(record => ({
              alias: record.alias,
              host: record.host,
              port: record.port,
              keyType: record.keyType,
              fingerprint: record.fingerprint,
              status: record.status,
              firstSeenAt: record.firstSeenAt,
              confirmedAt: record.confirmedAt,
            } satisfies import('./protocol.ts').KnownHostView))
          writeJson(res, 200, { records })
          return
        }
        if (method !== 'POST') {
          writeJson(res, 405, { error: `method not allowed: ${method}` })
          return
        }
        const body = await readJsonBody(req)
        const alias = typeof body?.alias === 'string' ? body.alias : ''
        const action = typeof body?.action === 'string' ? body.action : ''
        if (alias === '' || (action !== 'trust' && action !== 'forget')) {
          writeJson(res, 400, { error: 'alias and action (trust|forget) are required' })
          return
        }
        try {
          if (action === 'trust') {
            const entry = store.find(alias)
            knownHosts.trust(alias, entry === undefined ? undefined : { host: entry.host, port: entry.port })
          }
          else knownHosts.forget(alias)
          writeJson(res, 200, { ok: true })
        } catch (error) {
          writeJson(res, 400, { error: safeMessage(error) })
        }
      },
    },
    // ------------------------------------------------------------- vault
    {
      kind: 'exact',
      path: SSH_API.vault,
      handler: async (req, res) => {
        if (!isLoopbackRequest(req)) {
          writeJson(res, 403, { error: 'forbidden: loopback-only' })
          return
        }
        const vault = deps.vault
        if (vault === undefined) {
          writeJson(res, 404, { error: 'credential vault is not enabled' })
          return
        }
        const method = req.method ?? 'GET'
        if (method === 'GET') {
          writeJson(res, 200, { status: vault.status() })
          return
        }
        if (method !== 'POST') {
          writeJson(res, 405, { error: `method not allowed: ${method}` })
          return
        }
        const body = await readJsonBody(req)
        const action = typeof body?.action === 'string' ? body.action : ''
        try {
          if (action === 'status') {
            writeJson(res, 200, { status: vault.status() })
            return
          }
          if (action === 'unlock') {
            const password = typeof body?.password === 'string' ? body.password : ''
            if (password.trim().length < MIN_MASTER_PASSWORD_LENGTH) {
              writeJson(res, 400, { error: `vault password must contain at least ${MIN_MASTER_PASSWORD_LENGTH} non-whitespace characters` })
              return
            }
            await vault.unlock(password)
            writeJson(res, 200, { ok: true, status: vault.status() })
            return
          }
          if (action === 'rekey') {
            const password = typeof body?.password === 'string' ? body.password : ''
            if (password.trim().length < MIN_MASTER_PASSWORD_LENGTH) {
              writeJson(res, 400, { error: `vault password must contain at least ${MIN_MASTER_PASSWORD_LENGTH} non-whitespace characters` })
              return
            }
            await vault.rekey(password)
            writeJson(res, 200, { ok: true, status: vault.status() })
            return
          }
          writeJson(res, 400, { error: 'action must be status|unlock|rekey' })
        } catch (error) {
          // Vault errors carry stable codes + retry info; the HTTP status must
          // distinguish a wrong password (401) from a lockout (429), a locked
          // vault (423), a weak password (400) and an unexpected failure (500).
          const record = error as { code?: unknown; remaining?: unknown; retryAfterMs?: unknown }
          const code = typeof record.code === 'string' ? record.code : undefined
          const status = code === 'VAULT_AUTH' ? 401
            : code === 'VAULT_LOCKOUT' ? 429
              : code === 'VAULT_LOCKED' ? 423
                : code === 'VAULT_PASSWORD_WEAK' ? 400
                  : code === undefined ? 500 : 500
          writeJson(res, status, {
            error: safeMessage(error),
            code,
            ...(typeof record.remaining === 'number' ? { remaining: record.remaining } : {}),
            ...(typeof record.retryAfterMs === 'number' ? { retryAfterMs: record.retryAfterMs } : {}),
          })
        }
      },
    },
    // --------------------------------------------------- session-secret
    {
      kind: 'exact',
      path: SSH_API.sessionSecret,
      handler: async (req, res) => {
        if (!isLoopbackRequest(req)) {
          writeJson(res, 403, { error: 'forbidden: loopback-only' })
          return
        }
        if ((req.method ?? '') !== 'POST') {
          writeJson(res, 405, { error: `method not allowed: ${req.method}` })
          return
        }
        const body = await readJsonBody(req)
        const alias = typeof body?.alias === 'string' ? body.alias : ''
        const password = typeof body?.password === 'string' ? body.password : undefined
        const passphrase = typeof body?.passphrase === 'string' ? body.passphrase : undefined
        if (alias === '' || (password === undefined && passphrase === undefined)) {
          writeJson(res, 400, { error: 'alias and password|passphrase are required' })
          return
        }
        // Memory-only: never persisted; consumed by connectChain for the
        // pooled connection's lifetime (idle 30 min auto-disconnect).
        engine.setSessionPassword(alias, { password, passphrase })
        writeJson(res, 200, { ok: true })
      },
    },
    // -------------------------------------------------------- health
    // Read-only compatibility/degradation report. Deliberately never dials a
    // host and never reads credentials: it only reflects what the host process
    // managed to mount. The client renders a banner from it so a degraded
    // install is visible instead of looking like a broken SSH connection.
    {
      kind: 'exact',
      path: SSH_API.health,
      handler: async (req, res) => {
        if (!isLoopbackRequest(req)) {
          writeJson(res, 403, { error: 'forbidden: loopback-only' })
          return
        }
        if ((req.method ?? '') !== 'GET') {
          writeJson(res, 405, { error: `method not allowed: ${req.method}` })
          return
        }
        writeJson(res, 200, { health: deps.health?.snapshot() })
      },
    },
    // --------------------------------------------------- connections
    {
      kind: 'exact',
      path: SSH_API.connections,
      handler: async (req, res) => {
        if (!isLoopbackRequest(req)) {
          writeJson(res, 403, { error: 'forbidden: loopback-only' })
          return
        }
        if ((req.method ?? '') !== 'GET') {
          writeJson(res, 405, { error: `method not allowed: ${req.method}` })
          return
        }
        writeJson(res, 200, { connected: engine.connectedAliases() })
      },
    },
    // ------------------------------------------------------------ ops
    {
      kind: 'exact',
      path: SSH_API.test,
      handler: async (req, res) => {
        if (!guard(req, res, 'POST')) return
        const request = requestAbort(req, res)
        let operation: OperationRecord | undefined
        const fail = (message: string): void => deps.operationLog?.finish(operation, 'failed', message)
        try {
          const body = await readJsonBody(req)
          const alias = typeof body?.alias === 'string' ? body.alias : ''
          if (alias === '') {
            writeJson(res, 400, { error: 'alias is required' })
            return
          }
          operation = deps.operationLog?.begin('host.test', alias)
          const result = await (deps.operationLog === undefined
            ? engine.test(alias, request.signal)
            : deps.operationLog.step(
                operation,
                `ssh test ${alias}`,
                () => engine.test(alias, request.signal),
                value => ({ exitCode: value.ok ? 0 : 1, stderr: value.error }),
              ))
          deps.operationLog?.finish(operation, result.ok ? 'ok' : 'failed', result.ok ? undefined : result.error)
          writeJson(res, 200, { result })
        } catch (error) {
          if (error instanceof NeedsPasswordError) {
            fail(error.message)
            // The ONLY intentional 2xx difference: /test is a diagnostic the
            // GUI polls, so a missing credential is reported as a result the
            // user can act on. The body still comes from the shared mapper
            // (same code/secret fields as every other route's 500).
            writeJson(res, 200, { result: { ok: false, ...safeErrorBody(error) } })
            return
          }
          fail(error instanceof Error ? error.message : String(error))
          writeJson(res, 500, safeErrorBody(error))
        } finally {
          request.dispose()
        }
      },
    },
    // ------------------------------------------------------------- ls
    {
      kind: 'exact',
      path: SSH_API.ls,
      handler: async (req, res) => {
        if (!guard(req, res, 'GET')) return
        const request = requestAbort(req, res)
        try {
          const url = new URL(req.url ?? '/', 'http://localhost')
          const alias = queryParam(url, 'alias')
          const requested = queryParam(url, 'path') ?? '/'
          if (alias === undefined || alias === '') {
            writeJson(res, 400, { error: 'alias query parameter is required' })
            return
          }
          // Same fence as the workspace listing route: an SFTP path is a POSIX
          // absolute path, so NUL, backslashes and relative forms are rejected
          // before they reach the remote filesystem.
          if (requested.includes('\0') || requested.includes('\\') || !requested.startsWith('/')) {
            writeJson(res, 400, { error: `path must be an absolute POSIX path (got '${requested}')` })
            return
          }
          writeJson(res, 200, { entries: await engine.ls(alias, requested, request.signal) })
        } catch (error) {
          // Was a flattened 400 string, which lost NEEDS_PASSWORD / TOFU codes
          // the GUI needs to prompt; the shared mapper (500) restores them.
          writeJson(res, 500, safeErrorBody(error))
        } finally {
          request.dispose()
        }
      },
    },
  ]

  return { routes }
}
