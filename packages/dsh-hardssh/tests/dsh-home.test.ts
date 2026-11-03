// @vitest-environment node

import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { dshHome, dshHomePath } from '../src/dsh-home.ts'

const original = process.env.DSH_HOME

afterEach(() => {
  if (original === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = original
})

describe('dshHome', () => {
  it('defaults to ~/.dsh when DSH_HOME is unset or blank', () => {
    delete process.env.DSH_HOME
    expect(dshHome()).toBe(resolve(join(homedir(), '.dsh')))
    process.env.DSH_HOME = '   '
    expect(dshHome()).toBe(resolve(join(homedir(), '.dsh')))
  })

  it('follows an absolute DSH_HOME override', () => {
    process.env.DSH_HOME = '/srv/profiles/work'
    expect(dshHome()).toBe('/srv/profiles/work')
    expect(dshHomePath('ssh-workspaces')).toBe('/srv/profiles/work/ssh-workspaces')
  })

  it('expands a tilde-prefixed override and resolves a relative one', () => {
    process.env.DSH_HOME = '~/custom-dsh'
    expect(dshHome()).toBe(join(homedir(), 'custom-dsh'))
    process.env.DSH_HOME = 'relative-home'
    expect(dshHome()).toBe(resolve('relative-home'))
  })

  it('joins segments onto the resolved home, empty list = home', () => {
    process.env.DSH_HOME = '/srv/dsh'
    expect(dshHomePath()).toBe('/srv/dsh')
    expect(dshHomePath('workspaces', 'index.v1.json')).toBe('/srv/dsh/workspaces/index.v1.json')
  })
})
