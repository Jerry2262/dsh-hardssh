/**
 * The vendored Landlock launcher: architecture mapping, grant spelling, probe
 * parsing, and the integrity of the shipped binaries.
 */

import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  archForUnameMachine,
  grantArgs,
  parseProbe,
  runnerAssetFor,
} from '../../src/sandbox/landlock.ts'

describe('archForUnameMachine', () => {
  it('maps the supported Linux machines and rejects everything else', () => {
    expect(archForUnameMachine('x86_64')).toBe('linux-x64')
    expect(archForUnameMachine('amd64')).toBe('linux-x64')
    expect(archForUnameMachine('aarch64')).toBe('linux-arm64')
    expect(archForUnameMachine('arm64')).toBe('linux-arm64')
    expect(archForUnameMachine('mips64')).toBeUndefined()
    expect(archForUnameMachine('')).toBeUndefined()
  })
})

describe('parseProbe', () => {
  it('reads full/partial only on a zero exit', () => {
    expect(parseProbe('landlock: fully enforced\n', 0)).toBe('full')
    expect(parseProbe('landlock: partially enforced\n', 0)).toBe('partial')
    expect(parseProbe('landlock: fully enforced\n', 1)).toBeUndefined()
    expect(parseProbe('', null)).toBeUndefined()
  })
})

describe('grantArgs', () => {
  it('mirrors the native Landlock profile', () => {
    expect(grantArgs('read-only', '/home/u/ws')).toEqual(['--ro', '/', '--rw', '/dev/null'])
    expect(grantArgs('workspace-write', '/home/u/ws')).toEqual([
      '--ro', '/', '--rw', '/dev/null', '--rw', '/tmp', '--rw', '/home/u/ws',
    ])
  })
})

describe('vendored launcher assets', () => {
  it('ships a static ELF for both supported arches with a matching hash', async () => {
    for (const arch of ['linux-x64', 'linux-arm64'] as const) {
      const asset = await runnerAssetFor(arch)
      const bytes = readFileSync(asset.path)
      expect(bytes.subarray(0, 4).toString('latin1')).toBe('\x7fELF')
      expect(asset.sha256).toBe(createHash('sha256').update(bytes).digest('hex'))
      if (arch === 'linux-x64') expect(bytes[18]).toBe(0x3e) // e_machine: x86-64
      else expect(bytes[18]).toBe(0xb7) // e_machine: AArch64
    }
  })
})
