import h from '@satorijs/element'
import { describe, expect, it } from 'vitest'

import { sanitizeAgentOutput } from '../utils/output-filter'

/**
 * Simulate the adapter's text-segment decoding pass — after our sanitize
 * produces a wire string, session.sendQueued re-parses it and the onebot
 * adapter emits `attrs.content` of synthetic text nodes into the OneBot
 * text payload (one level of entity decode). This helper yields the
 * actual user-visible string per IM client.
 */
function userVisible(safe: string): string {
  const reparsed = h.parse(safe)
  return reparsed
    .map((e) =>
      e.type === 'text' && e.attrs?.content != null
        ? e.attrs.content
        : e.toString()
    )
    .join('')
}

describe('sanitizeAgentOutput', () => {
  describe('explicit reply quotes', () => {
    it('allows only the first tag at the start of a model message', () => {
      const safe = sanitizeAgentOutput(
        ' \n[koishi:quote id="current"] [koishi:quote id="other"]reply',
        true
      )
      expect(
        h
          .parse(safe)
          .filter((element) => element.type === 'quote')
          .map((element) => element.attrs.id)
      ).toEqual(['current'])
      expect(userVisible(safe)).not.toContain('[koishi:quote')
    })

    it('drops mid-message quotes and quotes at the start of a continuation', () => {
      expect(
        userVisible(
          sanitizeAgentOutput('hello [koishi:quote id="other"]world', true)
        )
      ).toBe('hello world')
      expect(
        userVisible(
          sanitizeAgentOutput('[koishi:quote id="other"]continued', false)
        )
      ).toBe('continued')
    })

    it('drops quote directives without an ID while preserving the reply', () => {
      const safe = sanitizeAgentOutput(
        '[koishi:quote][koishi:quote id="other"]reply',
        true
      )
      expect(userVisible(safe)).toBe('reply')
    })
  })

  describe('plain text — escapes <>& but is otherwise untouched', () => {
    it('passes plain ASCII / CJK text through', () => {
      expect(userVisible(sanitizeAgentOutput('hello world'))).toBe(
        'hello world'
      )
      expect(userVisible(sanitizeAgentOutput('你好，世界！'))).toBe(
        '你好，世界！'
      )
    })

    it('returns empty string unchanged', () => {
      expect(sanitizeAgentOutput('')).toBe('')
    })

    it('preserves raw < and > in agent prose (regression — used to be parsed)', () => {
      // The original bug: agent writes prose containing `<` `>` and a
      // koishi-element parser ate everything in between. With h.text by
      // default, those are just characters.
      expect(
        userVisible(
          sanitizeAgentOutput('前面有一个<，中间一堆内容，后面有一个>')
        )
      ).toBe('前面有一个<，中间一堆内容，后面有一个>')
    })

    it('preserves raw &', () => {
      expect(userVisible(sanitizeAgentOutput('A & B'))).toBe('A & B')
    })

    it('preserves entity-encoded text as the literal entity', () => {
      // Agent writes `&lt;` → wire has `&amp;lt;` → adapter decodes once →
      // user sees literal `&lt;`. Agent's escape intent is honored.
      expect(userVisible(sanitizeAgentOutput('教学：&lt; 表示小于号'))).toBe(
        '教学：&lt; 表示小于号'
      )
    })
  })

  describe('XML/HTML tags in prose — all become literal text', () => {
    it('<div>foo</div> renders as literal characters', () => {
      expect(userVisible(sanitizeAgentOutput('讲解 <div>foo</div> 标签'))).toBe(
        '讲解 <div>foo</div> 标签'
      )
    })

    it('orphan <br> does not corrupt the rest of the message', () => {
      // Critical regression from earlier sanitizer: bare `<br>` used to
      // swallow the tail via h.parse's auto-nest. Now everything is text.
      expect(userVisible(sanitizeAgentOutput('前 <br> 这段必须保留'))).toBe(
        '前 <br> 这段必须保留'
      )
    })

    it('XML-style koishi elements are NOT recognized (only bracket form is)', () => {
      // <img src=...> is just text; only [koishi:img ...] gets extracted.
      const safe = sanitizeAgentOutput('<img src="https://x.com/a.png"/>')
      expect(userVisible(safe)).toBe('<img src="https://x.com/a.png"/>')
    })

    it('<at>, <sharp>, <face> are literal text (no spam-mention risk)', () => {
      expect(
        userVisible(sanitizeAgentOutput('Hi <at id="123">小鱼</at>!'))
      ).toBe('Hi <at id="123">小鱼</at>!')
    })
  })

  describe('[koishi:img] extraction', () => {
    it('extracts <img> with http(s) src', () => {
      const safe = sanitizeAgentOutput('[koishi:img src="https://x.com/a.png"]')
      expect(safe).toContain('<img')
      expect(safe).toContain('src="https://x.com/a.png"')
    })

    it('extracts <img ref="..."/> trusted placeholder', () => {
      const safe = sanitizeAgentOutput('[koishi:img ref="abc123def456"]')
      expect(safe).toContain('<img')
      expect(safe).toContain('ref="abc123def456"')
    })

    it('drops <img> with dangerous schemes (file/javascript/data/etc)', () => {
      expect(sanitizeAgentOutput('[koishi:img src="file:///etc/passwd"]')).toBe(
        ''
      )
      expect(
        sanitizeAgentOutput('[koishi:img src="javascript:alert(1)"]')
      ).toBe('')
      expect(sanitizeAgentOutput('[koishi:img src="data:image/png;..."]')).toBe(
        ''
      )
      expect(sanitizeAgentOutput('[koishi:img src="ftp://x"]')).toBe('')
    })

    it('escapes [koishi:img] with placeholder src as literal text', () => {
      // Educational example URL (no scheme): surface as visible text.
      const safe = sanitizeAgentOutput('[koishi:img src="image.png"]')
      expect(userVisible(safe)).toBe('[koishi:img src="image.png"]')
    })

    it('escapes [koishi:img] with no src/ref as literal text', () => {
      const safe = sanitizeAgentOutput('看这个 [koishi:img]')
      expect(userVisible(safe)).toBe('看这个 [koishi:img]')
    })

    it('inline mid-message image works as real element', () => {
      const safe = sanitizeAgentOutput(
        '看图：[koishi:img src="https://x.com/a.png"] 是不是很酷'
      )
      expect(safe).toContain('<img src="https://x.com/a.png"/>')
      expect(userVisible(safe)).toContain('看图：')
      expect(userVisible(safe)).toContain('是不是很酷')
    })
  })

  describe('bracket-in-attr edge cases', () => {
    it('preserves [ inside attribute URL', () => {
      const safe = sanitizeAgentOutput(
        '[koishi:a href="https://foo.com/path-[-bracket"]text[/koishi:a]'
      )
      expect(safe).toContain('href="https://foo.com/path-[-bracket"')
      expect(safe).toContain('>text<')
    })

    it('preserves ] inside attribute URL (the trickier case)', () => {
      // Regex must allow `]` inside `"..."` attr values without closing
      // the open tag prematurely.
      const safe = sanitizeAgentOutput(
        '[koishi:a href="https://foo.com/path-]-bracket"]text[/koishi:a]'
      )
      expect(safe).toContain('href="https://foo.com/path-]-bracket"')
      // Link text is JUST "text" (not the leaked URL fragment) — extract
      // the inner-text region between open `>` and close `<`.
      const innerMatch = safe.match(/<a [^>]+>([^<]*)<\/a>/)
      expect(innerMatch?.[1]).toBe('text')
    })

    it('preserves [bracketed text] inside link content', () => {
      const safe = sanitizeAgentOutput(
        '[koishi:a href="https://x.com"]看 [这里][/koishi:a]'
      )
      expect(safe).toContain('看 [这里]</a>')
    })

    it('preserves ] inside img src', () => {
      const safe = sanitizeAgentOutput(
        '[koishi:img src="https://foo.com/path?q=]"]'
      )
      expect(safe).toContain('src="https://foo.com/path?q=]"')
    })
  })

  describe('[koishi:a]...[/koishi:a] extraction', () => {
    it('extracts <a> with http(s) href', () => {
      const safe = sanitizeAgentOutput(
        '看 [koishi:a href="https://example.com"]这里[/koishi:a]'
      )
      expect(safe).toContain('href="https://example.com"')
      expect(safe).toContain('这里')
    })

    it('drops <a> wrapper but keeps text on dangerous href', () => {
      const safe = sanitizeAgentOutput(
        '[koishi:a href="javascript:alert(1)"]click[/koishi:a]'
      )
      // No real <a> element
      expect(safe).not.toMatch(/<a\b/)
      // But the visible text survives
      expect(userVisible(safe)).toContain('click')
    })

    it('escapes [koishi:a] with placeholder href as literal text', () => {
      const safe = sanitizeAgentOutput(
        '[koishi:a href="#anchor"]section[/koishi:a]'
      )
      expect(userVisible(safe)).toBe(
        '[koishi:a href="#anchor"]section[/koishi:a]'
      )
    })
  })

  describe('protocol markers are dropped', () => {
    it('drops self-closing markers (msg_break/silent/interrupted)', () => {
      expect(sanitizeAgentOutput('a[koishi:msg_break]b')).toBe('ab')
      expect(sanitizeAgentOutput('hello[koishi:silent]')).toBe('hello')
      expect(sanitizeAgentOutput('[koishi:silent]tail')).toBe('tail')
      expect(sanitizeAgentOutput('a[koishi:interrupted]b')).toBe('ab')
    })

    it('XML-form markers are NOT specially handled (just text)', () => {
      // If agent slips into old habit and writes <msg_break/>, we DON'T
      // strip it — surfaces as literal text. The splitter also won't cut
      // there. Agent gets feedback to use the new form.
      expect(userVisible(sanitizeAgentOutput('a<msg_break/>b'))).toBe(
        'a<msg_break/>b'
      )
    })
  })

  describe('end-to-end: user-visible matches agent intent', () => {
    it('the original phantom-close bug case', () => {
      // Agent writes `<div>` without close. Used to gain a `</div>` from
      // h.parse's auto-close. Now: zero parsing, just escape.
      expect(
        userVisible(sanitizeAgentOutput('让我讲解一下<div>标签的用法'))
      ).toBe('让我讲解一下<div>标签的用法')
    })

    it('mixed teaching content + real image side-by-side (the trickiest case)', () => {
      // Agent teaches HTML AND inserts a real image. With bracket syntax
      // for the real one, zero ambiguity:
      //   - <img>...</img> mentions stay text (no parsing)
      //   - [koishi:img src="..."] gets extracted as real element
      const safe = sanitizeAgentOutput(
        '<img> 是图片标签，比如这张：[koishi:img src="https://r2.epb.wiki/avatar.jpg"] 看到了吗？再来 <img src="example.png"/> 是另一个示例。'
      )
      // Real img extracted
      expect(safe).toContain('<img src="https://r2.epb.wiki/avatar.jpg"/>')
      // Educational examples preserved as literal
      const visible = userVisible(safe)
      expect(visible).toContain('<img> 是图片标签')
      expect(visible).toContain('<img src="example.png"/> 是另一个示例')
    })

    it('streaming-cut tags do not throw', () => {
      expect(() =>
        sanitizeAgentOutput('text [koishi:img src="https://x')
      ).not.toThrow()
      expect(() => sanitizeAgentOutput('text [koishi:msg_brea')).not.toThrow()
      expect(() =>
        sanitizeAgentOutput('[koishi:a href="https://x"]click')
      ).not.toThrow()
    })
  })

  describe('emote', () => {
    it('keeps a numeric id', () => {
      expect(sanitizeAgentOutput('[koishi:emote id="12"]')).toBe(
        '<sticker id="12"/>'
      )
    })
    it('keeps a name', () => {
      expect(sanitizeAgentOutput('[koishi:emote name="比心"]')).toBe(
        '<sticker name="比心"/>'
      )
    })
    it('keeps a type', () => {
      expect(sanitizeAgentOutput('好耶[koishi:emote tag="开心"]')).toBe(
        '好耶<sticker tag="开心"/>'
      )
    })
    it('accepts a marker opened with an angle bracket', () => {
      expect(sanitizeAgentOutput('<koishi:emote tag="阴阳怪气"]够了')).toBe(
        '<sticker tag="阴阳怪气"/>够了'
      )
      expect(sanitizeAgentOutput('<koishi:emote id="3"/>')).toBe(
        '<sticker id="3"/>'
      )
    })
    it('escapes a sticker with neither', () => {
      expect(sanitizeAgentOutput('[koishi:emote id="abc"]')).toBe(
        '[koishi:emote id="abc"]'
      )
    })
  })
})
