import type { GelbooruPost } from './client'

/** Placeholder shown in place of a sample_url when a post hits the blacklist. */
export const FILTERED_PLACEHOLDER = '[已过滤: 含敏感标签]'

/**
 * Blank out the `sample_url` of any post whose space-separated `tags` contain a
 * blacklisted term (case-insensitive, whole-token match). Other fields (id,
 * score, rating, tags) are preserved so agents can still inspect the tag combo.
 *
 * Empty blacklist = no-op. Mutates posts in place and returns the same array.
 *
 * Pure function — Computed is resolved by the caller (via session.resolve) and
 * passed in as a plain string[], keeping this koishi-free and unit-testable.
 */
export function filterPostImages(
  posts: GelbooruPost[],
  blacklist: string[]
): GelbooruPost[] {
  if (!blacklist || blacklist.length === 0) return posts
  const banned = new Set(blacklist.map((w) => w.toLowerCase()))
  for (const post of posts) {
    const tokens = String(post.tags ?? '')
      .toLowerCase()
      .split(/\s+/)
      .filter(Boolean)
    if (tokens.some((t) => banned.has(t))) {
      post.sample_url = FILTERED_PLACEHOLDER
    }
  }
  return posts
}
