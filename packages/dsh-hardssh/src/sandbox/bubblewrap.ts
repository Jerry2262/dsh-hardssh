/** Remote bwrap file-effect profile. Mirrors DSH's local read-only root,
 * private /dev and PID namespace, with writable workspace + private /tmp only
 * in workspace-write. No network namespace: SSH workspace networking stays native. */
import type { SandboxMode } from '@deepseek-ai/dsh-sandbox'

export function bubblewrapArgs(mode: SandboxMode, workspaceRoot: string): string[] {
  if (mode !== 'read-only' && mode !== 'workspace-write') {
    throw new Error(`bwrap requires a confined mode (got '${mode}')`)
  }
  const args = [
    '--unshare-user', '--unshare-pid', '--die-with-parent', '--new-session',
    '--ro-bind', '/', '/', '--dev', '/dev', '--remount-ro', '/dev',
    '--proc', '/proc', '--remount-ro', '/proc', '--cap-drop', 'ALL',
  ]
  if (mode === 'workspace-write') args.push('--tmpfs', '/tmp', '--bind', workspaceRoot, workspaceRoot)
  return args
}
