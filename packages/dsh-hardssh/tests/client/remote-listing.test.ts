// @vitest-environment node

import { describe, expect, it } from 'vitest'
import {
  joinRemotePath,
  remoteCrumbs,
  remoteWorkspaceTitle,
  toPickerListing,
} from '../../src/client/remote-listing.ts'

describe('remoteCrumbs', () => {
  it('builds the POSIX ancestor chain inclusive of the target', () => {
    expect(remoteCrumbs('/home/u/proj')).toEqual([
      { name: '/', path: '/', hidden: false },
      { name: 'home', path: '/home', hidden: false },
      { name: 'u', path: '/home/u', hidden: false },
      { name: 'proj', path: '/home/u/proj', hidden: false },
    ])
  })

  it('keeps the root as a single crumb', () => {
    expect(remoteCrumbs('/')).toEqual([{ name: '/', path: '/', hidden: false }])
  })
})

describe('toPickerListing', () => {
  it('lists directories only and flags dot names hidden', () => {
    const listing = toPickerListing({
      path: '/home/u',
      entries: [
        { name: 'proj', type: 'dir' },
        { name: 'README.md', type: 'file' },
        { name: '.config', type: 'dir' },
        { name: 'link', type: 'other' },
      ],
    }, '/home/u')
    expect(listing).toEqual({
      path: '/home/u',
      home: '/home/u',
      crumbs: remoteCrumbs('/home/u'),
      entries: [
        { name: 'proj', path: '/home/u/proj', hidden: false },
        { name: '.config', path: '/home/u/.config', hidden: true },
      ],
      truncated: false,
    })
  })

  it('treats an empty host path as the POSIX root', () => {
    const listing = toPickerListing({ path: '', entries: [] }, '/')
    expect(listing.path).toBe('/')
    expect(listing.crumbs).toEqual([{ name: '/', path: '/', hidden: false }])
  })
})

describe('joinRemotePath and remoteWorkspaceTitle', () => {
  it('joins without doubling the separator', () => {
    expect(joinRemotePath('/home/u', 'proj')).toBe('/home/u/proj')
    expect(joinRemotePath('/home/u/', 'proj')).toBe('/home/u/proj')
    expect(joinRemotePath('/', 'home')).toBe('/home')
  })

  it('derives the workspace title from the picked basename', () => {
    expect(remoteWorkspaceTitle('/home/u/proj', 'aliyun')).toBe('proj')
    expect(remoteWorkspaceTitle('/home/u/proj/', 'aliyun')).toBe('proj')
    expect(remoteWorkspaceTitle('/', 'aliyun')).toBe('aliyun')
  })
})
