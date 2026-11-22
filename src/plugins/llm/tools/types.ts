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
}

export interface ToolHandler {
  definition: ToolDefinition
  execute(args: Record<string, any>, toolCtx: ToolContext): Promise<string>
  /**
   * Offered only in conversations where this returns true. A gated tool is
   * never offered without a session to check (e.g. the memory fork).
   */
  available?(session: Session): boolean
  /**
   * Tool iterations a turn may take while this tool is offered, when more
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

  /** The handlers offered in this session; ungated ones only without one. */
  available(session?: Session): ToolHandler[] {
    return [...this.handlers.values()].filter((h) =>
      h.available ? !!session && h.available(session) : true
    )
  }

  listDefinitions(session?: Session): ToolDefinition[] {
    return this.available(session).map((h) => h.definition)
  }

  /** The iteration budget for a turn in this session. */
  iterationBudget(session: Session, fallback: number): number {
    return Math.max(fallback, ...this.available(session).map((h) => h.iterationBudget ?? 0))
  }
}
