import { describe, expect, it, vi } from 'vitest'

import SilentSwitch, { isSwitchedOff } from '../SilentSwitch'

// koishi 包顶层会拉 loader 等运行时副作用，在 vitest 下加载失败；
// 这里只需要 BasePlugin 用到的 snakeCase。
vi.mock('koishi', () => ({
  Context: class {},
  Logger: class {},
  snakeCase: (s: string) => s.replace(/([a-z])([A-Z])/g, '$1_$2').toLowerCase(),
}))

const cmd = (name: string, parent: any = null, userCall?: string): any => ({
  name,
  parent,
  config: { userCall },
})

describe('isSwitchedOff', () => {
  const llm = cmd('llm')
  const chat = cmd('chat', llm)

  it('指令在 disable 里时判定为禁用', () => {
    expect(isSwitchedOff(chat, { disable: ['chat'] })).toBe(true)
  })

  it('父指令被禁用时子指令也禁用', () => {
    expect(isSwitchedOff(chat, { disable: ['llm'] })).toBe(true)
  })

  it('未禁用时放行', () => {
    expect(isSwitchedOff(chat, { disable: ['pixiv'] })).toBe(false)
    expect(isSwitchedOff(chat, undefined)).toBe(false)
  })

  it('userCall=disabled 的指令只有在 enable 里才放行', () => {
    const secret = cmd('secret', null, 'disabled')
    expect(isSwitchedOff(secret, {})).toBe(true)
    expect(isSwitchedOff(secret, { enable: ['secret'] })).toBe(false)
  })
})

describe('SilentSwitch hook', () => {
  const setup = () => {
    const before = vi.fn()
    new SilentSwitch({ before } as any)
    const [event, hook, prepend] = before.mock.calls[0]
    return { event, hook, prepend }
  }

  it('以 prepend 挂在 command/execute 上，抢在 core 权限提示之前', () => {
    const { event, prepend } = setup()
    expect(event).toBe('command/execute')
    expect(prepend).toBe(true)
  })

  it('群里调用被禁用的指令时静默中止', () => {
    const { hook } = setup()
    const session = { isDirect: false, channel: { disable: ['chat'] } }
    expect(hook({ session, command: cmd('chat') })).toBe('')
  })

  it('私聊不拦截', () => {
    const { hook } = setup()
    const session = { isDirect: true, channel: { disable: ['chat'] } }
    expect(hook({ session, command: cmd('chat') })).toBeUndefined()
  })
})
