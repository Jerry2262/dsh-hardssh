/**
 * Browser-side API client for the connection-configuration routes
 * (`/api/dsh-hardssh/ssh`): hosts, credentials, host-key trust, connection
 * state, health, and remote directory listing for workspace creation.
 *
 * The SSH-operations surface (exec / cluster / transfer / tunnel / terminal)
 * was removed with the operations capability; those routes are no longer
 * registered.
 */

import { readJson } from '../../client-http.ts'
import {
  SSH_API,
  type HardsshHealthSnapshot,
  type HostPayload,
  type KnownHostAction,
  type KnownHostView,
  type RemoteDirEntry,
  type SshHostSummary,
  type TestResult,
} from '../../ssh/protocol.ts'

/**
 * This family's error name for the ONE shared transport error
 * (`HttpApiError`): same class at runtime, so it carries the HTTP status and
 * the parsed body (code / secret / hostKeyFingerprint / hostKeyMismatch /
 * remaining / retryAfterMs) and existing `instanceof SshApiError` checks keep
 * working. Parsing lives in ../../client-http.ts — never re-implemented here.
 */
export { HttpApiError as SshApiError } from '../../client-http.ts'

/** The browser half's only data entry point. */
export class SshApi {
  // -------------------------------------------------------------- hosts
  async listHosts(queryText?: string): Promise<SshHostSummary[]> {
    const suffix = queryText === undefined ? '' : `?query=${encodeURIComponent(queryText)}`
    const response = await fetch(SSH_API.hosts + suffix)
    const body = await readJson<{ hosts: SshHostSummary[] }>(response)
    return body.hosts
  }

  async createHost(payload: HostPayload): Promise<SshHostSummary> {
    const response = await fetch(SSH_API.hosts, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    })
    const body = await readJson<{ host: SshHostSummary }>(response)
    return body.host
  }

  async updateHost(alias: string, patch: HostPayload): Promise<SshHostSummary> {
    const response = await fetch(SSH_API.hosts + `?alias=${encodeURIComponent(alias)}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(patch),
    })
    const body = await readJson<{ host: SshHostSummary }>(response)
    return body.host
  }

  async deleteHost(alias: string): Promise<void> {
    const response = await fetch(SSH_API.hosts + `?alias=${encodeURIComponent(alias)}`, { method: 'DELETE' })
    await readJson<{ ok: boolean }>(response)
  }

  /** Probe one configured alias; returns the additive diagnostics result. */
  async testHost(alias: string): Promise<TestResult> {
    const response = await fetch(SSH_API.test, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ alias }),
    })
    const body = await readJson<{ result: TestResult }>(response)
    return body.result
  }

  // ----------------------------------------------------------------- ls
  /** List one remote directory (workspace-creation dialog / directory flow). */
  async ls(alias: string, path: string): Promise<RemoteDirEntry[]> {
    const response = await fetch(SSH_API.ls + `?alias=${encodeURIComponent(alias)}&path=${encodeURIComponent(path)}`)
    const body = await readJson<{ entries: RemoteDirEntry[] }>(response)
    return body.entries
  }

  // --------------------------------------------------------- known-hosts
  /** Read the host-key trust records (optionally one alias's). */
  async listKnownHosts(alias?: string): Promise<KnownHostView[]> {
    const suffix = alias === undefined ? '' : `?alias=${encodeURIComponent(alias)}`
    const response = await fetch(SSH_API.knownHosts + suffix)
    const body = await readJson<{ records: KnownHostView[] }>(response)
    return body.records
  }

  /** Confirm (trust) or reset (forget) one alias's host key. */
  async hostKeyAction(alias: string, action: KnownHostAction): Promise<void> {
    const response = await fetch(SSH_API.knownHosts, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ alias, action }),
    })
    await readJson<{ ok: true }>(response)
  }

  // -------------------------------------------------------- connections
  /** Aliases currently holding a live pooled SSH connection (badge coloring). */
  async connectedAliases(): Promise<string[]> {
    const response = await fetch(SSH_API.connections)
    const body = await readJson<{ connected: string[] }>(response)
    return body.connected
  }

  // --------------------------------------------------------------- health
  /** Compatibility/degradation report; no host/credential access happens. */
  async health(): Promise<HardsshHealthSnapshot | undefined> {
    const response = await fetch(SSH_API.health)
    const body = await readJson<{ health?: HardsshHealthSnapshot }>(response)
    return body.health
  }

  // ------------------------------------------------------ session secrets
  /** Provide a password/passphrase for `alias` THIS SESSION ONLY (never
   *  persisted). Called when a connection replied NEEDS_PASSWORD; after
   *  injection the caller retries the operation. */
  async setSessionSecret(alias: string, secret: { password?: string; passphrase?: string }): Promise<void> {
    const response = await fetch(SSH_API.sessionSecret, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ alias, ...secret }),
    })
    await readJson<{ ok: true }>(response)
  }
}
