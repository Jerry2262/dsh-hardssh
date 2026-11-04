/**
 * A-05 (client side): the ONE browser transport layer. Both route families
 * (workspace + connection) must decode errors through the same class and the
 * same parser, keeping the HTTP status and every field the UI reads
 * (code / secret / hostKeyFingerprint / hostKeyMismatch / remaining /
 * retryAfterMs) instead of flattening them into a string.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { HttpApiError, buildQuery, readJson, throwHttpError } from '../../src/client-http.ts'
import { WorkspaceApiError } from '../../src/client/api.ts'
import { SshApi, SshApiError } from '../../src/client/ssh/api.ts'

/** One JSON response double. */
function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('readJson (single transport parser)', () => {
  it('returns the parsed body for a successful response', async () => {
    await expect(readJson<{ hosts: string[] }>(jsonResponse({ hosts: ['a'] }))).resolves.toEqual({ hosts: ['a'] })
  })

  it('keeps status, parsed body and every interactive-gate field', async () => {
    const response = jsonResponse({
      error: 'host key mismatch',
      code: 'HOST_KEY_MISMATCH',
      hostKeyFingerprint: 'SHA256:abc',
      hostKeyMismatch: { expected: 'SHA256:old', actual: 'SHA256:abc' },
      workspaces: [{ id: 'w1', title: 'one' }],
      remaining: 2,
      retryAfterMs: 1500,
      secret: 'passphrase',
    }, 500)
    const error = await readJson(response).catch((cause: unknown) => cause)
    expect(error).toBeInstanceOf(HttpApiError)
    const failure = error as HttpApiError
    expect(failure.status).toBe(500)
    expect(failure.message).toBe('host key mismatch')
    expect(failure.code).toBe('HOST_KEY_MISMATCH')
    expect(failure.hostKeyFingerprint).toBe('SHA256:abc')
    expect(failure.hostKeyMismatch).toEqual({ expected: 'SHA256:old', actual: 'SHA256:abc' })
    expect(failure.secret).toBe('passphrase')
    expect(failure.remaining).toBe(2)
    expect(failure.retryAfterMs).toBe(1500)
    expect(failure.body?.workspaces).toEqual([{ id: 'w1', title: 'one' }])
  })

  it('reports a non-JSON body with the HTTP status and no body', async () => {
    const response = new Response('<html>nope</html>', { status: 502 })
    const error = await readJson(response).catch((cause: unknown) => cause) as HttpApiError
    expect(error).toBeInstanceOf(HttpApiError)
    expect(error.status).toBe(502)
    expect(error.body).toBeUndefined()
    expect(error.message).toBe('HTTP 502: invalid JSON response')
  })

  it('falls back to the status text for a non-object error body', async () => {
    const error = await readJson(jsonResponse('boom', 400)).catch((cause: unknown) => cause) as HttpApiError
    expect(error.status).toBe(400)
    expect(error.message).toBe('HTTP 400')
    expect(error.code).toBeUndefined()
  })
})

describe('throwHttpError (shared transport)', () => {
  it('parses the JSON error body of a non-ok response', async () => {
    const error = await throwHttpError(jsonResponse({ error: 'host key trust store is not enabled', code: 'HOST_KEY_DISABLED' }, 404), 'request failed')
      .catch((cause: unknown) => cause) as HttpApiError
    expect(error).toBeInstanceOf(HttpApiError)
    expect(error.status).toBe(404)
    expect(error.message).toBe('host key trust store is not enabled')
    expect(error.code).toBe('HOST_KEY_DISABLED')
  })

  it('keeps the caller prefix when the route sent no JSON body', async () => {
    const error = await throwHttpError(new Response('', { status: 500 }), 'request failed')
      .catch((cause: unknown) => cause) as HttpApiError
    expect(error.message).toBe('request failed: HTTP 500')
    expect(error.status).toBe(500)
    expect(error.body).toBeUndefined()
  })
})

describe('one class across both route families', () => {
  it('exposes the SSH name as the same class (instanceof keeps working)', () => {
    const error = new HttpApiError('x', 500, { code: 'HOST_KEY_UNKNOWN', hostKeyFingerprint: 'SHA256:fp' })
    expect(error).toBeInstanceOf(SshApiError)
    expect(error.code).toBe('HOST_KEY_UNKNOWN')
    expect(error.hostKeyFingerprint).toBe('SHA256:fp')
  })

  it('keeps WorkspaceApiError a subclass of the transport class', () => {
    const error = new WorkspaceApiError('x', 404, { code: 'io' })
    expect(error).toBeInstanceOf(HttpApiError)
    expect(error.status).toBe(404)
    expect(error.code).toBe('io')
  })

  it('SshApi.listHosts surfaces the shared error with status and code', async () => {
    vi.stubGlobal('fetch', async () => jsonResponse({ error: 'host-key trust store is not enabled', code: 'HOST_KEY_DISABLED' }, 404))
    const error = await new SshApi().listHosts().catch((cause: unknown) => cause) as HttpApiError
    expect(error).toBeInstanceOf(SshApiError)
    expect(error.status).toBe(404)
    expect(error.code).toBe('HOST_KEY_DISABLED')
  })
})

describe('buildQuery (shared, no per-client copy)', () => {
  it('skips undefined and empty values', () => {
    expect(buildQuery({ alias: 'h1', path: '', port: 0, missing: undefined })).toBe('?alias=h1&port=0')
    expect(buildQuery({})).toBe('')
  })
})
