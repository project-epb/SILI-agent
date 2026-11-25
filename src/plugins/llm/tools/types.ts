import type { Context, Logger, Session } from 'koishi'

import type { ToolDefinition } from '../providers/_base'

/**
 * Per-call context handed to every tool handler. `turnState` is a
 * mutable bag shared across tool executions within the same agent-loop
 * iteration — tools that need read-before-write coordination (e.g.
 * `read_user_memory` → `save_user_memory`) stash state here under a
 * stable namespace key.
 */
export interface ToolContext {
  ctx: Context
  logger: Logger
  session: Session
  /**
   * Mutable per-turn state shared across tool executions in the same
   * agent-loop iteration. Keyed by tool-namespace strings; tools should
   * pick a stable key (see e.g. `MEMORY_TOOL_STATE_KEY`).
   */
  turnState: Record<string, unknown>
  /** Aborts when the turn is stopped; long-running tools should honour it. */
  signal?: AbortSignal
  /** Agent-loop iteration: calls with the same number ran in one batch. */
  iteration?: number
}

/** A result with images: their pixels follow the batch of results (providers/images.ts). */
export interface ToolResult {
  content: string
  images?: string[]
}

export interface ToolHandler {
  definition: ToolDefinition
  execute(args: Record<string, any>, toolCtx: ToolContext): Promise<string | ToolResult>
  /**
   * May run only in conversations where this returns true. The tool is still
   * listed everywhere: the tool list is part of the cached prompt prefix and
   * must not vary with feature switches or authority. State the condition in
   * the description and refuse at dispatch.
   */
  available?(session: Session): boolean
  /**
   * Tool iterations a turn may take where this tool is available, when more
   * than the configured default (agent work runs many commands in a row).
   */
  iterationBudget?: number
}

/**
 * In-memory registry of tool handlers, keyed by `definition.name`. The
 * agent-loop walks the registered list to build the LLM-facing tool
 * schema and to dispatch invoke calls.
 */
export class ToolRegistry {
  private handlers = new Map<string, ToolHandler>()

  register(handler: ToolHandler): void {
    this.handlers.set(handler.definition.name, handler)
  }

  unregister(name: string): void {
    this.handlers.delete(name)
  }

  get(name: string): ToolHandler | undefined {
    return this.handlers.get(name)
  }

  /** Whether this handler may run in the session (see `ToolHandler.available`). */
  allows(handler: ToolHandler, session: Session): boolean {
    return !handler.available || handler.available(session)
  }

  /**
   * Every registered tool, the same in every conversation, ordered by name:
   * tools register as plugins load, and load order varies between restarts.
   */
  listDefinitions(): ToolDefinition[] {
    return [...this.handlers.values()]
      .map((h) => h.definition)
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
  }

  /** The iteration budget for a turn in this session. */
  iterationBudget(session: Session, fallback: number): number {
    const budgets = [...this.handlers.values()]
      .filter((h) => h.iterationBudget && this.allows(h, session))
      .map((h) => h.iterationBudget!)
    return Math.max(fallback, ...budgets)
  }
}
