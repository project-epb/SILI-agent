import { Context, Random, h } from '@koishijs/core'

import { BaseSticker } from './_base'

export default class 状态码猫猫 extends BaseSticker {
  readonly HTTP_MEME_SOURCES: {
    cmd: string
    desc: string
    aliases: string[]
    url: string
  }[] = [
    {
      cmd: 'sticker.http.cat',
      desc: 'HTTP Cats',
      aliases: ['httpcat', '状态码猫猫'],
      url: 'https://http.cat/$1.jpg',
    },
    {
      cmd: 'sticker.http.dog',
      desc: 'HTTP Dogs',
      aliases: ['httpdog', '状态码修狗', '状态码狗勾', '状态码狗狗'],
      url: 'https://http.dog/$1.jpg',
    },
    {
      cmd: 'sticker.http.goat',
      desc: 'HTTP Goats',
      aliases: ['httpgoat', '状态码小羊'],
      url: 'https://http.goat/$1.jpg',
    },
    {
      cmd: 'sticker.http.duck',
      desc: 'HTTP Ducks',
      aliases: ['httpduck', '状态码鸭鸭'],
      url: 'https://http.duck/$1.jpg',
    },
    {
      cmd: 'sticker.http.garden',
      desc: 'HTTP Gardens',
      aliases: ['httpgarden', '状态码花园'],
      url: 'https://http.garden/$1.jpg',
    },
    {
      cmd: 'sticker.http.pizza',
      desc: 'HTTP Pizzas',
      aliases: ['httppizza', '状态码披萨'],
      url: 'https://http.pizza/$1.jpg',
    },
    {
      cmd: 'sticker.http.fish',
      desc: 'HTTP Fish',
      aliases: ['httpfish', '状态码小鱼'],
      url: 'https://http.fish/$1.jpg',
    },
  ]

  constructor(public ctx: Context) {
    super(ctx)

    this.HTTP_MEME_SOURCES.forEach((source) => {
      ctx
        .command(`${source.cmd} <code>`, source.desc)
        .alias(...source.aliases)
        .action(async ({ session }, code) => {
          if (!code) code = '404'
          const finalCode = isNaN(+code) ? 404 : Math.abs(parseInt(code))
          return h.image(source.url.replace('$1', finalCode.toString()))
        })
    })

    ctx
      .command('sticker.http <code>', 'HTTP Thingies')
      .alias('httpmeme', '状态码表情包')
      .action(async ({ session }, code) => {
        const thing = Random.pick(this.HTTP_MEME_SOURCES)
        return session.execute({
          name: thing.cmd,
          args: [code],
        })
      })
  }
}
