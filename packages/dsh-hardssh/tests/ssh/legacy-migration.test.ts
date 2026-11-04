/**
 * Legacy-name migration: the pre-rename `dsh-ssh` host store and vault files
 * must move to the `dsh-hardssh` names exactly once, without data loss.
 *
 * The rename is a one-way door: the old files are deleted after the new file
 * is in place, so both the migration helper and the default-path constructors
 * (which trigger it) are pinned here.
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { HostStore, legacyStorePath, migrateLegacyStoreFile, storePath } from '../../src/ssh/store.ts'
import { Vault, legacyVaultPath, migrateLegacyVaultFile, vaultPath } from '../../src/ssh/vault.ts'

const dirs: string[] = []
const originalHome = process.env.DSH_HOME

function makeDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  dirs.push(dir)
  return dir
}

afterEach(() => {
  if (originalHome === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = originalHome
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const hostEntry = {
  alias: 'aliyun',
  host: '10.0.0.1',
  port: 22,
  user: 'jerry',
  auth: { kind: 'key', keyPath: '/home/jerry/.ssh/id_ed25519' },
  proxyJump: [],
  tags: [],
  createdAt: 1,
  updatedAt: 1,
}

function storeDocument(): string {
  return JSON.stringify({ version: 1, hosts: [hostEntry] }, null, 2) + '\n'
}

/** A valid empty vault document (shape-checked by Vault.load). */
function vaultDocument(): string {
  return JSON.stringify({
    version: 1,
    kdf: { algorithm: 'scrypt', N: 131072, r: 8, p: 1, saltB64: '' },
    verifier: { nonceB64: '', ciphertextB64: '', tagB64: '', aad: '' },
    meta: { attempts: 0, lockedUntil: 0 },
    secrets: [],
  }) + '\n'
}

describe('legacy host-store migration', () => {
  it('moves the old file to the new name, preserves bytes and 0600 mode', () => {
    const dir = makeDir('dsh-hardssh-store-migrate-')
    const legacy = join(dir, 'dsh-ssh.json')
    const target = join(dir, 'dsh-hardssh-ssh.json')
    writeFileSync(legacy, storeDocument(), { mode: 0o600 })

    expect(migrateLegacyStoreFile(target, legacy)).toBe(true)
    expect(readFileSync(target, 'utf8')).toBe(storeDocument())
    expect(statSync(target).mode & 0o777).toBe(0o600)
    expect(existsSync(legacy)).toBe(false)
  })

  it('leaves an existing target alone and does nothing without a legacy file', () => {
    const dir = makeDir('dsh-hardssh-store-noop-')
    const legacy = join(dir, 'dsh-ssh.json')
    const target = join(dir, 'dsh-hardssh-ssh.json')
    writeFileSync(target, '{"version":1,"hosts":[]}\n')
    writeFileSync(legacy, storeDocument())

    expect(migrateLegacyStoreFile(target, legacy)).toBe(false)
    expect(readFileSync(target, 'utf8')).toBe('{"version":1,"hosts":[]}\n')
    expect(existsSync(legacy)).toBe(true)

    const empty = join(dir, 'missing.json')
    expect(migrateLegacyStoreFile(join(dir, 'unused.json'), empty)).toBe(false)
  })
})

describe('legacy vault migration', () => {
  it('moves the old file to the new name, preserves bytes and 0600 mode', () => {
    const dir = makeDir('dsh-hardssh-vault-migrate-')
    const legacy = join(dir, 'dsh-ssh-vault.json')
    const target = join(dir, 'dsh-hardssh-ssh-vault.json')
    writeFileSync(legacy, vaultDocument(), { mode: 0o600 })

    expect(migrateLegacyVaultFile(target, legacy)).toBe(true)
    expect(readFileSync(target, 'utf8')).toBe(vaultDocument())
    expect(statSync(target).mode & 0o777).toBe(0o600)
    expect(existsSync(legacy)).toBe(false)
  })

  it('leaves an existing target alone', () => {
    const dir = makeDir('dsh-hardssh-vault-noop-')
    const legacy = join(dir, 'dsh-ssh-vault.json')
    const target = join(dir, 'dsh-hardssh-ssh-vault.json')
    writeFileSync(target, vaultDocument())
    writeFileSync(legacy, vaultDocument())

    expect(migrateLegacyVaultFile(target, legacy)).toBe(false)
    expect(existsSync(legacy)).toBe(true)
  })
})

describe('default path constructors migrate the legacy files', () => {
  it('HostStore at the default path reads the migrated hosts', () => {
    const home = makeDir('dsh-hardssh-home-store-')
    process.env.DSH_HOME = home
    mkdirSync(home, { recursive: true })
    writeFileSync(legacyStorePath(), storeDocument(), { mode: 0o600 })

    const store = new HostStore()
    expect(store.list().map(entry => entry.alias)).toEqual(['aliyun'])
    expect(existsSync(storePath())).toBe(true)
    expect(existsSync(legacyStorePath())).toBe(false)
  })

  it('Vault at the default path loads the migrated document', () => {
    const home = makeDir('dsh-hardssh-home-vault-')
    process.env.DSH_HOME = home
    mkdirSync(join(home, 'ssh-secrets'), { recursive: true, mode: 0o700 })
    writeFileSync(legacyVaultPath(), vaultDocument(), { mode: 0o600 })

    expect(() => new Vault()).not.toThrow()
    expect(existsSync(vaultPath())).toBe(true)
    expect(existsSync(legacyVaultPath())).toBe(false)
  })
})
