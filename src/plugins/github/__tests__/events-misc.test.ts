import { describe, it, expect } from 'vitest'
import { renderCreate, renderDelete, renderFork, renderMilestone, renderStar } from '../events/misc'

const opts = { bodyMaxLength: 500 }
const repo = { full_name: 'org/repo' }

describe('renderCreate / renderDelete', () => {
  it('create a branch', () => {
    expect(renderCreate({ repository: repo, ref: 'feature', ref_type: 'branch', sender: { login: 'alice' } }, opts))
      .toBe('alice created branch org/repo:feature')
  })
  it('create a tag uses @', () => {
    expect(renderCreate({ repository: repo, ref: 'v1', ref_type: 'tag', sender: { login: 'alice' } }, opts))
      .toBe('alice created tag org/repo@v1')
  })
  it('delete a branch', () => {
    expect(renderDelete({ repository: repo, ref: 'feature', ref_type: 'branch', sender: { login: 'alice' } }, opts))
      .toBe('alice deleted branch org/repo:feature')
  })
})

describe('renderFork', () => {
  it('renders forker + source + destination + total', () => {
    expect(renderFork({ repository: { full_name: 'org/repo', forks_count: 7 }, sender: { login: 'alice' }, forkee: { full_name: 'alice/repo' } }, opts))
      .toBe('alice forked org/repo to alice/repo (total 7 forks)')
  })
})

describe('renderMilestone', () => {
  const base = { repository: repo, sender: { login: 'alice' }, milestone: { title: 'v2' } }
  it('opened', () => {
    expect(renderMilestone({ ...base, action: 'opened' }, opts)).toBe('alice opened milestone v2 for org/repo')
  })
  it('closed', () => {
    expect(renderMilestone({ ...base, action: 'closed' }, opts)).toBe('alice closed milestone v2 for org/repo')
  })
  it('other actions -> null', () => {
    expect(renderMilestone({ ...base, action: 'edited' }, opts)).toBeNull()
  })
})

describe('renderStar', () => {
  it('created: starrer + repo + total', () => {
    expect(renderStar({ action: 'created', repository: { full_name: 'org/repo', stargazers_count: 42 }, sender: { login: 'alice' } }, opts))
      .toBe('alice starred org/repo (total 42 stargazers)')
  })
  it('deleted (unstar) -> null', () => {
    expect(renderStar({ action: 'deleted', repository: { full_name: 'org/repo', stargazers_count: 41 }, sender: { login: 'alice' } }, opts)).toBeNull()
  })
})
