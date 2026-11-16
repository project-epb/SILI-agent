/**
 * @name pixiv
 * @command pixiv
 * @desc pixiv插画查看工具
 * @authority 1
 */
import { Context, Time, h } from 'koishi'

import BasePlugin from '~/_boilerplate'

import { Fexios } from 'fexios'

interface PixivIllustration {
  title: string
  description: string
  tags: { tags: { tag: string }[] }
  userName: string
  userId: string | number
  likeCount: number
  bookmarkCount: number
  viewCount: number
  createDate: string
}

type PixivPage = { urls: { original: string; regular: string } }

interface PixivUser {
  imageBig: string
  userId: string | number
  name: string
  comment?: string
}

type PixivResponse<T> = T | { body: T }

type PixivReplyData =
  | PixivUser
  | {
      id: number
      info: PixivIllustration
      pages: PixivPage[]
      page?: number
      original?: boolean
    }

const defaultConfigs = {
  apiBaseURL: 'https://www.pixiv.net',
  webBaseURL: 'https://www.pixiv.net',
  pximgBaseURL: '',
}

export default class PluginPixiv extends BasePlugin<typeof defaultConfigs> {
  readonly request: Fexios

  constructor(ctx: Context, initOptions?: Partial<typeof defaultConfigs>) {
    super(
      ctx,
      {
        ...defaultConfigs,
        ...initOptions,
      },
      'pixiv'
    )

    const { apiBaseURL = defaultConfigs.apiBaseURL } = this.config
    this.request = new Fexios({
      baseURL: apiBaseURL,
      headers: {
        referer: 'https://www.pixiv.net',
        'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8,ja;q=0.7',
      },
    })

    this.#setupCommands()
    this.#setupMiddlewares()
  }

  #setupCommands() {
    const ctx = this.ctx
    const req = this.request
    ctx
      .command('pixiv [id:posint]', 'pixiv.net 相关功能')
      .action(({ session, name }, id) => {
        if (!session) return
        if (id) {
          // return session.execute({ name: 'pixiv.illust', args: [id] })
          return session.execute(`pixiv.illust ${id}`)
        }
        return session.execute({ name, options: { help: true } })
      })

    ctx
      .command('pixiv.illust <id:posint>', '查看 Pixiv 插画', {
        minInterval: 10 * Time.second,
      })
      .alias('pixiv插画', 'p站插画', 'pixiv.i', 'pixiv.artwork')
      .option('page', '-p <p:posint> 从多张插画中进行选择', { fallback: 1 })
      .option('original', '-o 显示原画 (可能会慢很多)', { fallback: false })
      .action(async ({ session, options, name }, id) => {
        if (!session) return
        if (!id) {
          return session.execute({ name, options: { help: true } })
        }

        this.logger.info('pixiv.illust:', id, options)

        let info: PixivResponse<PixivIllustration>
        let pages: PixivResponse<PixivPage[]>
        try {
          ;[{ data: info }, { data: pages }] = await Promise.all([
            req.get<PixivResponse<PixivIllustration>>(
              `ajax/illust/${id}?full=1`
            ),
            req.get<PixivResponse<PixivPage[]>>(`ajax/illust/${id}/pages`),
          ])
        } catch (error) {
          this.logger.warn(error)
          return [
            h.quote(session.messageId as string),
            error?.response?.data?.message || error.message || '出现未知问题',
          ].join('')
        }

        return this.#illustrationReply(session.messageId, {
          id,
          info: 'body' in info ? info.body : info,
          pages: 'body' in pages ? pages.body : pages,
          page: options?.page,
          original: options?.original,
        })
      })

    ctx
      .command('pixiv.user <id:posint>')
      .alias('pixiv用户', 'p站用户', 'pixiv.u')
      .action(async ({ session, name: cmdName }, id) => {
        if (!session) return
        if (!id) {
          return session.execute({ name: cmdName, options: { help: true } })
        }

        let data: PixivResponse<PixivUser>
        try {
          ;({ data } = await req.get<PixivResponse<PixivUser>>(
            `ajax/user/${id}?full=1`
          ))
        } catch (error) {
          this.logger.warn(error)
          return [
            h.quote(session.messageId as string),
            error.message || '出现未知问题',
          ].join('')
        }

        return this.#illustrationReply(
          session.messageId,
          'body' in data ? data.body : data
        )
      })
  }

  #illustrationReply(messageId: string | undefined, data: PixivReplyData) {
    let imageUrl: string
    let lines: (string | undefined)[]

    if ('info' in data) {
      const { id, info, pages, page = 1, original } = data
      const selectedPage = Math.min(pages.length, page)
      const { urls } = pages[selectedPage - 1]
      imageUrl = original ? urls.original : urls.regular

      const description = info.description
        .replace(/<br.*?>/g, '\n')
        .replace(/<\/?.+?>/g, '')
      lines = [
        `第 ${selectedPage} 张，共 ${pages.length} 张`,
        info.title,
        description.length > 500
          ? description.slice(0, 500) + '...'
          : description,
        `作者: ${info.userName} (ID: ${info.userId})`,
        `👍${info.likeCount} ❤️${info.bookmarkCount} 👀${info.viewCount}`,
        `发布时间: ${new Date(info.createDate).toLocaleString()}`,
        info.tags.tags.map(({ tag }) => `#${tag}`).join(' '),
        new URL(`/i/${id}`, this.config.webBaseURL).href,
      ]
    } else {
      imageUrl = data.imageBig
      lines = [`${data.name} (${data.userId})`, data.comment]
    }

    const text = lines
      .map((line) => line?.trim().replace(/\n+/g, '\n'))
      .filter(Boolean)
      .join('\n')
    // QQ flushes pending text before attaching an image. Put the caption last.
    return [
      ...(messageId ? [h.quote(messageId)] : []),
      h.image(this.makePximgURL(imageUrl)),
      h.text(text),
    ]
  }

  #setupMiddlewares() {
    const ctx = this.ctx
    ctx.middleware(async (session, next) => {
      // Post-processing middleware: run downstream first, then maybe expand a pixiv link.
      // Forward the downstream result so a returned Fragment isn't swallowed.
      const result = await next()
      const reg =
        /(?:(?:https?:)?\/\/)?(?:pixiv\.net|www\.pixiv\.net|pixiv\.js\.org)\/(?:en\/)?(?:artworks|i)\/(\d+)/i
      const pixivId = reg.exec(session.content as string)
      if (pixivId && pixivId[1]) {
        session.execute({ name: 'pixiv.illust', args: [pixivId[1]] })
      }
      return result
    })
  }

  makePximgURL(url: string) {
    if (url.startsWith('http')) {
      if (!this.config.pximgBaseURL) {
        return url
      }
      url = new URL(url).pathname
    }
    return new URL(
      url,
      this.config.pximgBaseURL ||
        this.config.apiBaseURL ||
        this.config.webBaseURL
    ).href
  }
}
