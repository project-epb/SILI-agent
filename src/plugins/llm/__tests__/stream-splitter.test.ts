import { describe, it, expect } from 'vitest'
import { PROTOCOL_MARKERS } from '../utils/protocol'
import { isAgentMessageStart, splitContent } from '../utils/stream-splitter'

const CHUNK_BREAK_MARKER = PROTOCOL_MARKERS.MSG_BREAK

describe('splitContent', () => {
  it('returns empty for short buffer with no marker', () => {
    expect(splitContent('hi', 0)).toEqual({ text: '', nextIndex: 0 })
    expect(splitContent('a'.repeat(100), 0)).toEqual({
      text: '',
      nextIndex: 0,
    })
  })

  it('cuts at AI <msg_break/> marker', () => {
    const buf = 'first part' + CHUNK_BREAK_MARKER + 'second'
    const out = splitContent(buf, 0)
    expect(out.text).toBe('first part' + CHUNK_BREAK_MARKER)
    expect(out.nextIndex).toBe('first part'.length + CHUNK_BREAK_MARKER.length)
  })

  it('cuts on marker even when chunk is short', () => {
    const buf = 'a' + CHUNK_BREAK_MARKER + 'b'
    const out = splitContent(buf, 0)
    expect(out.text).toBe('a' + CHUNK_BREAK_MARKER)
  })

  it('cuts at first marker when there are multiple', () => {
    const buf =
      'one' + CHUNK_BREAK_MARKER + 'two' + CHUNK_BREAK_MARKER + 'three'
    const out = splitContent(buf, 0)
    expect(out.text).toBe('one' + CHUNK_BREAK_MARKER)
  })

  it('opens a quote slot at every explicit break, even if all arrive together', () => {
    const buf =
      'one' + CHUNK_BREAK_MARKER + 'two' + CHUNK_BREAK_MARKER + 'three'
    const first = splitContent(buf, 0, { force: true })
    const second = splitContent(buf, first.nextIndex, { force: true })
    const third = splitContent(buf, second.nextIndex, { force: true })

    expect([first.text, second.text, third.text]).toEqual([
      'one' + CHUNK_BREAK_MARKER,
      'two' + CHUNK_BREAK_MARKER,
      'three',
    ])
    expect(isAgentMessageStart(buf, 0)).toBe(true)
    expect(isAgentMessageStart(buf, first.nextIndex)).toBe(true)
    expect(isAgentMessageStart(buf, second.nextIndex)).toBe(true)
  })

  it('keeps an automatic chunk boundary inside the same model message', () => {
    const buf = 'a'.repeat(280) + '\n[koishi:quote id="other"]continued'
    const first = splitContent(buf, 0, { maxChunkLen: 280 })

    expect(first.text).toBe('a'.repeat(280) + '\n')
    expect(isAgentMessageStart(buf, first.nextIndex)).toBe(false)
  })

  it('respects fromIndex offset', () => {
    const buf = 'PREFIX_' + 'mid' + CHUNK_BREAK_MARKER + 'tail'
    const out = splitContent(buf, 7)
    expect(out.text).toBe('mid' + CHUNK_BREAK_MARKER)
    expect(out.nextIndex).toBe(7 + 'mid'.length + CHUNK_BREAK_MARKER.length)
  })

  it('returns empty when fromIndex is past buffer end', () => {
    const out = splitContent('abc', 10)
    expect(out).toEqual({ text: '', nextIndex: 3 })
  })

  it('returns empty when only marker prefix is present (incomplete tag)', () => {
    // streaming 中 marker 可能被切到中间：'[koishi:msg_break' 还差 ']'
    expect(splitContent('hello [koishi:msg_break', 0).text).toBe('')
  })

  describe('long-content fallback', () => {
    it('cuts at first \\n when buffer over maxLen', () => {
      const buf = 'a'.repeat(150) + '\n' + 'b'.repeat(50)
      const out = splitContent(buf, 0, { maxChunkLen: 100 })
      expect(out.text).toBe('a'.repeat(150) + '\n')
    })

    it('cuts even when \\n appears AFTER maxLen (first line >> maxLen)', () => {
      // 第一行 500 字超过 maxLen 200，\n 出现在 500 → 立即切发第一行
      const buf = 'a'.repeat(500) + '\n' + 'b'.repeat(50)
      const out = splitContent(buf, 0, { maxChunkLen: 200 })
      expect(out.text).toBe('a'.repeat(500) + '\n')
    })

    it('does NOT cut a single-line long buffer (no \\n at all)', () => {
      // 整段没换行 → 等 force flush，不切
      const buf = 'a'.repeat(800)
      const out = splitContent(buf, 0, { maxChunkLen: 200 })
      expect(out.text).toBe('')
    })

    it('does not cut buffer below maxLen even with newlines', () => {
      const buf = 'a'.repeat(50) + '\n' + 'b'.repeat(50)
      const out = splitContent(buf, 0, { maxChunkLen: 500 })
      expect(out.text).toBe('')
    })

    it('AI marker beats long-content fallback', () => {
      // 即使超长，AI 标记位置更靠前
      const buf = 'a' + CHUNK_BREAK_MARKER + 'b'.repeat(800)
      const out = splitContent(buf, 0, { maxChunkLen: 200 })
      expect(out.text).toBe('a' + CHUNK_BREAK_MARKER)
    })

    it('disables fallback once agent has emitted any marker (later in same turn)', () => {
      // 模拟"先解释 + marker + 长代码块"场景：
      //  - 第一次 splitContent 时 buffer 含 marker，cut 到 marker 后
      //  - fromIndex 推进到 marker 之后；之后流入的代码块即便超长也
      //    不该被兜底切，等下一个 marker 或 force flush
      const buf =
        'intro paragraph' + CHUNK_BREAK_MARKER + 'a'.repeat(400) + '\n' + 'b'.repeat(400)
      const afterMarker = 'intro paragraph'.length + CHUNK_BREAK_MARKER.length
      const out = splitContent(buf, afterMarker, { maxChunkLen: 200 })
      // rest 长 800 + 1 \n，超过 maxLen 200 也有 \n，按老逻辑会切；
      // 新逻辑发现 agent 已 opted in（buffer 含过 marker）→ 不切
      expect(out.text).toBe('')
    })

    it('still triggers fallback when agent has not used any marker', () => {
      // 整段无 marker，超长有 \n → 兜底切第一个 \n
      const buf = 'a'.repeat(500) + '\n' + 'b'.repeat(50)
      const out = splitContent(buf, 0, { maxChunkLen: 200 })
      expect(out.text).toBe('a'.repeat(500) + '\n')
    })

    it('does not cascade-cut on paragraph \\n\\n boundaries', () => {
      // AI 出 "para1\n\npara2..." 没用 marker、超长。第一次 splitContent 切
      // 第一个 \n；第二次进来 rest 以 "\n" + para2 起头，rest.length 仍 >=
      // maxLen，老逻辑会在那个领头 \n 处又切一刀（要么发 1 char "\n"
      // 触发 onebot "[暂不支持的消息类型]"，要么发出一条只有几字的微消息
      // 触发"AI 没插 marker → 系统在每段空行处都切一刀"的级联）。
      // 新逻辑：兜底切点必须距 cursor 至少 maxLen/2，rest 开头的孤立 \n
      // 不会被当作切点，第二次直接返回 ('', fromIndex) 等更多 buffer。
      const para1 = 'a'.repeat(300)
      const para2 = 'b'.repeat(400)
      const buf = para1 + '\n\n' + para2
      const first = splitContent(buf, 0, { maxChunkLen: 200 })
      expect(first.text).toBe(para1 + '\n')
      const second = splitContent(buf, first.nextIndex, { maxChunkLen: 200 })
      expect(second.text).toBe('')
      expect(second.nextIndex).toBe(first.nextIndex)
    })

    it('cuts at a substantial \\n, not the first one near the cursor', () => {
      // 还原用户报的 bug：AI 满篇 `\n\n` 段落分隔、无 marker。每段都很短
      // (~50 chars)。老逻辑会逐段切出小消息；新逻辑要求切片至少
      // maxLen/2 才切，把小段聚合发出。
      const sections = [
        '好呀～SILI 来随便说几个 HTML 标签好了！',
        '---',
        '**`<h1>` ~ `<h6>` — 标题标签**',
        '网页里的标题就是靠它们来的，`<h1>` 最大最醒目，`<h6>` 最小。',
        '---',
        '**`<a>` — 超链接**',
        '网页里能跳来跳去全靠它～',
      ]
      const buf = sections.join('\n\n') + '\n\n' + 'x'.repeat(300)
      const out = splitContent(buf, 0, { maxChunkLen: 200 })
      // 兜底切片长度 >= maxLen/2 = 100
      expect(out.text.length).toBeGreaterThanOrEqual(100)
      // 不应该把第一行（22 chars）单独发
      expect(out.text).not.toBe(sections[0] + '\n')
    })

    it('marker-only slice that contains the marker text still emits', () => {
      // marker 的字面内容不是 whitespace-only，所以即使前后只有空白也照发
      const buf = '\n' + CHUNK_BREAK_MARKER + 'tail'
      const out = splitContent(buf, 0)
      expect(out.text).toBe('\n' + CHUNK_BREAK_MARKER)
    })
  })
})
