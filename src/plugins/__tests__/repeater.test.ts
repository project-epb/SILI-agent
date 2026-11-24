import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// koishi 包顶层会拉 loader 等运行时副作用，在 vitest 下加载失败；
// 测试只需要 BasePlugin 用到的 snakeCase + plugin 自身用到的 Random.pick，
// 其他全 stub 掉即可。
vi.mock('koishi', () => {
  const snakeCase = (s: string) =>
    s.replace(/([a-z])([A-Z])/g, '$1_$2').toLowerCase()
  return {
    Context: class {},
    Logger: class {},
    snakeCase,
    Random: {
      // 测试里通过控制 Math.random 已经能覆盖概率分支；这里固定取首元素，
      // 让 pickText 的结果可预测。
      pick: <T>(arr: readonly T[]): T => arr[0],
    },
  }
})

import PluginRepeater, { type Config, type RepeatState } from '../repeater'

type MiddlewareFn = (
  session: any,
  next: () => Promise<void>
) => Promise<void> | void

function makeMockCtx() {
  const middlewares: MiddlewareFn[] = []
  const ctx: any = {
    logger: () => ({
      info: () => {},
      warn: () => {},
      error: () => {},
      success: () => {},
      debug: () => {},
    }),
    middleware: (fn: MiddlewareFn) => {
      middlewares.push(fn)
      return () => {}
    },
  }
  return { ctx, middlewares }
}

interface SessionInit {
  content: string
  userId: string
  selfId?: string
  channelId?: string
  platform?: string
}

function makeSession(init: SessionInit) {
  const sent: any[] = []
  const session: any = {
    platform: init.platform ?? 'test',
    selfId: init.selfId ?? 'bot',
    channelId: init.channelId ?? 'ch1',
    userId: init.userId,
    content: init.content,
    elements: [],
    send: async (msg: any) => {
      sent.push(msg)
    },
  }
  return { session, sent }
}

async function fire(mw: MiddlewareFn, session: any): Promise<void> {
  await mw(session, () => Promise.resolve())
}

/** Run a sequence of (content, userId) through the middleware, returning all
 *  messages bot tried to send. Channel/platform are fixed for the run. */
async function runChain(
  mw: MiddlewareFn,
  events: Array<[content: string, userId: string]>
): Promise<any[]> {
  const all: any[] = []
  for (const [content, userId] of events) {
    const { session, sent } = makeSession({ content, userId })
    await fire(mw, session)
    all.push(...sent)
  }
  return all
}

function setup(config: Config = {}): {
  mw: MiddlewareFn
  plugin: PluginRepeater
} {
  const { ctx, middlewares } = makeMockCtx()
  const plugin = new PluginRepeater(ctx, config)
  return { mw: middlewares[0], plugin }
}

describe('PluginRepeater', () => {
  let randomSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    // 默认必中（Math.random < prob 时命中，0 一定 < 任何 prob>0）
    randomSpy = vi.spyOn(Math, 'random').mockReturnValue(0)
  })

  afterEach(() => {
    randomSpy.mockRestore()
  })

  describe('守卫', () => {
    it('< 3 条同内容时不进入决策', async () => {
      const { mw } = setup()
      const sent = await runChain(mw, [
        ['草', 'A'],
        ['草', 'B'],
      ])
      expect(sent).toEqual([])
    })

    it('repeatStartAt 为 4 时第 3 条仍不跟读', async () => {
      const { mw } = setup()
      const sent = await runChain(mw, [
        ['草', 'A'],
        ['草', 'B'],
        ['草', 'C'],
      ])
      expect(sent).toEqual([])
    })
  })

  it('isolates repeat chains by bot in the same channel', async () => {
    const { mw } = setup()
    await runChain(mw, [['草', 'A'], ['草', 'B'], ['草', 'C']])

    const other = makeSession({ content: '草', userId: 'D', selfId: 'other' })
    await fire(mw, other.session)
    expect(other.sent).toEqual([])

    const original = makeSession({ content: '草', userId: 'D' })
    await fire(mw, original.session)
    expect(original.sent).toEqual(['草'])
  })

  it('breaks a text chain when a message contains an image', async () => {
    const { mw } = setup()
    await runChain(mw, [['草', 'A'], ['草', 'B'], ['草', 'C']])
    const image = makeSession({ content: '草', userId: 'D' })
    image.session.elements = [{ type: 'img' }]
    await fire(mw, image.session)
    expect(image.sent).toEqual([])
    expect(await runChain(mw, [['草', 'E']])).toEqual([])
  })

  describe('跟读分支', () => {
    it('达到 repeatStartAt 且概率命中 → 发原 content 一次', async () => {
      randomSpy.mockReturnValue(0)
      const { mw } = setup()
      const sent = await runChain(mw, [
        ['草', 'A'],
        ['草', 'B'],
        ['草', 'C'],
        ['草', 'D'],
      ])
      expect(sent).toEqual(['草'])
    })

    it('概率不命中 → 不发，下一条仍可尝试', async () => {
      randomSpy.mockReturnValue(0.99) // 必不中
      const { mw } = setup()
      const sent4 = await runChain(mw, [
        ['草', 'A'],
        ['草', 'B'],
        ['草', 'C'],
        ['草', 'D'],
      ])
      expect(sent4).toEqual([])

      // 第 5 条切回必中：仍然能补跟读（!repeatTriggered）
      randomSpy.mockReturnValue(0)
      const { session, sent } = makeSession({ content: '草', userId: 'E' })
      await fire(mw, session)
      expect(sent).toEqual(['草'])
    })

    it('一段链内只跟读一次（4-5 都命中也只发一条）', async () => {
      randomSpy.mockReturnValue(0)
      const { mw } = setup()
      const sent = await runChain(mw, [
        ['草', 'A'],
        ['草', 'B'],
        ['草', 'C'],
        ['草', 'D'], // 跟读
        ['草', 'E'], // times=5, 还没到 interruptStartAt(6)
      ])
      expect(sent).toEqual(['草'])
    })
  })

  describe('打断分支', () => {
    it('跟读后 times>=interruptStartAt 命中 → 发打断语并清状态', async () => {
      randomSpy.mockReturnValue(0)
      const { mw } = setup({ interruptTexts: ['STOP'] })
      const sent = await runChain(mw, [
        ['草', 'A'], // 1
        ['草', 'B'], // 2
        ['草', 'C'], // 3
        ['草', 'D'], // 4 → 跟读
        ['草', 'E'], // 5
        ['草', 'F'], // 6 → 打断
      ])
      expect(sent).toEqual(['草', 'STOP'])

      // state 已清，再来一条同内容应只是新链第 1 条
      const { session, sent: tail } = makeSession({
        content: '草',
        userId: 'G',
      })
      await fire(mw, session)
      expect(tail).toEqual([])
    })

    it('打断只触发一次：跟读后概率不中再中也只发一次', async () => {
      const { mw } = setup({ interruptTexts: ['STOP'] })

      // A-D 必中跟读
      randomSpy.mockReturnValue(0)
      await runChain(mw, [
        ['草', 'A'],
        ['草', 'B'],
        ['草', 'C'],
        ['草', 'D'],
      ])

      // E 不中
      randomSpy.mockReturnValue(0.99)
      const { session: s5, sent: c5 } = makeSession({
        content: '草',
        userId: 'E',
      })
      await fire(mw, s5)
      expect(c5).toEqual([])

      // F 必中 → 打断；G 同内容应被新链处理（state 已删）
      randomSpy.mockReturnValue(0)
      const { session: s6, sent: c6 } = makeSession({
        content: '草',
        userId: 'F',
      })
      await fire(mw, s6)
      expect(c6).toEqual(['STOP'])

      // G/H/I/J: state 重新累计，第 4 条才会再次跟读
      randomSpy.mockReturnValue(0)
      const tail = await runChain(mw, [
        ['草', 'G'],
        ['草', 'H'],
        ['草', 'I'],
        ['草', 'J'],
      ])
      expect(tail).toEqual(['草']) // 新一段的跟读
    })

    it('未跟读则永不打断（即便 times 远超 interruptStartAt）', async () => {
      // 用 escape hatch 强制跟读概率为 0；只用 randomSpy 的话概率曲线会
      // 在 times=8 时封顶 1.0 仍会命中。
      const { mw } = setup({
        interruptTexts: ['STOP'],
        computeRepeatProb: () => 0,
      })
      const sent = await runChain(mw, [
        ['草', 'A'],
        ['草', 'B'],
        ['草', 'C'],
        ['草', 'D'],
        ['草', 'E'],
        ['草', 'F'],
        ['草', 'G'],
        ['草', 'H'],
      ])
      expect(sent).toEqual([])
    })
  })

  describe('质询分支', () => {
    it('跟读后内容变化 + 命中 → 发质询语', async () => {
      randomSpy.mockReturnValue(0)
      const { mw } = setup({
        queryTexts: [
          (_state: RepeatState, breaker) => `query@${breaker.userId}`,
        ],
      })
      const sent = await runChain(mw, [
        ['草', 'A'],
        ['草', 'B'],
        ['草', 'C'],
        ['草', 'D'], // 跟读
        ['别复读了', 'E'], // 内容变化 → 质询
      ])
      expect(sent).toEqual(['草', 'query@E'])
    })

    it('未跟读时内容变化不质询', async () => {
      randomSpy.mockReturnValue(0)
      const { mw } = setup({ queryTexts: ['QUERY'] })
      const sent = await runChain(mw, [
        ['草', 'A'],
        ['草', 'B'],
        ['草', 'C'], // times=3，但还没到 repeatStartAt=4
        ['别', 'D'], // 内容变化，state.repeatTriggered=false → 不质询
      ])
      expect(sent).toEqual([])
    })

    it('每段最多一次质询：不命中也消费机会', async () => {
      const { mw } = setup({ queryTexts: ['QUERY'] })

      // 跟读
      randomSpy.mockReturnValue(0)
      await runChain(mw, [
        ['草', 'A'],
        ['草', 'B'],
        ['草', 'C'],
        ['草', 'D'],
      ])

      // 第一次内容变化，质询概率不中
      randomSpy.mockReturnValue(0.99)
      const { session: s1, sent: c1 } = makeSession({
        content: '别',
        userId: 'E',
      })
      await fire(mw, s1)
      expect(c1).toEqual([])

      // 第二次内容变化，即便概率必中也不再质询（新链 R=false）
      randomSpy.mockReturnValue(0)
      const { session: s2, sent: c2 } = makeSession({
        content: '哦',
        userId: 'F',
      })
      await fire(mw, s2)
      expect(c2).toEqual([])
    })
  })

  describe('内置语料守卫', () => {
    it('用户复读 bot 打断语 → 不跟读', async () => {
      randomSpy.mockReturnValue(0)
      const { mw } = setup({ interruptTexts: ['STOP'] })
      const sent = await runChain(mw, [
        ['STOP', 'A'],
        ['STOP', 'B'],
        ['STOP', 'C'],
        ['STOP', 'D'],
      ])
      expect(sent).toEqual([])
    })

    it('static queryTexts 也被守卫覆盖', async () => {
      randomSpy.mockReturnValue(0)
      const { mw } = setup({ queryTexts: ['QFIXED'] })
      const sent = await runChain(mw, [
        ['QFIXED', 'A'],
        ['QFIXED', 'B'],
        ['QFIXED', 'C'],
        ['QFIXED', 'D'],
      ])
      expect(sent).toEqual([])
    })

    it('用户模仿打断语后真的"草"复读：state 链照常被打断/重建', async () => {
      randomSpy.mockReturnValue(0)
      const { mw } = setup({ interruptTexts: ['STOP'] })
      const sent = await runChain(mw, [
        ['草', 'A'],
        ['草', 'B'],
        ['草', 'C'], // state {草, times=3, R=F}
        ['STOP', 'D'], // 内容变化，R=F 不质询；新 state {STOP, 1, matched=T}
        ['STOP', 'E'], // {STOP, 2}
        ['STOP', 'F'], // {STOP, 3}
        ['STOP', 'G'], // {STOP, 4} 命中跟读条件但 matchedBuiltinText=true → noop
        ['草', 'H'], // 内容变化，新链 {草, 1, matched=F}
      ])
      // bot 全程没发任何东西
      expect(sent).toEqual([])
    })

    it('disableBuiltinTextGuard=true 关掉守卫', async () => {
      randomSpy.mockReturnValue(0)
      const { mw } = setup({
        interruptTexts: ['STOP'],
        disableBuiltinTextGuard: true,
      })
      const sent = await runChain(mw, [
        ['STOP', 'A'],
        ['STOP', 'B'],
        ['STOP', 'C'],
        ['STOP', 'D'],
      ])
      expect(sent).toEqual(['STOP']) // 跟读了
    })
  })

  describe('配置 clamp', () => {
    it('repeatStartAt < 3 自动夹到 3', () => {
      const { plugin } = setup({ repeatStartAt: 1 })
      expect(plugin.config.repeatStartAt).toBe(3)
    })

    it('interruptStartAt <= repeatStartAt 自动顶到 +1', () => {
      const { plugin } = setup({ repeatStartAt: 5, interruptStartAt: 5 })
      expect(plugin.config.interruptStartAt).toBe(6)
    })
  })

  describe('概率函数 escape hatch', () => {
    it('computeRepeatProb 覆盖默认曲线', async () => {
      randomSpy.mockReturnValue(0.5)
      const calls: number[] = []
      const { mw } = setup({
        computeRepeatProb: (state) => {
          calls.push(state.times)
          return state.times >= 5 ? 1 : 0 // 第 5 条强制必中
        },
      })
      const sent = await runChain(mw, [
        ['草', 'A'],
        ['草', 'B'],
        ['草', 'C'],
        ['草', 'D'], // times=4，prob=0 不中
        ['草', 'E'], // times=5，prob=1 必中
      ])
      expect(sent).toEqual(['草'])
      expect(calls).toEqual([4, 5])
    })

    it('computeQueryProb 拿到 breaker session', async () => {
      randomSpy.mockReturnValue(0)
      const seen: { times: number; breakerId: string }[] = []
      const { mw } = setup({
        queryTexts: ['Q'],
        computeQueryProb: (state, breaker) => {
          seen.push({ times: state.times, breakerId: breaker.userId })
          return 1
        },
      })
      await runChain(mw, [
        ['草', 'A'],
        ['草', 'B'],
        ['草', 'C'],
        ['草', 'D'], // 跟读
        ['别', 'E'], // 触发 query
      ])
      expect(seen).toEqual([{ times: 4, breakerId: 'E' }])
    })
  })

  describe('多 channel 隔离', () => {
    it('不同 channelId 状态独立', async () => {
      randomSpy.mockReturnValue(0)
      const { mw } = setup()
      const fireOn = async (
        ch: string,
        events: Array<[string, string]>
      ): Promise<any[]> => {
        const all: any[] = []
        for (const [content, userId] of events) {
          const { session, sent } = makeSession({
            content,
            userId,
            channelId: ch,
          })
          await fire(mw, session)
          all.push(...sent)
        }
        return all
      }

      const ch1 = await fireOn('CH1', [
        ['草', 'A'],
        ['草', 'B'],
        ['草', 'C'],
      ])
      const ch2 = await fireOn('CH2', [
        ['草', 'A'],
        ['草', 'B'],
      ])
      expect(ch1).toEqual([])
      expect(ch2).toEqual([])

      // ch1 凑到第 4 条 → 跟读；ch2 仍在 2 → 没动作
      const ch1tail = await fireOn('CH1', [['草', 'D']])
      expect(ch1tail).toEqual(['草'])
      const ch2tail = await fireOn('CH2', [['草', 'C']])
      expect(ch2tail).toEqual([])
    })
  })
})
