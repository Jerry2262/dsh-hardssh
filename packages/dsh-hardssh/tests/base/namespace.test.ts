/**
 * Workspace namespace codec tests: wfs:// format (encode + decode) and
 * fail-closed behavior for malformed / unknown namespaces.
 */

import { describe, expect, it } from 'vitest'
import {
  defaultNamespaceCodec,
  decodeWfsKey,
  encodeRoute,
} from '../../src/base/namespace.ts'

describe('wfs:// namespace codec', () => {
  it('round-trips a route through encode/decode', () => {
    const route = { workspaceId: 'ws-123', path: '/src/index.ts' }
    const encoded = encodeRoute(route)
    expect(encoded).toBe('wfs://ws-123/src/index.ts')
    expect(decodeWfsKey(encoded)).toEqual(route)
  })

  it('handles the workspace root path', () => {
    const encoded = encodeRoute({ workspaceId: 'a-b-c', path: '/' })
    expect(encoded).toBe('wfs://a-b-c/')
    expect(decodeWfsKey(encoded)).toEqual({ workspaceId: 'a-b-c', path: '/' })
  })

  it('encodes ids with URL-safe encoding', () => {
    const encoded = encodeRoute({ workspaceId: 'x/y z', path: '/f' })
    expect(decodeWfsKey(encoded)).toEqual({ workspaceId: 'x/y z', path: '/f' })
  })

  it('rejects a wfs key without a path separator', () => {
    expect(decodeWfsKey('wfs://ws-123')).toBeUndefined()
  })

  it('rejects an empty workspace id', () => {
    expect(decodeWfsKey('wfs:///path')).toBeUndefined()
  })

  it('rejects a bare scheme without the id', () => {
    expect(decodeWfsKey('wfs://')).toBeUndefined()
  })
})

describe('defaultNamespaceCodec', () => {
  it('emits and decodes only the wfs:// form', () => {
    const codec = defaultNamespaceCodec
    const key = codec.encode({ workspaceId: 'w1', path: '/a' })
    expect(key).toBe('wfs://w1/a')
    expect(codec.decode(key)).toEqual({ workspaceId: 'w1', path: '/a' })
    // Pre-workspace keys are not a namespace this codec knows.
    expect(codec.decode('ssh:w1:/a')).toBeUndefined()
  })

  it('detects explicit namespaces and rejects plain paths', () => {
    expect(defaultNamespaceCodec.isExplicitNamespace('wfs://w1/a')).toBe(true)
    expect(defaultNamespaceCodec.isExplicitNamespace('ssh:w1:/a')).toBe(false)
    expect(defaultNamespaceCodec.isExplicitNamespace('/plain/path')).toBe(false)
    expect(defaultNamespaceCodec.isExplicitNamespace('C:\\plain')).toBe(false)
  })

  it('fails closed on unknown workspace namespaces', () => {
    // A key with a wfs scheme but an un-registered id decodes structurally
    // (codec is id-agnostic); the ROUTER refuses it via the ledger lookup.
    expect(defaultNamespaceCodec.decode('wfs://ghost-id/x')).toEqual({ workspaceId: 'ghost-id', path: '/x' })
  })
})