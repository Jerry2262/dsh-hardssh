/**
 * Live `~/.ssh/config` reading.
 *
 * The file becomes a host SOURCE instead of a one-shot import snapshot, the way
 * VS Code Remote-SSH treats it. These cases pin the parser's contract, including
 * the two block kinds the plugin cannot address (they are reported, not silently
 * dropped) and the missing-file behaviour that keeps the plugin usable for users
 * who never create that file.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { parseSshConfigText, readSshConfig, sshConfigHostMap, withSshConfig } from '../../src/ssh/ssh-config.ts'
import type { SshHostEntry } from '../../src/ssh/protocol.ts'

const created: string[] = []

function tempConfig(text: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-sshconfig-'))
  created.push(dir)
  const path = join(dir, 'config')
  writeFileSync(path, text)
  return path
}

afterEach(() => {
  for (const dir of created.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('parseSshConfigText', () => {
  it('reads the modelled fields of a block', () => {
    const read = parseSshConfigText([
      'Host gpu',
      '  HostName 10.0.0.5',
      '  Port 2222',
      '  User alice',
      '  IdentityFile ~/.ssh/id_rsa_server_a',
      '  ProxyJump bastion',
    ].join('\n'))
    expect(read.skipped).toEqual([])
    expect(read.hosts).toEqual([{
      alias: 'gpu',
      host: '10.0.0.5',
      port: 2222,
      user: 'alice',
      identityFile: '~/.ssh/id_rsa_server_a',
      proxyJump: ['bastion'],
    }])
  })

  it('applies OpenSSH defaults and ignores comments/blank lines and unknown keywords', () => {
    const read = parseSshConfigText([
      '# a comment',
      '',
      'Host simple',
      '    hostname    example.org',
      '    Compression yes',
      '    ServerAliveInterval 30',
    ].join('\n'))
    expect(read.hosts).toHaveLength(1)
    expect(read.hosts[0]).toMatchObject({ alias: 'simple', host: 'example.org', port: 22, proxyJump: [] })
  })

  it('is case-insensitive on keywords', () => {
    const read = parseSshConfigText('HOST A\nhostname a.example\nUSER bob\nPORT 2022\nidentityfile ~/.ssh/k\n')
    expect(read.hosts[0]).toMatchObject({ alias: 'A', host: 'a.example', user: 'bob', port: 2022, identityFile: '~/.ssh/k' })
  })

  it('takes the FIRST IdentityFile — ssh2 attempts one key per connection', () => {
    const read = parseSshConfigText('Host two\nHostName h\nIdentityFile ~/.ssh/first\nIdentityFile ~/.ssh/second\n')
    expect(read.hosts[0]!.identityFile).toBe('~/.ssh/first')
  })

  it('splits comma-separated ProxyJump hops', () => {
    const read = parseSshConfigText('Host deep\nHostName h\nProxyJump a,b , c\n')
    expect(read.hosts[0]!.proxyJump).toEqual(['a', 'b', 'c'])
  })

  it('reports wildcard patterns instead of treating them as addresses', () => {
    const read = parseSshConfigText('Host *\n  User root\n\nHost web-?\n  HostName w\n\nHost real\n  HostName r\n')
    expect(read.hosts.map(host => host.alias)).toEqual(['real'])
    expect(read.skipped.map(skip => skip.reason)).toEqual(['wildcard', 'wildcard'])
  })

  it('reports a block without HostName', () => {
    const read = parseSshConfigText('Host just-a-name\n  User bob\n')
    expect(read.hosts).toEqual([])
    expect(read.skipped).toEqual([{ pattern: 'just-a-name', reason: 'no-hostname' }])
  })

  it('reports a multi-pattern Host block rather than guessing which name is meant', () => {
    const read = parseSshConfigText('Host a b\n  HostName shared\n')
    expect(read.hosts).toEqual([])
    expect(read.skipped).toEqual([{ pattern: 'a b', reason: 'wildcard' }])
  })

  it('keeps duplicate blocks addressable and lets the map take the earliest', () => {
    const path = tempConfig('Host dup\nHostName first\n\nHost dup\nHostName second\n')
    expect(readSshConfig(path).hosts.map(host => host.host)).toEqual(['first', 'second'])
    expect(sshConfigHostMap(path).get('dup')?.host).toBe('first')
  })
})

describe('readSshConfig', () => {
  it('treats a missing file as an empty source, not an error', () => {
    const missing = join(mkdtempSync(join(tmpdir(), 'dsh-sshconfig-missing-')), 'config')
    created.push(missing)
    expect(readSshConfig(missing)).toEqual({ hosts: [], skipped: [] })
    expect(sshConfigHostMap(missing).size).toBe(0)
  })

  it('maps every addressable host by alias', () => {
    const path = tempConfig('Host a\nHostName a.example\n\nHost b\nHostName b.example\n')
    expect([...sshConfigHostMap(path).keys()]).toEqual(['a', 'b'])
  })
})

describe('withSshConfig (stored entries override live ones)', () => {
  function storedEntry(alias: string, host: string): SshHostEntry {
    return {
      alias, host, port: 22, user: 'stored-user',
      auth: { kind: 'key', keyPath: '~/.ssh/stored-key' },
      proxyJump: [], tags: [], createdAt: 1, updatedAt: 1,
    }
  }

  function view(entries: SshHostEntry[]) {
    const map = new Map(entries.map(entry => [entry.alias, entry]))
    return {
      path: '/tmp/dsh-hardssh-ssh.json',
      list: () => [...map.values()],
      find: (alias: string) => map.get(alias),
      summarize: (entry: SshHostEntry) => ({ alias: entry.alias, host: entry.host }),
    }
  }

  it('adds live hosts and lets stored entries win on the same alias', () => {
    const configPath = tempConfig('Host live\nHostName live.example\n\nHost shared\nHostName from-config\n')
    const composed = withSshConfig(view([storedEntry('shared', 'from-store')]), configPath)
    const byAlias = new Map(composed.list().map(entry => [entry.alias, entry]))
    expect([...byAlias.keys()].sort()).toEqual(['live', 'shared'])
    // The GUI override layer wins.
    expect(byAlias.get('shared')?.host).toBe('from-store')
    expect(composed.find('shared')?.host).toBe('from-store')
  })

  it('maps an IdentityFile block to key auth and a bare block to password-with-no-secret', () => {
    const configPath = tempConfig([
      'Host keyed',
      'HostName k.example',
      'IdentityFile ~/.ssh/id_rsa_server_a',
      '',
      'Host bare',
      'HostName b.example',
    ].join('\n'))
    const composed = withSshConfig(view([]), configPath)
    expect(composed.find('keyed')?.auth).toEqual({ kind: 'key', keyPath: '~/.ssh/id_rsa_server_a' })
    // No secret: the engine tries keys/agent first and only then prompts.
    expect(composed.find('bare')?.auth).toEqual({ kind: 'password' })
  })

  it('answers undefined for an alias present in neither layer', () => {
    const composed = withSshConfig(view([]), tempConfig('Host only\nHostName o.example\n'))
    expect(composed.find('nope')).toBeUndefined()
  })
})
