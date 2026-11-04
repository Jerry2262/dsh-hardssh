/**
 * Model-facing path translation for SSH-bound sessions.
 *
 * A bound session's kernel cwd is its LOCAL anchor directory, because the
 * anchor is what the host workspace registry and the fs/subprocess seams route
 * on. The model never needs to see that client-side placeholder: bash runs on
 * the server, so `pwd` prints the remote root, and every path the model reads
 * should be the same path. The rewrite happens at the last boundary before the
 * provider call (`llm/stream`), so internal consumers keep the anchor identity
 * while the wire carries one consistent remote path.
 *
 * Pure helpers first (testable without Cordis), then the mount.
 *
 * @module dsh-hardssh/runtime/remote-context
 */

import { symbols } from '@deepseek-ai/cordis'
import type { Context } from '@deepseek-ai/cordis'
import type { WorkspaceCore } from './workspace-core.ts'

/** One anchor → remote-root pair the wire rewrite applies. */
export interface RemoteBinding {
  anchorPath: string
  remoteRoot: string
}

/** Collect every SSH binding from the workspace ledger snapshot. */
export function remoteBindings(core: WorkspaceCore): RemoteBinding[] {
  return core.ledger.snapshotSync().records
    .filter(record => record.provider.id === 'ssh')
    .flatMap((record) => {
      const anchorPath = record.anchor?.path ?? ''
      const remoteRoot = record.location.root
      return anchorPath === '' || anchorPath === remoteRoot ? [] : [{ anchorPath, remoteRoot }]
    })
}

/**
 * Rewrite every client-side anchor spelling in one model-visible string to the
 * remote root it stands for. Both the plain form and the JSON-escaped form are
 * replaced (model text stores paths through `JSON.stringify`, which doubles
 * backslashes on Windows).
 */
export function translateAnchorText(text: string, binding: RemoteBinding): string {
  let out = text
  if (out.includes(binding.anchorPath)) out = out.split(binding.anchorPath).join(binding.remoteRoot)
  const escapedAnchor = JSON.stringify(binding.anchorPath).slice(1, -1)
  const escapedRemote = JSON.stringify(binding.remoteRoot).slice(1, -1)
  if (escapedAnchor !== binding.anchorPath && out.includes(escapedAnchor)) {
    out = out.split(escapedAnchor).join(escapedRemote)
  }
  return out
}

/** Rewrite one string through every binding. */
export function translateString(text: string, bindings: readonly RemoteBinding[]): string {
  let out = text
  for (const binding of bindings) out = translateAnchorText(out, binding)
  return out
}

/** Plain-object / array test that never traverses binary or class instances. */
function isTraversable(value: unknown): value is Record<string, unknown> | unknown[] {
  if (Array.isArray(value)) return true
  if (value === null || typeof value !== 'object') return false
  const prototype = Object.getPrototypeOf(value) as unknown
  return prototype === Object.prototype || prototype === null
}

/**
 * Rewrite every string reachable through plain objects and arrays, returning a
 * new value. Request messages arrive FROZEN (`role` and friends are read-only
 * properties), so this never assigns into the input — it clones plain objects
 * and arrays and leaves class instances (images, attachments) untouched.
 */
export function rewriteValue(value: unknown, bindings: readonly RemoteBinding[]): unknown {
  if (typeof value === 'string') return translateString(value, bindings)
  if (Array.isArray(value)) {
    let changed = false
    const next = new Array<unknown>(value.length)
    for (let index = 0; index < value.length; index += 1) {
      next[index] = rewriteValue(value[index], bindings)
      if (next[index] !== value[index]) changed = true
    }
    return changed ? next : value
  }
  if (!isTraversable(value)) return value
  const record = value as Record<string, unknown>
  let clone: Record<string, unknown> | undefined
  for (const key of Object.keys(record)) {
    const rewritten = rewriteValue(record[key], bindings)
    if (rewritten === record[key]) continue
    clone ??= { ...record }
    clone[key] = rewritten
  }
  return clone ?? value
}

/**
 * Shallow-clone one generate-options object with model-visible strings
 * translated. Options arrive frozen (the loop deep-freezes its request), so the
 * provider must be called with a replacement object rather than a mutated one.
 * Non-plain values (AbortSignal, tool schemas, attachment refs) keep identity;
 * when no binding matches, the exact original object is returned.
 */
export function rewriteGenerateOptions(options: unknown, bindings: readonly RemoteBinding[]): unknown {
  if (bindings.length === 0) return options
  const record = options as Record<string, unknown>
  const system = record.system
  const messages = record.messages
  const nextSystem = typeof system === 'string' ? translateString(system, bindings) : system
  const nextMessages = Array.isArray(messages) ? rewriteValue(messages, bindings) : messages
  if (nextSystem === system && nextMessages === messages) return options
  return {
    ...record,
    ...(nextSystem !== system ? { system: nextSystem } : {}),
    ...(nextMessages !== messages ? { messages: nextMessages } : {}),
  }
}

/** Minimal shape of the LLM runtime methods this module wraps. */
interface LlmStreamLike {
  /** Both prepared and direct calls funnel through this one. */
  streamWithRegistration?: (options: unknown, ...rest: unknown[]) => unknown
  stream?: (options: unknown, ...rest: unknown[]) => unknown
}

/**
 * Mount the wire rewrite by wrapping the LLM runtime's request funnel. The
 * public `llm/stream` waterfall receives a deep-frozen options object, so a
 * listener cannot rewrite it; the one internal method both direct and prepared
 * calls pass through is the narrowest seam before the adapter sees a request.
 *
 * Optional integration: a host without the `llm` service never mounts. A shape
 * change fails open (the original method is left untouched) instead of breaking
 * every model call.
 */
export function mountRemoteWireTranslation(ctx: Context, bindings: () => RemoteBinding[]): void {
  ctx.inject(['llm'], (scoped) => {
    const service = scoped.get('llm') as Partial<LlmStreamLike> | undefined
    // `ctx.get` returns a Cordis traceable proxy; its `symbols.original` slot is
    // the real service instance the prototype methods live on.
    const target = unwrapTraceable(service)
    const method = target?.streamWithRegistration !== undefined && typeof target.streamWithRegistration === 'function'
      ? 'streamWithRegistration' as const
      : 'stream' as const
    const original = target?.[method]
    if (target === undefined || typeof original !== 'function') return
    const patched = function (this: unknown, options: unknown, ...rest: unknown[]): unknown {
      return original.call(this, rewriteGenerateOptions(options, bindings()), ...rest)
    }
    return assignStream(target, method, original, patched)
  })
}

/** The raw service behind a Cordis traceable proxy, when present. */
function unwrapTraceable<T>(service: T): (T & Partial<LlmStreamLike>) | undefined {
  if (service === undefined || service === null) return undefined
  const originalSymbol = (symbols as unknown as Record<string, symbol | undefined>).original
  const raw = originalSymbol === undefined
    ? undefined
    : (service as unknown as Record<symbol, unknown>)[originalSymbol]
  const candidate = raw !== null && typeof raw === 'object' ? raw : service
  return candidate as T & Partial<LlmStreamLike>
}

/**
 * Install `patched` where callers read `service.stream`. A Cordis service may
 * reject an own-property definition, so this falls back to the shared prototype
 * method. Returns the undo action, or undefined when the method cannot be
 * replaced without breaking the service.
 */
function assignStream(
  service: Partial<LlmStreamLike>,
  method: 'streamWithRegistration' | 'stream',
  original: (options: unknown, ...rest: unknown[]) => unknown,
  patched: (options: unknown, ...rest: unknown[]) => unknown,
): (() => void) | undefined {
  const restoreInstance = (): void => { service[method] = original }
  try {
    Object.defineProperty(service, method, {
      value: patched,
      configurable: true,
      writable: true,
      enumerable: false,
    })
    if (service[method] === patched) return restoreInstance
  } catch {
    // fall through to the prototype
  }
  const prototype = Object.getPrototypeOf(service) as Partial<LlmStreamLike> | null
  if (prototype === null || prototype[method] !== original) return undefined
  try {
    Object.defineProperty(prototype, method, {
      value: patched,
      configurable: true,
      writable: true,
      enumerable: false,
    })
  } catch {
    return undefined
  }
  if (prototype[method] !== patched) return undefined
  return () => {
    if (prototype[method] === patched) prototype[method] = original
  }
}
