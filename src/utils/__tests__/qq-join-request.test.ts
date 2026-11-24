import { describe, expect, it } from 'vitest'

import { joinRequestAnswerText } from '../qq-join-request'

describe('joinRequestAnswerText', () => {
  it.each([
    ['问题：进群动机\n答案：讨论条目', '讨论条目'],
    ['问题：请用一句话作答\n答案：来帮忙校对', '来帮忙校对'],
    ['我想完善词条', '我想完善词条'],
  ])('%j -> %j', (comment, expected) => {
    expect(joinRequestAnswerText(comment)).toBe(expected)
  })
})
