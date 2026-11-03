import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  HARDSSH_CONTRACT,
  TESTED_DSH_RANGE,
  TESTED_NODE_RANGE,
  probeOptionalServices,
} from '../../src/runtime/compat-contract.ts'

interface PackageManifest {
  peerDependencies: Record<string, string>
}

const repoRoot = resolve(import.meta.dirname, '../../../..')
const packageJson = JSON.parse(readFileSync(resolve(repoRoot, 'packages/dsh-hardssh/package.json'), 'utf8')) as PackageManifest

/** A Context stand-in answering `get()` from a plain service table. */
function probingContext(services: Record<string, unknown>): Parameters<typeof probeOptionalServices>[0] {
  return { get: (name: string) => services[name] } as unknown as Parameters<typeof probeOptionalServices>[0]
}

describe('runtime compatibility contract', () => {
  it('lists every required runtime export and the installed test set supplies it', async () => {
    const required = HARDSSH_CONTRACT.filter(entry => entry.kind === 'required-runtime')
    expect(required.length).toBeGreaterThan(0)
    for (const entry of required) {
      const loaded = await import(entry.packageName) as Record<string, unknown>
      for (const name of entry.exports ?? []) {
        expect(loaded[name], `${entry.packageName} must export ${name}`).toBeDefined()
      }
    }
  })

  it('keeps optional Cordis services optional in a minimal context', async () => {
    const { Context } = await import('@deepseek-ai/cordis')
    const probes = probeOptionalServices(new Context())
    expect(probes.map(probe => probe.service)).toEqual(['webServer', 'settings', 'systemPrompt'])
    expect(probes.every(probe => !probe.available && probe.missingMethods.length > 0)).toBe(true)
  })

  it('accepts every generation of the settings surface', async () => {
    // 0.1.x installs a section; 0.2.0 replaced the service with `SettingsForms`
    // and generates the page from the plugin's own Config schema. Probing only
    // the old name made the plugin report `settings` as unavailable on 0.2.0
    // while the configuration UI was in fact working.
    const old = probeOptionalServices(probingContext({ settings: { installSection: () => undefined } }))
    expect(old.find(probe => probe.service === 'settings')).toEqual({ service: 'settings', available: true, missingMethods: [] })

    const modern = probeOptionalServices(probingContext({ settings: { configure: () => undefined, describe: () => [] } }))
    expect(modern.find(probe => probe.service === 'settings')).toEqual({ service: 'settings', available: true, missingMethods: [] })
  })

  it('reports the closest generation when the settings surface is genuinely absent', () => {
    // Nothing usable: report the smaller gap (the 0.1.x surface) rather than
    // concatenating both generations into a confusing list.
    const empty = probeOptionalServices(probingContext({ settings: {} })).find(probe => probe.service === 'settings')
    expect(empty).toEqual({ service: 'settings', available: false, missingMethods: ['installSection'] })

    const partial = probeOptionalServices(probingContext({ settings: { describe: () => [] } })).find(probe => probe.service === 'settings')
    expect(partial).toEqual({ service: 'settings', available: false, missingMethods: ['configure'] })
  })

  it('publishes bounded compatibility claims, never an unbounded wildcard', () => {
    expect(TESTED_DSH_RANGE).toBe('>=0.1.5-rc.1 <0.1.7 || >=0.1.6-alpha.1')
    expect(TESTED_NODE_RANGE).toContain('22.19')
    for (const [name, range] of Object.entries(packageJson.peerDependencies)) {
      if (name.startsWith('@deepseek-ai/')) expect(range, `${name} must be bounded`).not.toBe('*')
    }
  })
})
