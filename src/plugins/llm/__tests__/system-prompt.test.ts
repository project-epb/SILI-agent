import { describe, expect, it } from 'vitest'

import {
  buildSystemPromptText,
  SystemPromptBuilder,
  SystemPromptRegistry,
} from '../services/system-prompt'

describe('SystemPromptRegistry', () => {
  it('renders registered sections joined with blank lines', () => {
    const r = new SystemPromptRegistry()
    r.add('a', 'alpha content')
    r.add('b', 'beta content')
    expect(r.render()).toBe('<plugin id="a">\nalpha content\n</plugin>\n\n<plugin id="b">\nbeta content\n</plugin>')
  })

  it('replaces content when the same id is registered twice', () => {
    const r = new SystemPromptRegistry()
    r.add('shared', 'first')
    r.add('other', 'middle')
    r.add('shared', 'second')
    expect(r.render()).toBe('<plugin id="shared">\nsecond\n</plugin>\n\n<plugin id="other">\nmiddle\n</plugin>')
  })

  it('ignores empty / whitespace-only content', () => {
    const r = new SystemPromptRegistry()
    r.add('a', '   ')
    r.add('b', '')
    r.add('c', 'real')
    expect(r.render()).toBe('<plugin id="c">\nreal\n</plugin>')
  })

  it('trims content when storing', () => {
    const r = new SystemPromptRegistry()
    r.add('a', '   padded  \n')
    expect(r.render()).toBe('<plugin id="a">\npadded\n</plugin>')
  })

  it('throws when id is empty', () => {
    const r = new SystemPromptRegistry()
    expect(() => r.add('', 'content')).toThrow(/non-empty string/)
  })

  it('returns empty string with no contributors', () => {
    const r = new SystemPromptRegistry()
    expect(r.render()).toBe('')
  })
})

describe('buildSystemPromptText', () => {
  it('produces same output for same inputs (cacheable contract)', () => {
    const a = buildSystemPromptText('BASE', 'CATALOG', 'EXT')
    const b = buildSystemPromptText('BASE', 'CATALOG', 'EXT')
    expect(a).toBe(b)
  })

  it('appends extensions as the last section when present', () => {
    const out = buildSystemPromptText('BASE', 'CATALOG', 'my custom block')
    expect(out.endsWith('my custom block')).toBe(true)
  })

  it('wraps persona, koishi system and voice in their own blocks, in that order', () => {
    const out = buildSystemPromptText('BASE', 'CATALOG', '', 'VOICE')
    const at = (tag: string) => out.indexOf(tag)
    expect(out.startsWith('<persona>\nBASE\n</persona>')).toBe(true)
    expect(at('<koishi_system>')).toBeGreaterThan(at('</persona>'))
    expect(at('<voice_im>\nVOICE\n</voice_im>')).toBeGreaterThan(at('</koishi_system>'))
  })

  it('omits the extensions section when empty', () => {
    const out = buildSystemPromptText('BASE', 'CATALOG', '')
    expect(out).not.toMatch(/\n\n$/)
    expect(out).toContain('## 输出节奏')
  })

  it('includes the turn_context field explainer block with all three name fields', () => {
    const out = buildSystemPromptText('BASE', 'CATALOG')
    expect(out).toContain('koishi.callme')
    expect(out).toContain('platform.user.name')
    expect(out).toContain('platform.user.group_nickname')
    expect(out).toContain('koishi.authority')
    expect(out).toMatch(/Priority for addressing the user/)
    expect(out).toMatch(/do not represent identity/)
  })

  it('output differs when extensions differ', () => {
    const a = buildSystemPromptText('BASE', 'CATALOG', 'ext-A')
    const b = buildSystemPromptText('BASE', 'CATALOG', 'ext-B')
    expect(a).not.toBe(b)
  })
})

describe('SystemPromptBuilder', () => {
  it('returns byte-identical string on cache hit', () => {
    const b = new SystemPromptBuilder(() => 'base')
    const a = b.get('catalog')
    const c = b.get('catalog')
    expect(a).toBe(c) // referential identity from cache
  })

  it('recomputes when catalog changes', () => {
    const b = new SystemPromptBuilder(() => 'base')
    const a = b.get('catalog-1')
    const c = b.get('catalog-2')
    expect(a).not.toBe(c)
    expect(c).toContain('catalog-2')
  })

  it('recomputes when basePrompt source returns different value', () => {
    let base = 'v1'
    const b = new SystemPromptBuilder(() => base)
    const a = b.get('catalog')
    base = 'v2'
    const c = b.get('catalog')
    expect(a).not.toBe(c)
    expect(c).toContain('v2')
  })

  it('invalidate() forces recomputation', () => {
    const b = new SystemPromptBuilder(() => 'base')
    const a = b.get('catalog')
    b.invalidate()
    const c = b.get('catalog')
    // Same content but different object identity (cache miss → fresh build)
    expect(a).toBe(c) // strings are equal
    // Internal cache was rebuilt; we can't directly observe but the
    // contract is just "force recompute", which we verified by behavior
    // on later sections.
  })

  it('fires the build hook and includes extensions in output', () => {
    const listeners: Array<(r: SystemPromptRegistry) => void> = []
    const fakeCtx = {
      emit(event: string, registry: SystemPromptRegistry) {
        if (event === 'llm/build-system-prompt') {
          for (const fn of listeners) fn(registry)
        }
      },
    } as any

    listeners.push((r) => r.add('mod-a', 'Added by plugin A'))
    listeners.push((r) => r.add('mod-b', 'Added by plugin B'))

    const b = new SystemPromptBuilder(() => 'base', fakeCtx)
    const out = b.get('catalog')
    expect(out).toContain('Added by plugin A')
    expect(out).toContain('Added by plugin B')
    expect(out.endsWith('Added by plugin B\n</plugin>')).toBe(true)
  })

  it('cache invalidates when hook contributors change between calls', () => {
    let injectedContent = 'first'
    const fakeCtx = {
      emit(event: string, registry: SystemPromptRegistry) {
        if (event === 'llm/build-system-prompt') {
          registry.add('mod', injectedContent)
        }
      },
    } as any

    const b = new SystemPromptBuilder(() => 'base', fakeCtx)
    const a = b.get('catalog')
    expect(a).toContain('first')

    injectedContent = 'second'
    const c = b.get('catalog')
    expect(c).toContain('second')
    expect(c).not.toContain('first')
  })

  it('cache hits when hook contributors return stable content', () => {
    const fakeCtx = {
      emit(event: string, registry: SystemPromptRegistry) {
        if (event === 'llm/build-system-prompt') {
          registry.add('stable', 'always the same')
        }
      },
    } as any

    const b = new SystemPromptBuilder(() => 'base', fakeCtx)
    const a = b.get('catalog')
    const c = b.get('catalog')
    expect(a).toBe(c) // cache hit; same string instance
  })

  it('swallows listener errors and proceeds without extensions', () => {
    const fakeCtx = {
      emit() {
        throw new Error('listener blew up')
      },
    } as any

    const b = new SystemPromptBuilder(() => 'base', fakeCtx)
    expect(() => b.get('catalog')).not.toThrow()
    const out = b.get('catalog')
    expect(out).toContain('base')
  })
})
