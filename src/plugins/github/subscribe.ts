import { camelize } from 'koishi'
import type { EventFilter, RepoConfig } from './types'

/**
 * Pure: given a repo's per-channel filter config and an event/action, return the
 * cids that should receive it. Mirrors the old plugin's camelize-based filtering.
 */
export function filterTargets(
  repoConfig: RepoConfig,
  event: string,
  action?: string
): string[] {
  return Object.keys(repoConfig).filter((cid) => {
    const base = repoConfig[cid][camelize(event)] ?? {}
    if (base === false) return false
    if (action && base !== true) {
      const actionConfig = (base as Record<string, boolean>)[camelize(action)]
      if (actionConfig === false) return false
    }
    return true
  })
}

/** In-memory index: repo (lowercase full_name) -> { cid -> filter meta }. */
export class SubscriptionStore {
  private map: Record<string, RepoConfig> = Object.create(null)

  subscribe(repo: string, cid: string, meta: EventFilter) {
    ;(this.map[repo] ||= Object.create(null))[cid] = meta
  }

  unsubscribe(repo: string, cid?: string) {
    if (!cid) {
      delete this.map[repo]
      return
    }
    if (this.map[repo]) {
      delete this.map[repo][cid]
      if (!Object.keys(this.map[repo]).length) delete this.map[repo]
    }
  }

  targets(repo: string, event: string, action?: string): string[] {
    const cfg = this.map[repo]
    return cfg ? filterTargets(cfg, event, action) : []
  }
}
