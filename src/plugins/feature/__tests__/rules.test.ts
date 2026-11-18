import { describe, expect, it } from 'vitest'

import { type CommandNode, applyOverride, isOn, levelOf } from '../rules'

const cmd = (name: string, level?: number, parent: CommandNode | null = null): CommandNode => ({
  name,
  config: { level },
  parent,
})

const none = {}

describe('levelOf', () => {
  it('inherits the nearest declared level, defaulting to 1', () => {
    const root = cmd('comfyui', 100)
    expect(levelOf(cmd('comfyui.generate', undefined, root))).toBe(100)
    expect(levelOf(cmd('github.issue', 1, cmd('github', 0)))).toBe(1)
    expect(levelOf(cmd('pixiv'))).toBe(1)
  })
})

describe('isOn', () => {
  it('compares the command level with the chat level', () => {
    expect(isOn(cmd('dice', 0), none, 0)).toBe(true)
    expect(isOn(cmd('pixiv'), none, 0)).toBe(false)
    expect(isOn(cmd('pixiv'), none, 1)).toBe(true)
    expect(isOn(cmd('comfyui', 100), none, 1)).toBe(false)
  })

  it('an enable anywhere on the chain lifts the level check', () => {
    const gen = cmd('comfyui.generate', undefined, cmd('comfyui', 100))
    expect(isOn(gen, { comfyui: true }, 1)).toBe(true)
  })

  it('a disable anywhere on the chain wins over enable and level', () => {
    const root = cmd('wiki', 0)
    expect(isOn(cmd('wiki.connect', undefined, root), { 'wiki.connect': true, wiki: false }, 1)).toBe(false)
  })
})

describe('applyOverride', () => {
  it('only records deviations from the level default', () => {
    expect(applyOverride(none, 'chat', true, 'enable')).toEqual(none)
    expect(applyOverride(none, 'comfyui', false, 'disable')).toEqual(none)
    expect(applyOverride(none, 'comfyui', false, 'enable')).toEqual({ comfyui: true })
    expect(applyOverride({ callme: false }, 'callme', true, 'enable')).toEqual(none)
    expect(applyOverride({ comfyui: true }, 'comfyui', false, 'disable')).toEqual(none)
  })
})
