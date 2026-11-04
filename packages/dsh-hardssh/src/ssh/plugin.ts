/**
 * Connection infrastructure surfaces, hosted inside dsh-hardssh: the host
 * config store (~/.dsh/dsh-hardssh-ssh.json), the shared ssh2 engine, and the
 * `/api/dsh-hardssh/ssh/*` routes the workspace UI needs to configure a
 * connection and prompt for credentials.
 *
 * The multi-host SSH operations capability (ssh_* tools, tunnels, cluster
 * execution, terminal console, model-facing SSH announcement) is NOT mounted
 * here; this plugin only makes a remote directory usable as a workspace.
 *
 * This module deliberately does NOT create or dispose the engine/store:
 * ownership belongs to src/index.ts (one instance, one dispose point). It
 * only mounts/unmounts the HTTP surface against the shared instances.
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type { SshEngine } from './engine.ts'
import type { HostStore } from './store.ts'
import { SSH_API } from './protocol.ts'
import { makeRoutes } from './routes.ts'
import { invalidateRemoteEnvironment } from '../remote/environment.ts'

/** Routes the workspace UI keeps: connection config, credentials, health. */
const CORE_ROUTE_PATHS = new Set<string>([
  SSH_API.hosts,
  SSH_API.importSshConfig,
  SSH_API.knownHosts,
  SSH_API.vault,
  SSH_API.sessionSecret,
  SSH_API.health,
  SSH_API.connections,
  SSH_API.test,
  SSH_API.ls,
])

/** Shared instances the connection surfaces run on. */
export interface SshCapabilityDeps {
  store: import('./store.ts').SecureHostStore
  engine: SshEngine
  /** Host-key TOFU trust store; absent → host-key verification disabled. */
  knownHosts?: import('./known-hosts.ts').KnownHostsStore
  /** Credential vault; absent → vault endpoints disabled. */
  vault?: import('./vault.ts').Vault
  /** SSH-bound workspace record source (host-delete reference guard): the
   *  WorkspaceCore-backed projection store. */
  ledger?: import('../backend.ts').WorkspaceStoreView
  /** Compatibility/degradation registry served by `/api/dsh-hardssh/ssh/health`. */
  health?: import('../runtime/health.ts').HardsshHealthRegistry
}

/**
 * Mount the connection-configuration routes against the shared engine/store.
 * Called from src/index.ts BEFORE the workspace `enabled` early-return, so a
 * GUI can still configure the connection a workspace will use.
 */
export function mountSshCapability(ctx: Context, deps: SshCapabilityDeps): void {
  const { routes } = makeRoutes({
    store: deps.store,
    engine: deps.engine,
    knownHosts: deps.knownHosts,
    vault: deps.vault,
    ledger: deps.ledger,
    health: deps.health,
    // Host PATCH/DELETE also invalidates the per-alias environment cache so
    // a re-pointed alias cannot keep serving the old host's env.
    onHostInvalidated: (alias) => invalidateRemoteEnvironment(deps.engine, alias),
  })
  const coreRoutes = routes.filter(route => CORE_ROUTE_PATHS.has(route.path))
  ctx.inject(['webServer'], (scoped) => {
    const disposers = coreRoutes.map(route => scoped.webServer.register(route))
    return () => {
      for (const routeDisposer of disposers) routeDisposer()
    }
  })
}
