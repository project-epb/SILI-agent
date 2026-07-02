import type { EventRenderer } from '../types'
import { renderPush } from './push'

/** event name (x-github-event) -> renderer. Phase 1 ships push only. */
export const renderers: Record<string, EventRenderer> = {
  push: renderPush,
}
