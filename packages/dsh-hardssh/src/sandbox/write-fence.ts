/**
 * Remote write fence: the same policy contract the native `fs-sandbox`
 * enforces locally, applied to canonical REMOTE paths.
 *
 * The fence is a trusted-code containment check over a model-controlled path,
 * not a kernel boundary — identical in nature to `@deepseek-ai/dsh-fs-sandbox`
 * (which documents itself the same way). The workspace root arrives already
 * translated from the client anchor to the server root.
 *
 * @module dsh-hardssh/sandbox/write-fence
 */

import { FsError } from '@deepseek-ai/dsh-fs'
import type { SandboxExecutionPolicy } from '@deepseek-ai/dsh-sandbox'

/** Writable roots of one remote `workspace-write` policy: the workspace root
 *  plus the server temp area, mirroring the native `writableRoots` shape. */
function writableRoots(policy: SandboxExecutionPolicy): string[] {
  return [policy.workspaceRoot, '/tmp']
}

/** Throw unless `targetPath` (already canonical) may be mutated under `policy`. */
export function assertRemoteWritable(
  targetPath: string,
  displayPath: string,
  policy: SandboxExecutionPolicy | undefined,
): void {
  if (policy === undefined) return
  const { mode } = policy
  if (mode === 'danger-full-access') return
  if (mode === 'read-only') {
    throw new FsError(`cannot write "${displayPath}": file access denied under read-only mode`, 'FS_SANDBOX_DENIED')
  }
  const contained = writableRoots(policy).some((root) => {
    const prefix = root.endsWith('/') ? root : `${root}/`
    return targetPath === root || targetPath.startsWith(prefix)
  })
  if (!contained) {
    throw new FsError(`cannot write "${displayPath}": file access denied under workspace-write mode`, 'FS_SANDBOX_DENIED')
  }
}
