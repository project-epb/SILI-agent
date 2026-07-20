/**
 * @name koishi-plugin-mediawiki
 * @desc MediaWiki plugin for Koishijs
 *
 * @author Koishijs(机智的小鱼君) <dragon-fish@qq.com>
 * @license Apache-2.0
 */
import { Context, Time, h } from 'koishi'

import BasePlugin from '~/_boilerplate'

import { BulkMessageBuilder } from '$utils/BulkMessageBuilder'

import { INFOBOX_DEFINITION } from './infoboxes'
import type { Config } from './types/Config'
import type { InfoboxDefinition } from './types/Infobox'
import type {
  MWInterwikiLinks,
  MWNamespaceAliases,
  MWNamespaces,
  MWPages,
  MWRedirects,
  MWSpecialPageAliases,
} from './types/MediaWiki'
import {
  getUrl,
  getWikiDisplayTitle,
  isValidApi,
  parseTitlesFromText,
  useApi,
} from './utils'
import { isUserRootPage, shotUserInfobox } from './user-infobox'

declare module 'koishi' {
  export interface Channel {
    mwApi?: string
  }
}

const DEFAULT_CONFIGS: Config = {
  cmdAuthWiki: 1,
  cmdAuthConnect: 2,
  cmdAuthSearch: 1,
  searchIfNotExist: false,
  showDetailsByDefault: false,
  customInfoboxes: [],
}
export { Config }

export const name = 'mediawiki'
export default class PluginMediawiki extends BasePlugin<Config> {
  static inject = ['database', 'puppeteer', 'html']

  readonly INFOBOX_DEFINITION = INFOBOX_DEFINITION

  constructor(ctx: Context, configs: Partial<Config> = {}) {
    super(ctx, { ...DEFAULT_CONFIGS, ...configs }, 'mediawiki')

    ctx.model.extend('channel', {
      mwApi: 'string',
    })
    this.initCommands()
  }

  private initCommands(): void {
    // @command wiki
    this.ctx
      .command('wiki [titles:text]', 'MediaWiki 相关功能', {
        authority: this.config.cmdAuthWiki,
      })
      .example('wiki 页面 - 获取页面链接')
      .channelFields(['mwApi'])
      .option('details', '-d 显示页面的更多资讯', {
        type: 'boolean',
        fallback: this.config.showDetailsByDefault,
      })
      .option('search', '-s 如果页面不存在就进行搜索', {
        type: 'boolean',
        fallback: this.config.searchIfNotExist,
      })
      .option('quiet', '-q 静默执行（忽略未绑定提示）', {
        type: 'boolean',
        hidden: true,
      })
      .action(async ({ session, options }, titlesInput = '') => {
        if (!session?.channel) throw new Error('Missing channel context')
        const { mwApi } = session.channel

        // Missing connection init
        if (!mwApi) {
          return options?.quiet ? '' : session.execute('wiki.connect -h')
        }
        // Missing titles
        if (!titlesInput) {
          return getUrl(mwApi)
        }

        // Generate API client
        const api = await useApi(mwApi)

        // 去重并缓存用户输入的标题及锚点
        const titles = Array.from(
          new Set(titlesInput.split('|').map(getWikiDisplayTitle))
        )
          .map((i) => {
            return {
              name: i.split('#')[0],
              anchor: i.split('#')[1] ? '#' + encodeURI(i.split('#')[1]) : '',
            }
          })
          .filter((i) => !!i.name)
          .slice(0, 5)

        const { data } = await api
          .get<{
            query: {
              pages: MWPages
              redirects?: MWRedirects
              interwiki?: MWInterwikiLinks
              specialpagealiases: MWSpecialPageAliases
              namespacealiases: MWNamespaceAliases
              namespaces: MWNamespaces
            }
          }>({
            action: 'query',
            prop: 'extracts|info',
            meta: 'siteinfo',
            siprop: 'specialpagealiases|namespacealiases|namespaces',
            iwurl: 1,
            titles: titles.map((i) => i.name),
            redirects: 1,
            converttitles: 1,
            exchars: '120',
            exlimit: 'max',
            explaintext: 1,
            exintro: 1,
            exsectionformat: 'plain',
            inprop: 'url|displaytitle',
          })
          .then((res) => {
            this.logger.info('QUERY DATA', res.data)
            // @ts-ignore
            if (res.data?.error || res.data?.errors) {
              throw new Error(
                // @ts-ignore
                JSON.stringify(res.data?.error || res.data?.errors, null, 2)
              )
            }
            if (!res.data?.query) {
              throw new Error('Invalid response data')
            }
            return res
          })
          .catch((e: any) => {
            console.error('action=query error', e, e?.cause)
            session.send(
              [
                `⚠️查询时遇到问题：${e || '-'}`,
                ...titles.map(
                  (i) =>
                    `${i.name} - ${getUrl(mwApi, { title: i.name })}${i.anchor ? '#' + i.anchor : ''}`
                ),
              ].join('\n')
            )
            throw e
          })

        // Cache variables
        const { pages, redirects, interwiki, specialpagealiases, namespaces } =
          data.query
        /**
         * @desc 某些特殊页面会暴露服务器 IP 地址，必须特殊处理这些页面
         *       已知的危险页面包括 Mypage Mytalk
         */
        // 这里用标准名称
        const dangerPageNames = ['Mypage', 'Mytalk']
        // 获取全部别名
        const dangerPages = specialpagealiases
          .filter((i) => dangerPageNames.includes(i.realname))
          .map((i) => i.aliases)
          .flat(Infinity) as string[]
        // 获取本地特殊名字空间的标准名称
        const specialNsName = namespaces['-1'].name

        const pageMsgs =
          pages?.map((page) => {
            // Cache variables
            const msg: string[] = []
            let pageRedirect = redirects?.find(({ to }) => to === page.title)
            let pageAnchor =
              titles.find(
                (i) =>
                  i.name.toLocaleLowerCase() === page.title.toLocaleLowerCase()
              )?.anchor || ''

            // 开始判断危险重定向
            if (
              // 发生重定向
              pageRedirect &&
              // 重定向自特殊页面
              pageRedirect.from.split(':')[0] === specialNsName &&
              // 被标记为危险页面
              dangerPages.includes(
                pageRedirect.from.split(':')?.[1].split('/')[0] || ''
              )
            ) {
              // 覆写页面资料
              page = {
                ...page,
                ns: -1,
                title: pageRedirect.from,
                special: true,
              }
              // 重置重定向信息
              pageRedirect = undefined
              delete page.missing
            }

            const {
              pageid,
              title: pagetitle,
              missing,
              invalid,
              // extract,
              canonicalurl,
              special,
              editurl,
            } = page

            // 打印开头
            msg.push(`您要的“${pagetitle}”：`)
            /** 处理特殊情况 */
            // 重定向
            if (pageRedirect) {
              const { from, to, tofragment } = pageRedirect || {}
              msg.push(
                `重定向：[${from}] → [${to}${
                  tofragment ? '#' + tofragment : ''
                }]`
              )
              if (tofragment) pageAnchor = '#' + encodeURI(tofragment)
            }
            // 页面名不合法
            if (invalid !== undefined) {
              msg.push(
                `😟页面名称不合法：${
                  JSON.stringify(page.invalidreason) || '原因未知'
                }`
              )
            }
            // 特殊页面
            else if (special) {
              msg.push(
                `${getUrl(mwApi, {
                  title: pagetitle,
                })}${pageAnchor} (${missing ? '不存在的' : ''}特殊页面)`
              )
            }
            // 不存在页面
            else if (missing !== undefined) {
              if (!options?.search) {
                msg.push(`${editurl} (💔页面不存在)`)
              } else {
                msg.push(`${editurl}\n💡页面不存在，即将搜索wiki……`)
              }
            } else {
              const shortUrl = getUrl(mwApi, { curid: pageid })
              msg.push(
                (shortUrl.length <= canonicalurl.length
                  ? shortUrl
                  : canonicalurl) + pageAnchor
              )
            }

            if (options?.details && page.extract) {
              msg.push(page.extract)
            }

            return msg.join('\n')
          }) || []

        const interwikiMsgs =
          interwiki?.map((item) => {
            return [`跨语言链接：`, item.url].join('\n')
          }) || []

        const allMsgList = [...pageMsgs, ...interwikiMsgs]
        let finalMsg: string | h = ''
        if (allMsgList.length === 1) {
          finalMsg = h.quote(session.messageId as string) + allMsgList[0]
        } else if (allMsgList.length > 1) {
          const msgBuilder = new BulkMessageBuilder(session)
          allMsgList.forEach((i) => {
            msgBuilder.botSay(i)
          })
          finalMsg = msgBuilder.prependOriginal().all()
        }

        // 结果有且仅有一个存在的主名字空间的页面
        if (
          pages?.length === 1 &&
          pages[0].ns === 0 &&
          !pages[0].missing &&
          !pages[0].invalid
        ) {
          await session.send(finalMsg)
          session.send(await this.shotInfobox(pages[0].canonicalurl))
        }
        // 结果有且仅有一个用户名字空间（ns=2）的根页面 → 伪信息框（不看页面是否存在，看用户是否存在）
        else if (pages?.length === 1 && isUserRootPage(pages[0])) {
          await session.send(finalMsg)
          session.send(await shotUserInfobox(this.ctx, api, pages[0]))
        }
        // 结果有且仅有一个不存在的主名字空间的页面
        else if (
          options?.search &&
          pages?.length === 1 &&
          pages[0].ns === 0 &&
          pages[0].missing &&
          !pages[0].invalid
        ) {
          await session.send(finalMsg)
          await session.execute(`wiki.search ${pages[0].title}`)
        }
        // 其他情况
        else {
          return finalMsg
        }
      })

    this.ctx.middleware(async (session, next) => {
      // Post-processing middleware: run downstream first, then maybe expand [[wiki links]].
      // Forward the downstream result so a returned Fragment isn't swallowed.
      const result = await next()
      const titles = parseTitlesFromText(session.content || '')
      if (titles.length) {
        session.execute(`wiki -q ${titles.join('|')}`)
      }
      return result
    })

    // @command wiki.connect
    // @command wiki.link
    this.ctx
      .command('wiki.connect [api:string]', '将群聊与 MediaWiki 网站连接', {
        authority: this.config.cmdAuthConnect,
      })
      .alias('wiki.link')
      .channelFields(['mwApi'])
      .action(async ({ session }, api) => {
        if (!session?.channel) throw new Error()
        const { channel } = session

        if (!api) {
          return channel.mwApi
            ? `本群已与 ${channel.mwApi} 连接~`
            : '本群未连接到 MediaWiki 网站，请使用“wiki.connect <api网址>”进行连接。'
        }

        if (!isValidApi(api)) {
          return '输入的不是合法 api.php 网址。'
        }

        channel.mwApi = api
        await session.channel.$update()
        return session.execute('wiki.connect')
      })

    // @command wiki.search
    this.ctx
      .command('wiki.search [keywords:text]', '搜索wiki，并展示靠前的结果', {
        minInterval: 10 * Time.second,
      })
      .channelFields(['mwApi'])
      .action(async ({ session }, keywords) => {
        if (!session?.channel?.mwApi) {
          return session?.execute('wiki.connect -h')
        }
        if (!keywords) {
          session.sendQueued('要搜索什么呢？(输入空行或句号取消)')
          keywords = (await session.prompt(30 * 1000)).trim()
          if (!keywords || keywords === '.' || keywords === '。') return ''
        }
        const api = await useApi(session.channel.mwApi)
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        const { data } = await api.post<{
          query: {
            searchinfo: {
              totalhits: number
            }
            pages: {
              pageid: number
              ns: number
              title: string
              index: number
              extract: string
            }[]
            search: {
              ns: number
              title: string
              pageid: number
            }[]
          }
        }>({
          action: 'query',
          prop: 'extracts',
          list: 'search',
          generator: 'search',
          exchars: '120',
          exintro: 1,
          explaintext: 1,
          exsectionformat: 'plain',
          srsearch: `"${keywords}"`,
          srnamespace: '0',
          srlimit: '5',
          srinfo: 'totalhits',
          srprop: '',
          gsrsearch: `"${keywords}"`,
          gsrnamespace: '0',
          gsrlimit: '5',
        })

        this.logger.debug('Search DATA', data)
        const { searchinfo, search, pages } = data.query

        const bulk = new BulkMessageBuilder(session)

        if (search.length < 1) {
          return `💔找不到与“${keywords}”匹配的结果。`
        } else if (search.length === 1) {
          return session.execute(`wiki -d ${search[0].title}`)
        } else {
          bulk.prependOriginal()
          bulk.botSay(
            `🔍关键词“${keywords}”共匹配到 ${
              searchinfo?.totalhits ?? '∅'
            } 个相关结果，我来简单整理一下前 ${search.length} 个结果：`
          )
        }
        pages
          .sort((a, b) => a.index - b.index)
          .forEach((item, index: number) => {
            bulk.botSay(
              `(${index + 1}) ${item.title}
${item.extract || '(无摘要)'}
${getUrl(session.channel!.mwApi!, { curid: item.pageid })}`
            )
          })

        return bulk.all()
      })
  }

  async shotInfobox(url: string) {
    const matched = this.INFOBOX_DEFINITION.find((i) => i.match(new URL(url)))
    if (!matched) return ''
    this.logger.info('SHOT_INFOBOX', url, matched.selector)
    const start = Date.now()
    const timeSpend = () => ((Date.now() - start) / 1000).toFixed(3) + 's'

    // 使用 render 模式或者 fallback 皮肤有效剔除不必要的内容，加快页面加载速度
    const renderUrl = new URL(url)
    // renderUrl.searchParams.set('action', 'render')
    renderUrl.searchParams.set('useskin', 'apioutput')

    let pageLoaded = false
    const page = await this.ctx.puppeteer.page()
    await page.setViewport({ width: 960, height: 720 })

    try {
      // 开始竞速，load 事件触发后最多再等 5s
      await Promise.race([
        page.goto(renderUrl.toString(), {
          timeout: 10 * 1000,
          waitUntil: 'networkidle0',
        }),
        new Promise((resolve) => {
          page.on('load', () => {
            console.info('[TIMER]', 'page loaded', timeSpend())
            pageLoaded = true
            setTimeout(() => resolve(1), 5 * 1000)
          })
        }),
      ])
    } catch (e) {
      console.info('[TIMER]', 'Navigation timeout', timeSpend())
      this.logger.warn(
        'SHOT_INFOBOX',
        'Navigation timeout:',
        `(page HAS ${pageLoaded ? '' : 'NOT'} loaded)`,
        e
      )

      await page
        .$('.mw-parser-output')
        .then((i) => {
          this.logger.info(
            'SHOT_INFOBOX',
            '`.mw-parser-output` exist, render it anyway'
          )
          pageLoaded = true
          return i
        })
        .catch((e) => {})

      if (!pageLoaded) {
        await page.close()
        return ''
      }
    }

    try {
      await page.addStyleTag({
        content: this.createInjectStylesFromDefinition(matched),
      })
    } catch (e) {
      this.logger.warn('SHOT_INFOBOX', 'Inject styles error', e)
    }

    try {
      const target = await page.$(
        Array.isArray(matched.selector)
          ? matched.selector.join(',')
          : matched.selector
      )
      if (!target) {
        this.logger.warn('SHOT_INFOBOX', 'Canceled', 'Missing target')
        await page.close()
        return ''
      }
      const img = await target.screenshot({ type: 'jpeg', quality: 85 })
      console.info('[TIMER]', 'OK', timeSpend())
      this.logger.info('SHOT_INFOBOX', 'OK', img)
      await page.close()
      return h.image(img, 'image/jpeg')
    } catch (e) {
      this.logger.warn('SHOT_INFOBOX', 'Failed', e)
      await page?.close()
      return ''
    }
  }

  createInjectStylesFromDefinition({
    selector,
    injectStyles,
  }: InfoboxDefinition): string {
    return `
      /* 隐藏妨碍截图的元素 */
      ${Array.isArray(selector) ? selector.join(', ') : selector} {
        visibility: visible;
        :not(&, & *) {
          visibility: hidden;
        }
      }
  
      /* 配置定义 */
      ${injectStyles}
    `
  }
}
