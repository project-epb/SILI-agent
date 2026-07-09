import type { Context, Logger, Session } from '@koishijs/core'

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
}

export interface ToolHandler {
  definition: ToolDefinition
  execute(args: Record<string, any>, toolCtx: ToolContext): Promise<string>
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

  listDefinitions(): ToolDefinition[] {
    return [...this.handlers.values()].map((h) => h.definition)
  }
}
