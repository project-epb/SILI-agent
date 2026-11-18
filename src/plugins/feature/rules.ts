/**
 * Pure service-level decisions. No Koishi runtime here so every branch is
 * unit-testable; the plugin feeds it command nodes and the chat's overrides.
 *
 * Like Koishi's authority: a command runs where its level is at most the
 * chat's level, unless the chat overrides it.
 */

/** The `feature` command: never subject to levels; ops may run it anywhere. */
export const FEATURE_COMMAND = 'feature'

/** Level of a command that declares none. */
export const DEFAULT_LEVEL = 1

/** The slice of a Koishi command these rules read. */
export interface CommandNode {
  name: string
  config: { level?: number }
  parent: CommandNode | null
}

/**
 * Per-chat overrides by command name: true forces on, false forces off.
 * Holds only deviations from the level default.
 */
export type Overrides = Readonly<Record<string, boolean>>

export const NO_OVERRIDES: Overrides = {}

/** Nodes from the command up to its top-level ancestor. */
function chain(command: CommandNode | null): CommandNode[] {
  const nodes: CommandNode[] = []
  for (let c = command; c; c = c.parent) nodes.push(c)
  return nodes
}

/** The nearest declared level up the parent chain. */
export function levelOf(command: CommandNode): number {
  for (const node of chain(command)) {
    if (typeof node.config.level === 'number') return node.config.level
  }
  return DEFAULT_LEVEL
}

/** Whether a command runs in a chat of `chatLevel` with these overrides. */
export function isOn(
  command: CommandNode,
  overrides: Overrides,
  chatLevel: number
): boolean {
  const nodes = chain(command)
  if (nodes.some((n) => overrides[n.name] === false)) return false
  if (nodes.some((n) => overrides[n.name] === true)) return true
  return levelOf(command) <= chatLevel
}

export type OverrideAction = 'enable' | 'disable' | 'reset'

/**
 * New overrides after an action on one command. An action that matches the
 * level default just drops the override, so the record stays minimal.
 */
export function applyOverride(
  overrides: Overrides,
  name: string,
  onByLevel: boolean,
  action: OverrideAction
): Overrides {
  const next: Record<string, boolean> = { ...overrides }
  delete next[name]
  if (action === 'enable' && !onByLevel) next[name] = true
  if (action === 'disable' && onByLevel) next[name] = false
  return next
}
