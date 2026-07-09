/**
 * @name pixiv
 * @command pixiv
 * @desc pixiv插画查看工具
 * @authority 1
 */
import { Context, Time, h } from '@koishijs/core'

import BasePlugin from '~/_boilerplate'

import { BulkMessageBuilder } from '$utils/BulkMessageBuilder'
import { Fexios } from 'fexios'

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

        // FIXME: no idea why
        options.page ??= 1
        options.original ??= false

        let info, pages
        try {
          ;[{ data: info }, { data: pages }] = await Promise.all([
            req.get(`ajax/illust/${id}?full=1`),
            req.get(`ajax/illust/${id}/pages`),
          ])
          if (info.body) {
            info = info.body
          }
          if (pages.body) {
            pages = pages.body
          }
        } catch (error) {
          this.logger.warn(error)
          return [
            h.quote(session.messageId as string),
            error?.response?.data?.message || error.message || '出现未知问题',
          ].join('')
        }

        const totalImages = pages.length
        const selectedPage = Math.min(totalImages, options!.page as number)
        const imageUrl = options!.original
          ? pages[selectedPage - 1].urls.original
          : pages[selectedPage - 1].urls.regular

        const desc = info.description
          .replace(/<br.*?>/g, '\n')
          .replace(/<\/?.+?>/g, '')
        const allTags = info.tags.tags.map((i: any) => `#${i.tag}`)

        const builder = new BulkMessageBuilder(session)
        builder.prependOriginal()
        const lines = [
          h.image(this.makePximgURL(imageUrl)),
          totalImages ? `第 ${selectedPage} 张，共 ${totalImages} 张` : null,
          `${info.title}`,
          desc.length > 500 ? desc.substring(0, 500) + '...' : desc,
          `作者: ${info.userName} (ID: ${info.userId})`,
          `👍${info.likeCount} ❤️${info.bookmarkCount} 👀${info.viewCount}`,
          `发布时间: ${new Date(info.createDate).toLocaleString()}`,
          allTags.length ? allTags.join(' ') : null,
          new URL(`/i/${id}`, this.config.webBaseURL).href,
        ].map((i) =>
          typeof i === 'string' ? i.trim().replace(/\n+/g, '\n') : i
        )
        lines.forEach((i) => builder.botSay(i))

        return builder.all()
      })

    ctx
      .command('pixiv.user <id:posint>')
      .alias('pixiv用户', 'p站用户', 'pixiv.u')
      .action(async ({ session, name: cmdName }, id) => {
        if (!session) return
        if (!id) {
          return session.execute({ name: cmdName, options: { help: true } })
        }

        let data: any
        try {
          data = (await req.get(`ajax/user/${id}?full=1`)).data
          if (data.body) {
            data = data.body
          }
        } catch (error) {
          this.logger.warn(error)
          return [
            h.quote(session.messageId as string),
            error.message || '出现未知问题',
          ].join('')
        }

        const { imageBig, userId, name, comment } = data

        const builder = new BulkMessageBuilder(session)
        builder.prependOriginal()
        const lines = [
          h.image(this.makePximgURL(imageBig)),
          `${name} (${userId})`,
          comment,
        ].map((i) =>
          typeof i === 'string' ? i.trim().replace(/\n+/g, '\n') : i
        )
        lines.forEach((i) => builder.botSay(i))

        return builder.all()
      })
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
