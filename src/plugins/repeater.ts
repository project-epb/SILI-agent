import { Context, Dict, Random, Session, h } from 'koishi'

import BasePlugin from './_boilerplate'

export interface RepeatState {
  content: string
  times: number
  users: Dict<number>
  /** 本段复读链已经发生过 bot 跟读 */
  repeatTriggered: boolean
  /** 本段复读链已经发生过 bot 打断 */
  interruptTriggered: boolean
  /**
   * 这条 content 命中了 plugin 内置语料（如 interruptTexts 中的静态字符串）。
   * 跟读决策时遇到这种 state 直接跳过 send——挡掉用户故意模仿 bot 打断语
   * 想骗跟读的情况。打断/质询不受影响（只挡跟读）。
   * 在 makeState() 时算一次，避免每条消息重复查 Set。
   */
  matchedBuiltinText: boolean
}

/**
 * 文案池条目：可以是固定字符串，也可以是 `(state, session) => string` 回调。
 * **回调内不要调用 `session.send`**——只返回要发的字符串，发送由 plugin 统一处理。
 */
export type RepeatTextEntry =
  | string
  | ((state: RepeatState, session: Session) => string)

export interface Config {
  /** 第几条同内容开始有概率跟读，最小 3。默认 4 */
  repeatStartAt?: number
  /** 跟读后第几条同内容开始有概率打断，最小 = repeatStartAt + 1。默认 6 */
  interruptStartAt?: number

  /** 跟读起始概率。默认 0.3 */
  repeatInitialProb?: number
  /** 跟读概率每多 1 条递增量（封顶 1.0）。默认 0.2 */
  repeatStepProb?: number
  /** 打断起始概率。默认 0.2 */
  interruptInitialProb?: number
  /** 打断概率每多 1 条递增量（封顶 1.0）。默认 0.2 */
  interruptStepProb?: number
  /** 跟读链被打断时质询打断者的概率（单点）。默认 0.4 */
  queryProb?: number

  /** Escape hatch：完全自定义跟读概率，覆盖 *InitialProb / *StepProb */
  computeRepeatProb?: (state: RepeatState) => number
  /** Escape hatch：完全自定义打断概率 */
  computeInterruptProb?: (state: RepeatState) => number
  /** Escape hatch：完全自定义质询概率（拿到打断者的 session） */
  computeQueryProb?: (state: RepeatState, breaker: Session) => number

  /** 打断语料池（命中打断时随机抽一条） */
  interruptTexts?: RepeatTextEntry[]
  /** 质询语料池（命中质询时随机抽一条；通常用回调拼 `<at>`） */
  queryTexts?: RepeatTextEntry[]

  /**
   * 关闭内置语料守卫。默认开启 = 用户复读 bot 打断/质询语料时不会触发
   * bot 跟读，挡掉故意模仿 bot 骗跟读的情况。如有特殊需求（例如调试，
   * 或希望 bot 跟读自己的话）可显式置为 true 关掉。
   */
  disableBuiltinTextGuard?: boolean
}

type ResolvedConfig = Config & {
  repeatStartAt: number
  interruptStartAt: number
  repeatInitialProb: number
  repeatStepProb: number
  interruptInitialProb: number
  interruptStepProb: number
  queryProb: number
}

const DEFAULTS = {
  repeatStartAt: 4,
  interruptStartAt: 6,
  repeatInitialProb: 0.3,
  repeatStepProb: 0.2,
  interruptInitialProb: 0.2,
  interruptStepProb: 0.2,
  queryProb: 0.4,
}

export default class PluginRepeater extends BasePlugin<ResolvedConfig> {
  private readonly statusStore = new Map<string, RepeatState>()
  /**
   * 内置语料中的所有静态字符串集合：建 state 时用它给 RepeatState
   * 打 matchedBuiltinText 标记。函数项依赖运行时 state/session 无法静态
   * 匹配，跳过。
   */
  private readonly builtinTextSet: Set<string>

  constructor(ctx: Context, userConfig: Config = {}) {
    const config: ResolvedConfig = { ...DEFAULTS, ...userConfig }
    if (config.repeatStartAt < 3) config.repeatStartAt = 3
    if (config.interruptStartAt <= config.repeatStartAt) {
      config.interruptStartAt = config.repeatStartAt + 1
    }
    super(ctx, config, 'repeater')

    this.builtinTextSet = new Set(
      [
        ...(config.interruptTexts ?? []),
        ...(config.queryTexts ?? []),
      ].filter((t): t is string => typeof t === 'string')
    )

    this.handleRepeatChain()
    this.listenQqEmoji()
  }

  private getStatusKey(session: Session): string {
    return `${session.platform}:${session.channelId}`
  }

  private makeState(content: string, userId: string): RepeatState {
    return {
      content,
      times: 1,
      users: { [userId]: 1 },
      repeatTriggered: false,
      interruptTriggered: false,
      matchedBuiltinText: this.config.disableBuiltinTextGuard
        ? false
        : this.builtinTextSet.has(content),
    }
  }

  private pickText(
    pool: RepeatTextEntry[] | undefined,
    state: RepeatState,
    session: Session
  ): string | null {
    if (!pool?.length) return null
    const item = Random.pick(pool)
    const text = typeof item === 'function' ? item(state, session) : item
    return text || null
  }

  private repeatProbAt(state: RepeatState): number {
    if (this.config.computeRepeatProb) return this.config.computeRepeatProb(state)
    const offset = state.times - this.config.repeatStartAt
    return Math.min(
      1,
      this.config.repeatInitialProb + this.config.repeatStepProb * offset
    )
  }

  private interruptProbAt(state: RepeatState): number {
    if (this.config.computeInterruptProb)
      return this.config.computeInterruptProb(state)
    const offset = state.times - this.config.interruptStartAt
    return Math.min(
      1,
      this.config.interruptInitialProb + this.config.interruptStepProb * offset
    )
  }

  private queryProbAt(state: RepeatState, breaker: Session): number {
    if (this.config.computeQueryProb)
      return this.config.computeQueryProb(state, breaker)
    return this.config.queryProb
  }

  /**
   * 主状态机：每段复读链最多触发一次跟读、一次打断、一次质询。
   *
   * - 同内容累计 → 守卫 times>=3 → !R 时尝试跟读，R&&!I 时尝试打断
   * - 内容变化 → R 为真时按概率质询打断者；无论命中都消费机会，
   *   并用本条作为新链开端（保证"每段最多一次质询"）
   * - 跟读不清状态（链继续，等打断或被外部内容打断）
   * - 打断/质询命中后整段结束
   */
  private handleRepeatChain(): void {
    this.ctx.middleware(async (session, next) => {
      // Post-processing middleware: run downstream first, then advance the repeat state
      // machine. Forward the downstream result so a returned Fragment isn't swallowed.
      const result = await next()
      await this.processRepeatChain(session)
      return result
    })
  }

  /** Advance the per-channel repeat / interrupt / query state machine for one message. */
  private async processRepeatChain(session: Session): Promise<void> {
    const { content, userId } = session
    if (!content || !userId) return

    const key = this.getStatusKey(session)
    const state = this.statusStore.get(key)

    if (!state) {
      this.statusStore.set(key, this.makeState(content, userId))
      return
    }

    // 内容变化 = 当前发言者打破了之前的复读链
    if (state.content !== content) {
      if (state.repeatTriggered) {
        // 之前 bot 跟读过 → 概率质询打断者；无论命中都消费机会
        const prob = this.queryProbAt(state, session)
        if (Math.random() < prob) {
          const msg = this.pickText(this.config.queryTexts, state, session)
          if (msg) await session.send(msg)
        }
      }
      // 整段结束，本条作为新链的第一条
      this.statusStore.set(key, this.makeState(content, userId))
      return
    }

    // 同内容累计
    state.times += 1
    state.users[userId] = (state.users[userId] || 0) + 1

    // 守卫：≥3 次同内容才算复读
    if (state.times < 3) return

    // 跟读
    if (!state.repeatTriggered && state.times >= this.config.repeatStartAt) {
      // 守卫：state.content 是 bot 打断/质询语料 → 不跟读，避免被
      // 用户故意模仿 bot 说话骗跟读。state 自身仍然累计，下一条
      // 不同内容来时正常重建 state。
      if (state.matchedBuiltinText) return
      if (Math.random() < this.repeatProbAt(state)) {
        state.repeatTriggered = true
        await session.send(state.content)
      }
      return
    }

    // 打断（必须先跟读过；每段最多一次）
    if (
      state.repeatTriggered &&
      !state.interruptTriggered &&
      state.times >= this.config.interruptStartAt
    ) {
      if (Math.random() < this.interruptProbAt(state)) {
        state.interruptTriggered = true
        const msg = this.pickText(this.config.interruptTexts, state, session)
        if (msg) await session.send(msg)
        // 整段结束，下次相同内容重新积累
        this.statusStore.delete(key)
      }
    }
  }

  // 一些能够接龙的 QQ 表情
  private listenQqEmoji(): void {
    const DRAGONS = [392, 393, 394]
    const TRAINS = [419, 420, 421]
    const SNAKES = [429, 430, 431]

    this.ctx.platform('onebot').middleware(async (session, next) => {
      // Post-processing middleware: run downstream first, then maybe continue an emoji chain.
      // Forward the downstream result so a returned Fragment isn't swallowed.
      const result = await next()

      const faces = h.select(session.elements, 'face')

      if (faces.length === 1) {
        const faceId = parseInt(faces[0].attrs.id)

        // 龙 自动接下一个
        if (DRAGONS.includes(faceId)) {
          session.send(
            h('face', { ...faces[0].attrs, id: Math.min(394, faceId + 1) })
          )
        }
        // TODO: 火车头 不确定机制
        else if (TRAINS.includes(faceId)) {
          session.send(
            h('face', {
              ...faces[0].attrs /** id: Math.min(421, faceId + 1) */,
            })
          )
        }
        // 蛇年接下一个
        else if (SNAKES.includes(faceId)) {
          if (faceId === 431 && Math.random() > 0.9) {
            // 隐藏款，概率10%
            session.send(
              h('face', {
                ...faces[0].attrs,
                id: 432,
              })
            )
          } else {
            session.send(
              h('face', {
                ...faces[0].attrs,
                id: Math.min(431, faceId + 1),
              })
            )
          }
        }
      }
      return result
    })
  }
}
