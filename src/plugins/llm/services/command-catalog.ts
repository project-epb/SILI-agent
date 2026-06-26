import type { Context, Logger } from 'koishi'

import {
  type CommandCatalogEntry,
  buildCommandCatalog,
  projectHideForHuman,
  renderCompactCatalog,
} from '../utils/command-catalog'

/**
 * Owns the cached agent command catalog: the entry tree (for tools.ts to
 * render `help`), the rendered compact text (for system prompt), and a
 * version counter used to detect when more commands have appeared since
 * the last build (typical for plugins gated on services like puppeteer
 * that come up after our `ready` hook).
 *
 * Construction does NOT build immediately — call `bind()` to wire the
 * `ctx.on('ready')` hook in.
 */
export class CommandCatalogService {
  private entries: CommandCatalogEntry[] = []
  private text: string = ''
  /**
   * Number of commands seen the last time the catalog was rebuilt. When
   * the live count exceeds this, the catalog is rebuilt lazily on next
   * `getOrRefresh()`.
   */
  private version: number = -1

  constructor(
    private readonly ctx: Context,
    private readonly logger: Logger
  ) {}

  /** Hook into ctx ready so we get a first build automatically. */
  bind(): void {
    // hideForHuman → config.hidden 投影：对已注册命令补一遍，并监听后续新增命令。
    for (const cmd of (this.ctx as any).$commander?._commandList ?? []) {
      projectHideForHuman(cmd.config)
    }
    this.ctx.on('command-added', (cmd: any) => projectHideForHuman(cmd.config))
    this.ctx.on('ready', () => this.refresh('ready'))
  }

  /** Pure read of the (cached) entry tree. */
  list(): readonly CommandCatalogEntry[] {
    return this.entries
  }

  /** Live count of all registered commands (top-level + nested). */
  private liveCount(): number {
    return (this.ctx as any).$commander?._commandList?.length ?? 0
  }

  /** Rebuild the catalog right now (used by ready hook + manual command). */
  refresh(trigger: string): void {
    this.entries = buildCommandCatalog(this.ctx)
    this.text = renderCompactCatalog(this.entries)
    this.version = this.liveCount()
    this.logger.info(
      '[llm] command catalog rebuilt (%s): %d top-level / %d total',
      trigger,
      this.entries.length,
      this.version
    )
  }

  /**
   * Lazily rebuild if more commands have appeared since the last snapshot —
   * covers plugins that came up after our ready hook.
   */
  getOrRefresh(): string {
    if (this.liveCount() > this.version) this.refresh('lazy-grow')
    return this.text
  }

  /** Counts for diagnostics (used by `llm.catalog`). */
  stats(): { topLevel: number; total: number } {
    return { topLevel: this.entries.length, total: this.version }
  }
}
