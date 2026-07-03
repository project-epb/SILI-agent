import { describe, expect, it } from 'vitest'

import { detectLang } from '../detect-lang'

describe('detectLang', () => {
  it('把常见语言识别成 shiki 语言 id', () => {
    expect(
      detectLang('const x: number = 1\ninterface Foo { bar: string }')
    ).toBe('typescript')
    expect(detectLang('def f(x):\n    return [i for i in range(x)]')).toBe(
      'python'
    )
    expect(detectLang('SELECT id, name FROM users WHERE age > 18;')).toBe('sql')
    expect(detectLang('fn main() {\n    println!("hi");\n}')).toBe('rust')
  })

  it('短/歧义片段无法判定时回退 text', () => {
    expect(detectLang('{ }')).toBe('text')
    expect(detectLang('echo hi')).toBe('text')
  })
})
