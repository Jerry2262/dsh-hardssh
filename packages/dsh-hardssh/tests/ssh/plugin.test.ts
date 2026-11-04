/**
 * The plugin now mounts ONLY the connection-configuration surface a workspace
 * needs (hosts / import / known-hosts / vault / session secret / health /
 * connections / test / ls). The multi-host SSH-operations surface was removed:
 * no terminal upgrade, no exec/cluster/transfer/tunnel routes, no ssh_* agent
 * tools, no model-facing SSH announcement.
 */

import { describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'
import { SSH_API } from '../../src/ssh/protocol.ts'
import { mountSshCapability } from '../../src/ssh/plugin.ts'
import type { SshEngine } from '../../src/ssh/engine.ts'
import type { SecureHostStore } from '../../src/ssh/store.ts'

const CORE_PATHS = [
  SSH_API.hosts,
  SSH_API.importSshConfig,
  SSH_API.knownHosts,
  SSH_API.vault,
  SSH_API.sessionSecret,
  SSH_API.health,
  SSH_API.connections,
  SSH_API.test,
  SSH_API.ls,
]

const REMOVED_PATHS = [
  SSH_API.exec,
  SSH_API.cluster,
  SSH_API.tunnel,
  SSH_API.upload,
  SSH_API.download,
  SSH_API.terminal,
]

function mount(): { routes: WebRoute[]; upgradeCalls: number } {
  const routes: WebRoute[] = []
  let upgradeCalls = 0
  const scoped = {
    webServer: {
      register(route: WebRoute) {
        routes.push(route)
        return () => undefined
      },
      registerUpgrade() {
        upgradeCalls += 1
        return () => undefined
      },
    },
  }
  const ctx = {
    inject(_names: string[], callback: (scope: unknown) => unknown) {
      callback(scoped)
      return () => undefined
    },
  } as unknown as Context
  mountSshCapability(ctx, {
    store: {} as SecureHostStore,
    engine: {} as SshEngine,
  })
  return { routes, upgradeCalls }
}

describe('mountSshCapability', () => {
  it('mounts only the workspace connection routes', () => {
    const { routes } = mount()
    expect(routes.map(route => route.path).sort()).toEqual([...CORE_PATHS].sort())
    for (const removed of REMOVED_PATHS) {
      expect(routes.some(route => route.path === removed)).toBe(false)
    }
  })

  it('never registers the terminal upgrade', () => {
    expect(mount().upgradeCalls).toBe(0)
  })
})
