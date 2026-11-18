import { describe, it, expect } from 'vitest'
import {
  INTERRUPT_NOTES,
  buildHistory,
  groupAndTrimHistory,
  type HistoryRow,
} from '../services/history-filter'

const u = (content: string): HistoryRow => ({ role: 'user', content })
const a = (content: string, tc?: string): HistoryRow => ({
  role: 'assistant',
  content,
  tool_calls: tc,
})
const t = (id: string, name: string, content: string): HistoryRow => ({
  role: 'tool',
  content,
  tool_call_id: id,
  tool_name: name,
})

describe('groupAndTrimHistory', () => {
  it('keeps simple alternating turns', () => {
    const rows = [u('hi'), a('hello'), u('how are you'), a('fine')]
    expect(groupAndTrimHistory(rows, 5)).toEqual(rows)
  })

  it('trims to last N user turns', () => {
    const rows = [
      u('q1'), a('a1'),
      u('q2'), a('a2'),
      u('q3'), a('a3'),
    ]
    const out = groupAndTrimHistory(rows, 2)
    expect(out).toEqual([u('q2'), a('a2'), u('q3'), a('a3')])
  })

  it('keeps tool messages within a turn (not counted)', () => {
    const rows = [
      u('q1'),
      a('', '[{"id":"c1","name":"f","arguments":{}}]'),
      t('c1', 'f', 'r1'),
      a('done'),
    ]
    expect(groupAndTrimHistory(rows, 1)).toEqual(rows)
  })

  it('drops orphan leading tool message', () => {
    const rows = [
      t('c0', 'x', 'orphan'),
      u('q1'),
      a('a1'),
    ]
    const out = groupAndTrimHistory(rows, 5)
    expect(out).toEqual([u('q1'), a('a1')])
  })

  it('drops trailing assistant(tool_calls) without tool response', () => {
    const rows = [
      u('q1'),
      a('a1'),
      u('q2'),
      a('', '[{"id":"c1","name":"f","arguments":{}}]'),
      // 没有 tool 响应也没有最终 assistant
    ]
    const out = groupAndTrimHistory(rows, 5)
    expect(out).toEqual([u('q1'), a('a1')])
  })

  it('drops half turn where tool_calls has tool but no final assistant', () => {
    const rows = [
      u('q1'),
      a('a1'),
      u('q2'),
      a('', '[{"id":"c1","name":"f","arguments":{}}]'),
      t('c1', 'f', 'r'),
      // 没有最终 assistant 文本
    ]
    const out = groupAndTrimHistory(rows, 5)
    expect(out).toEqual([u('q1'), a('a1')])
  })

  it('returns empty when limit is 0', () => {
    expect(groupAndTrimHistory([u('q'), a('a')], 0)).toEqual([])
  })
})

const us = (content: string, turn_status: string): HistoryRow => ({
  role: 'user',
  content,
  turn_status,
})
const calls = (...ids: string[]) =>
  JSON.stringify(ids.map((id) => ({ id, name: 'f', arguments: {} })))

describe('buildHistory: turns that did not finish', () => {
  it('keeps a failed turn, answers its open calls, and notes the next message', () => {
    const rows = [
      us('q1', 'failed'),
      a('', calls('c1')),
      t('c1', 'f', 'done'),
      a('', calls('c2', 'c3')),
      t('c2', 'f', 'ok'),
      us('q2', 'done'),
      a('a2'),
    ]
    expect(buildHistory(rows, 5)).toEqual({
      rows: [
        rows[0],
        rows[1],
        rows[2],
        rows[3],
        rows[4],
        t('c3', 'f', INTERRUPT_NOTES.failed.tool),
        { ...rows[5], content: `${INTERRUPT_NOTES.failed.user}\n\nq2` },
        rows[6],
      ],
      pendingNote: null,
    })
  })

  it('owes the note to the caller when the last turn was cut short', () => {
    const rows = [us('q1', 'running'), a('', calls('c1'))]
    const out = buildHistory(rows, 5)
    expect(out.rows).toEqual([rows[0], rows[1], t('c1', 'f', INTERRUPT_NOTES.failed.tool)])
    expect(out.pendingNote).toBe(INTERRUPT_NOTES.failed.user)
  })

  it('uses the user-interrupt wording for aborted turns', () => {
    const out = buildHistory([us('q1', 'aborted'), u('q2'), a('a2')], 5)
    expect(out.rows[1].content).toBe(`${INTERRUPT_NOTES.aborted.user}\n\nq2`)
  })

  it('drops tool results whose call is missing', () => {
    const rows = [us('q1', 'failed'), t('c9', 'f', 'stray')]
    expect(buildHistory(rows, 5).rows).toEqual([rows[0]])
  })

  it('notes a message the same way however far the window has slid', () => {
    const rows = [us('q1', 'failed'), u('q2'), a('a2')]
    expect(buildHistory(rows, 1).rows[0].content).toBe(
      `${INTERRUPT_NOTES.failed.user}\n\nq2`
    )
  })
})
