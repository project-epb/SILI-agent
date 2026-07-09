import { Context, Session } from '@koishijs/core'

import { BulkMessageBuilder } from '@/utils/BulkMessageBuilder'

import { Fexios } from 'fexios'

import BasePlugin from './_boilerplate'

export default class PluginCanIUse extends BasePlugin {
  ajax = new Fexios({
    baseURL: 'https://caniuse.com/',
  })

  constructor(ctx: Context) {
    super(ctx, {}, 'caniuse')

    ctx.inject(['html'], (ctx) => (this.ctx = ctx))

    ctx
      .command('tools/caniuse <keywords...>', '查询 CSS/JS 特性的兼容性', {
        minInterval: 10 * 1000,
        bypassAuthority: 2,
      })
      .option('text-only', '-t 仅文本模式', { hidden: true })
      .check(({ command }, keywords) => {
        if (!keywords?.trim()) {
          return <execute>help {command.name}</execute>
        }
      })
      .action(async ({ session, options }, keywords) => {
        if (!options['text-only'] || ctx.get('html')) {
          return this.handleScreenShot(session, keywords)
        } else {
          return this.handleTextOnly(session, keywords)
        }
      })
  }

  async handleScreenShot(session: Session, keywords: string) {
    const url = new URL('https://caniuse.com/')
    url.searchParams.set('search', keywords)
    try {
      const buf = await this.ctx.html.shotByUrl(
        url,
        '.ciu-page-content, ciu-feature-list'
      )
      return (
        <>
          <quote id={session.messageId} />
          <img src={`data:image/jpeg;base64,${buf.toString('base64')}`} />
          前往查看：{url}
        </>
      )
    } catch (e) {
      return (
        <>
          <quote id={session.messageId} />
          <p>查询失败：{e.message}</p>
          <p>{url}</p>
        </>
      )
    }
  }

  static BROWSER_NAMES = {
    chrome: 'Chrome',
    and_chr: 'Chrome for Android',
    edge: 'Edge',
    firefox: 'Firefox',
    and_ff: 'Firefox for Android',
    ie: 'Internet Explorer',
    opera: 'Opera',
    op_mob: 'Opera Mobile',
    safari: 'Safari',
    ios_saf: 'iOS Safari',
    samsung: 'Samsung Internet',
    android: 'Android WebView',
  }
  async handleTextOnly(session: Session, keywords: string) {
    const featureIds = await this.queryFeatures(keywords)
    if (!featureIds.length) {
      return '未找到相关特性。'
    }
    const data = await this.getFeatureData(featureIds.slice(0, 3))
    const builder = new BulkMessageBuilder(session)
    builder.botSay(
      `共找到 ${featureIds.length} 个相关特性${data.length > featureIds.length ? `，仅展示前 ${data.length} 个。` : '。'}：`
    )
    const formatSupport = (support: CUISupport) => {
      return Object.entries(support)
        .map(([key, value]) => {
          const browserName =
            PluginCanIUse.BROWSER_NAMES[key as CUISupportKey] || key
          if (!value.version_added) {
            return `${browserName}: 不支持`
          } else if (typeof value.version_added === 'string') {
            return `${browserName}: ${value.version_added}`
          }
          return ''
        })
        .filter(Boolean)
        .join(' / ')
    }
    const formatMDNStatus = (status: CUIMDNStatus) => {
      const statusList = []
      if (status.deprecated) {
        statusList.push('已弃用')
      }
      if (status.experimental) {
        statusList.push('实验性')
      }
      if (status.standard_track) {
        statusList.push('标准化')
      }
      return statusList.join(', ') || '未知'
    }
    data.forEach((item, index) => {
      builder.botSay(
        <>
          <p>
            {index + 1}. {item.title}
          </p>
          <p>支持情况：{formatSupport(item.support)}</p>
          <p>MDN 状态：{formatMDNStatus(item.mdnStatus)}</p>
          <p>
            <a href={item.spec}>规范</a> <a href={item.mdn_url}>MDN 文档</a>
          </p>
        </>
      )
    })
    builder.botSay(
      `查看更多：https://caniuse.com/?query=${encodeURIComponent(keywords)}`
    )
    return builder.all()
  }

  async queryFeatures(keywords: string) {
    const { data } = await this.ajax.get<{ featureIds: string[] }>(
      'process/query.php',
      {
        query: {
          search: keywords,
        },
      }
    )
    return data?.featureIds || []
  }

  async getFeatureData(featureIds: string[]) {
    const { data } = await this.ajax.get<CIUFeatureData[]>(
      '/process/get_feat_data.php',
      {
        query: {
          type: 'support-data',
          feat: featureIds.join(','),
        },
      }
    )
    return data
  }
}

type CUISupportKey =
  | 'chrome'
  | 'and_chr'
  | 'edge'
  | 'firefox'
  | 'and_ff'
  | 'ie'
  | 'opera'
  | 'op_mob'
  | 'safari'
  | 'ios_saf'
  | 'samsung'
  | 'android'
type CUISupport = Record<CUISupportKey, { version_added: string | false }>
interface CUIMDNStatus {
  deprecated: boolean
  experimental: boolean
  standard_track: boolean
}

interface CIUFeatureData {
  title: string
  path: string
  support: CUISupport
  amountOfBrowsersWithData: number
  mdnStatus: CUIMDNStatus
  mdn_url: string
  spec: string
  children: {
    id: string
    title: string
  }[]
}
