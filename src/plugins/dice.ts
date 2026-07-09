import { Context, h, interpolate } from '@koishijs/core'

import BasePlugin from '~/_boilerplate'

import {
  getUserIdFromSession,
  getUserNickFromSession,
} from '$utils/formatSession'

export interface DiceConfig {
  counts: number
  points: number
  symbol: DiceSymbol
}
export interface DiceResult {
  dice: DiceConfig
  history: number[]
  direct: number
  final: number
}
export enum CriticalResult {
  NONE,
  SUCCESS,
  FAILURE,
}
export enum DiceSymbol {
  PLUS,
  MINUS,
}
export enum CoinSide {
  FRONT = 1,
  BACK = 2,
}

export default class PluginDice extends BasePlugin {
  MSG = {
    success: '(❁´◡`❁) 成功',
    failure: '¯\\_ (ツ)_/¯ 失败',
    criticalSuccess: '(๑•̀ㅂ•́)و✧ 大成功！',
    criticalFailure: '(っ°Д°;)っ 大失败！',
    plus: '加上',
    minus: '减去',
    simplePlus: '加权',
    simpleMinus: '降权',
    coinFront: '正面',
    coinBack: '反面',
    nDices: '{{counts}}个{{points}}面骰',
    nCoins: '{{counts}}枚硬币',
  }

  constructor(ctx: Context, config: unknown) {
    super(ctx, config, 'dice')
    this.initCommands()
  }

  private initCommands() {
    this.ctx
      .command('dice [dice]', '掷骰子', {
        minInterval: 1000,
      })
      .alias('掷骰子', '投掷', '检定', 'r', 'roll')
      .usage(
        '投掷 [骰子表达式] [-d 难度值] [-C]\n例如“两个20面骰，简单加权5”：dice 2d20+5'
      )
      .option('no-critical', '-C 不检查大成功/大失败', { type: 'boolean' })
      .option('difficulty', '-d <difficulty:posint> 难度值', { type: 'posint' })
      .action(async ({ session, options }, diceStr) => {
        try {
          const dices = this.parseDices(diceStr)
          const results = dices.map((item) => this.dice(item))
          const resultStr = this.toResultString(
            results,
            options.difficulty,
            !options['no-critical']
          )

          return `${h.at(getUserIdFromSession(session), {
            name: getUserNickFromSession(session),
          })}${resultStr}`
        } catch (err) {
          return err.message || '' + err
        }
      })
    this.ctx
      .command('dice/flipcoin [side:string]', '抛硬币', { minInterval: 1000 })
      .alias('抛硬币', '硬币', 'coin', 'flip', 'c')
      .usage('抛硬币 [正/反]')
      .action(({ session }, side) => {
        let difficulty = 0
        if (side) {
          if (side.startsWith('正')) {
            difficulty = CoinSide.FRONT
          } else if (side.startsWith('反')) {
            difficulty = CoinSide.BACK
          }
        }
        return session.execute({
          name: 'dice',
          args: ['1d2'],
          options: { difficulty },
        })
      })
  }

  /**
   * 掷出骰子，并获取最终结果
   */
  dice(payload: DiceConfig): DiceResult {
    const { counts, points, symbol } = payload

    // 简单加权，没有投掷
    if (counts < 1) {
      return {
        dice: payload,
        history: [points],
        direct: points,
        final: points,
      }
    }

    let history: number[] = []
    for (let i = 0; i < counts; i++) {
      const roll = Math.floor(Math.random() * points) + 1
      history.push(roll)
    }
    const direct = history.reduce((a, b) => a + b, 0)
    const final = symbol === DiceSymbol.PLUS ? direct : -direct

    return {
      dice: payload,
      history,
      direct,
      final,
    }
  }

  /**
   * 从字符串中解析骰子的数量、点数和额外加权点数等信息
   * @example 可能出现的字符串格式
   * ```
   * - ``, `d20`, `1d20` 一个20面骰
   * - `2d20+5` 两个20面骰，加权5
   * ```
   * @param str
   * @returns
   */
  parseDices(str: string): DiceConfig[] {
    if (!str) return [{ symbol: DiceSymbol.PLUS, counts: 1, points: 20 }]
    const diceStrs = str.split(/[+-]/)
    const diceSymbolStrs = ['+', ...(str.match(/[+-]/g) || [])]

    // 骰子
    const normalDiceReg = /^(\d+)?[dD](\d+)$/
    // 纯数字简单加权
    const simpleDiceReg = /^\d+$/

    const dices: DiceConfig[] = []

    diceStrs.forEach((item, index) => {
      const symbol =
        diceSymbolStrs[index] === '+' ? DiceSymbol.PLUS : DiceSymbol.MINUS

      if (simpleDiceReg.test(item)) {
        const points = parseInt(item)
        if (points > 100) {
          throw new Error(`(${item}) 哎呀，加权太多啦！`)
        }
        dices.push({
          symbol,
          counts: 0,
          points: parseInt(item),
        })
        return
      }

      if (!normalDiceReg.test(item)) {
        throw new Error(`(${item}) 这个骰子好像有点奇怪……？`)
      }
      let [count, points] = item.split(/[dD]/)
      if (!count) count = '1'

      if (parseInt(count) < 1) {
        throw new Error(`(${item}) 掷出了……空气？这不对吧，骰子数量太少啦！`)
      }
      if (parseInt(count) > 1000) {
        throw new Error(
          `(${item}) 掷出了……一卡车骰子？这不对吧，骰子数量太多啦！`
        )
      }
      if (parseInt(points) > 1000) {
        throw new Error(`(${item}) 掷出了……玻璃球？这不对吧，骰子点数太多啦！`)
      }
      if (parseInt(points) < 2) {
        throw new Error(`(${item}) 掷出了……？这是哪个次元的骰子？`)
      }

      dices.push({
        symbol,
        counts: parseInt(count),
        points: parseInt(points),
      })
    })

    return dices
  }

  toDiceString(dice: DiceConfig) {
    const { counts, points, symbol } = dice
    const symbolStr = symbol === DiceSymbol.PLUS ? '' : '-'
    if (counts < 1) {
      return `${symbolStr}${points}`
    }
    return `${symbolStr}${counts}d${points}`
  }

  toDiceDescription(dice: DiceConfig, withSymbol = true) {
    const { counts, points, symbol } = dice

    if (counts < 1) {
      const join =
        symbol === DiceSymbol.PLUS ? this.MSG.simplePlus : this.MSG.simpleMinus
      return `${withSymbol ? join : ''}${points}点`
    } else {
      const join = withSymbol
        ? symbol === DiceSymbol.PLUS
          ? this.MSG.plus
          : this.MSG.minus
        : ''
      return `${withSymbol ? join : ''}${interpolate(points === 2 ? this.MSG.nCoins : this.MSG.nDices, { counts, points })}`
    }
  }

  /**
   * 在难度x检定中掷出了x个x面骰，结果为x(+x)：成功/失败/大成功/大失败
   * 当骰子数量为1时，如果掷出了1点或最大点数，会有特殊的提示，此时不显示加权值，提示为大成功/大失败
   */
  toResultString(results: DiceResult[], difficulty = 0, checkCritical = true) {
    const length = results.length
    const total = results.reduce((a, b) => a + b.final, 0)
    const lines: string[] = []

    // 特殊情况：硬币（有且仅有一个 1d2）
    if (
      length === 1 &&
      results[0].dice.counts === 1 &&
      results[0].dice.points === 2
    ) {
      const coinResultText =
        results[0].final === CoinSide.FRONT
          ? this.MSG.coinFront
          : this.MSG.coinBack
      lines.push(
        `随着一声清脆悦耳的“叮当”，硬币在桌面上翻腾几圈，最终稳稳地停留在……${coinResultText}！`
      )
      if (difficulty >= 1 && difficulty <= 2) {
        lines.push(
          results[0].final === difficulty ? this.MSG.success : this.MSG.failure
        )
      }
      return lines.join('\n')
    }

    // 当面数大于等于5的随机骰子数量为1时，才会检查大成功/大失败
    const canBeCritical =
      checkCritical &&
      difficulty &&
      results.filter((item) => item.dice.counts > 0 && item.dice.points >= 5)
        .length === 1
    const firstRandomDice = canBeCritical
      ? results.find((i) => i.dice.counts > 0)
      : null
    const criticalResult = firstRandomDice
      ? this.checkCriticalResult(firstRandomDice.dice, firstRandomDice)
      : CriticalResult.NONE

    if (difficulty) {
      if (criticalResult !== CriticalResult.NONE) {
        lines.push(
          criticalResult === CriticalResult.SUCCESS
            ? this.MSG.criticalSuccess
            : this.MSG.criticalFailure
        )
      } else {
        lines.push(total >= difficulty ? this.MSG.success : this.MSG.failure)
      }
      lines.push(`在难度 ${difficulty} 检定中行了 ${length} 次投掷：`)
    } else {
      lines.push(`共进行了 ${length} 次投掷：`)
    }

    results.forEach((item, index) => {
      const { dice, final, history } = item
      const diceStr = this.toDiceString(dice)
      lines.push(
        `${this.toDiceDescription(dice, index > 0)} = ${diceStr}(${
          history.length > 5 ? history.slice(0, 5).join(',') + '...' : history
        }) = ${final}`
      )
    })

    if (difficulty) {
      lines.push(`结果 = ${total} - ${difficulty} = ${total - difficulty}`)
    } else {
      lines.push(`结果 = ${total}`)
    }

    return lines.join('\n')
  }

  checkCriticalResult(dice: DiceConfig, result: DiceResult) {
    const { counts, points } = dice
    const { direct, final } = result

    // 不要检查降权
    if (final < 0) {
      return CriticalResult.NONE
    }

    if (counts === 1) {
      if (direct === 1) {
        return CriticalResult.FAILURE
      } else if (direct === points) {
        return CriticalResult.SUCCESS
      }
    }
    return CriticalResult.NONE
  }
}
