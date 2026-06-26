import { describe, it, expect } from 'vitest'

import { filterPostImages } from '../filter'
import type { GelbooruPost } from '../client'

function makePost(over: Partial<GelbooruPost> = {}): GelbooruPost {
  return {
    id: 1,
    score: 10,
    rating: 'general',
    tags: '1girl silver_hair smile',
    sample_url: 'https://img.example/sample.jpg',
    ...over,
  } as GelbooruPost
}

const FILTERED = '[已过滤: 含敏感标签]'

describe('filterPostImages', () => {
  it('blanks sample_url when a tag hits the blacklist, preserving other fields', () => {
    const posts = [makePost({ tags: '1girl nsfw smile', id: 7, score: 99 })]
    const out = filterPostImages(posts, ['nsfw'])
    expect(out[0].sample_url).toBe(FILTERED)
    expect(out[0].id).toBe(7)
    expect(out[0].score).toBe(99)
    expect(out[0].tags).toBe('1girl nsfw smile')
  })

  it('leaves sample_url intact when no tag hits the blacklist', () => {
    const posts = [makePost()]
    const out = filterPostImages(posts, ['nsfw', 'nude'])
    expect(out[0].sample_url).toBe('https://img.example/sample.jpg')
  })

  it('is a no-op when the blacklist is empty', () => {
    const posts = [makePost({ tags: 'nsfw nude' })]
    const out = filterPostImages(posts, [])
    expect(out[0].sample_url).toBe('https://img.example/sample.jpg')
  })

  it('compares case-insensitively (blacklist term and post tag in any case)', () => {
    const posts = [makePost({ tags: '1girl NSFW' })]
    const out = filterPostImages(posts, ['NsFw'])
    expect(out[0].sample_url).toBe(FILTERED)
  })

  it('matches whole space-separated tokens, not substrings', () => {
    // 'nsfw' must not match the tag 'nsfwish' or 'not_nsfw_safe'
    const posts = [makePost({ tags: 'nsfwish safe_for_work' })]
    const out = filterPostImages(posts, ['nsfw'])
    expect(out[0].sample_url).toBe('https://img.example/sample.jpg')
  })

  it('filters only the offending posts in a mixed list', () => {
    const posts = [
      makePost({ id: 1, tags: '1girl smile' }),
      makePost({ id: 2, tags: '1girl nude' }),
    ]
    const out = filterPostImages(posts, ['nude'])
    expect(out[0].sample_url).toBe('https://img.example/sample.jpg')
    expect(out[1].sample_url).toBe(FILTERED)
  })
})
