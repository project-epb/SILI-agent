/**
 * @name PluginYoudao
 * @command command
 * @desc 有道翻译
 * @authority 1
 */
import { Context } from '@koishijs/core'

import BasePlugin from '~/_boilerplate'

import fexios from 'fexios'

export default class PluginYoudao extends BasePlugin {
  constructor(ctx: Context) {
    super(ctx, {}, 'youdao')

    ctx
      .command('tools/youdao <text:text>', '使用无道词典进行翻译')
      .shortcut('翻译', { fuzzy: true })
      .shortcut(/^(.+)用((.+)[语文])怎么说$/, {
        args: ['$1'],
        options: { from: 'auto', to: '$2' },
        prefix: true,
      })
      .shortcut(/(?:(.+)[语文])?(.+)(?:是什么意思|的意思是什么)$/, {
        args: ['$2'],
        options: { from: '$1', to: 'zh-CHS' },
        prefix: true,
      })
      .option('from', '-f <lang> 源内容的语言')
      .option('to', '-t <lang> 翻译后的语言')
      .option('list', '-l 显示所有支持的语言')
      .check(({ options }) => {
        if (options?.list) {
          return `当前支持以下语言互译：${Array.from(
            new Set(Object.values(this.LANGUAGES))
          )
            .sort()
            .join(', ')}`
        }
      })
      .action(async ({ session, options, name }, text) => {
        if (!session) return
        if (!text) {
          return session.execute({ name, options: { help: true } })
        }
        this.logger.info('发起翻译', { options, text })

        const from = this.getLangCode(options?.from)
        const to = this.getLangCode(options?.to)
        if (!from || !to) {
          let not: string[] = []
          if (!from) not.push(options?.from)
          if (!to) not.push(options?.to)
          session.send(`注意：不支持的语言${not.join('和')}将被替换为“自动”。`)
        }

        try {
          const data = await this.makeQuery(text, from, to)

          if (data.errorCode !== '0' && data.errorCode !== 0) {
            this.logger.error('翻译出错', data)
            return `翻译失败: ${this.getErrorDesc(data.errorCode)}`
          }

          this.logger.info('翻译完成')
          let { query, translation, isWord } = data
          let phonetic = ''
          if (isWord) {
            if (data?.basic?.phonetic)
              phonetic = `[${data.basic.phonetic}]` || ''
            if (data?.basic?.explains) {
              translation += `\n释义: ${data.basic.explains.join('\n')}`
            }
          }

          return `原文: ${query} ${phonetic}\n翻译: ${translation}`
        } catch (err) {
          this.logger.error('请求出错', err)
          return '翻译失败: 网络异常。'
        }
      })
  }

  getLangCode(str: string) {
    if (!str) return 'auto'
    str = str.replace(/[语文]$/, '')
    if (this.LANGUAGES[str]) return this.LANGUAGES[str]
    if (Object.values(this.LANGUAGES).includes(str)) return str
    return null
  }

  async makeQuery(q: string, from: string, to: string) {
    if (!from) from = 'auto'
    if (!to) to = 'auto'
    const { data } = await fexios.post(
      process.env.API_YOUDAO,
      new URLSearchParams({ q, from, to })
    )
    return data
  }

  getErrorDesc(code: number) {
    return this.ERROR_CODES[code] || '未知错误'
  }

  // Constants
  readonly LANGUAGES = {
    中: 'zh-CHS',
    zh: 'zh-CHS',
    英: 'en',
    日: 'ja',
    jp: 'ja',
    韩: 'ko',
    法: 'fr',
    西班牙: 'es',
    葡萄牙: 'pt',
    意大利: 'it',
    俄: 'ru',
    越南: 'vi',
    德: 'de',
    阿拉伯: 'ar',
    印尼: 'id',
    南非荷兰: 'af',
    波斯尼亚: 'bs',
    保加利亚: 'bg',
    粤: 'yue',
    加泰隆: 'ca',
    克罗地亚: 'hr',
    捷克: 'cs',
    丹麦: 'da',
    荷兰: 'nl',
    爱沙尼亚: 'et',
    斐济: 'fj',
    芬兰: 'fi',
    希腊: 'el',
    海地克里奥尔: 'ht',
    希伯来: 'he',
    印地: 'hi',
    白苗: 'mww',
    匈牙利: 'hu',
    斯瓦希里: 'sw',
    克林贡: 'tlh',
    拉脱维亚: 'lv',
    立陶宛: 'lt',
    马来: 'ms',
    马耳他: 'mt',
    挪威: 'no',
    波斯: 'fa',
    波兰: 'pl',
    克雷塔罗奥托米: 'otq',
    罗马尼亚: 'ro',
    西里尔塞尔维亚: 'sr-Cyrl',
    拉丁塞尔维亚: 'sr-Latn',
    斯洛伐克: 'sk',
    斯洛文尼亚: 'sl',
    瑞典: 'sv',
    塔希提: 'ty',
    泰: 'th',
    汤加: 'to',
    土耳其: 'tr',
    乌克兰: 'uk',
    乌尔都: 'ur',
    威尔士: 'cy',
    尤卡坦玛雅: 'yua',
    阿尔巴尼亚: 'sq',
    阿姆哈拉: 'am',
    亚美尼亚: 'hy',
    阿塞拜疆: 'az',
    孟加拉: 'bn',
    巴斯克: 'eu',
    白俄罗斯: 'be',
    宿务: 'ceb',
    科西嘉: 'co',
    世界: 'eo',
    菲律宾: 'tl',
    弗里西: 'fy',
    加利西亚: 'gl',
    格鲁吉亚: 'ka',
    古吉拉特: 'gu',
    豪萨: 'ha',
    夏威夷: 'haw',
    冰岛: 'is',
    伊博: 'ig',
    爱尔兰: 'ga',
    爪哇: 'jw',
    卡纳达: 'kn',
    哈萨克: 'kk',
    高棉: 'km',
    库尔德: 'ku',
    柯尔克孜: 'ky',
    老挝: 'lo',
    拉丁: 'la',
    卢森堡: 'lb',
    马其顿: 'mk',
    马尔加什: 'mg',
    马拉雅拉姆: 'ml',
    毛利: 'mi',
    马拉地: 'mr',
    蒙古: 'mn',
    缅甸: 'my',
    尼泊尔: 'ne',
    齐切瓦: 'ny',
    普什图: 'ps',
    旁遮普: 'pa',
    萨摩亚: 'sm',
    苏格兰盖尔: 'gd',
    塞索托: 'st',
    修纳: 'sn',
    信德: 'sd',
    僧伽罗: 'si',
    索马里: 'so',
    巽他: 'su',
    塔吉克: 'tg',
    泰米尔: 'ta',
    泰卢固: 'te',
    乌兹别克: 'uz',
    南非科萨: 'xh',
    意第绪: 'yi',
    约鲁巴: 'yo',
    南非祖鲁: 'zu',
    自动: 'auto',
  }
  readonly ERROR_CODES = {
    101: '缺少必填的参数,首先确保必填参数齐全，然后确认参数书写是否正确。',
    102: '不支持的语言类型',
    103: '翻译文本过长',
    104: '不支持的API类型',
    105: '不支持的签名类型',
    106: '不支持的响应类型',
    107: '不支持的传输加密类型',
    108: '应用ID无效，注册账号，登录后台创建应用和实例并完成绑定，可获得应用ID和应用密钥等信息',
    109: 'batchLog格式不正确',
    110: '无相关服务的有效实例,应用没有绑定服务实例，可以新建服务实例，绑定服务实例。注：某些服务的翻译结果发音需要tts实例，需要在控制台创建语音合成实例绑定应用后方能使用。',
    111: '开发者账号无效',
    112: '请求服务无效',
    113: 'q不能为空',
    114: '不支持的图片传输方式',
    116: 'strict字段取值无效，请参考文档填写正确参数值',
    201: '解密失败，可能为DES,BASE64,URLDecode的错误',
    202: '签名检验失败,如果确认应用ID和应用密钥的正确性，仍返回202，一般是编码问题。请确保翻译文本 q 为UTF-8编码.',
    203: '访问IP地址不在可访问IP列表',
    205: '请求的接口与应用的平台类型不一致，确保接入方式（Android SDK、IOS SDK、API）与创建的应用平台类型一致。如有疑问请参考入门指南',
    206: '因为时间戳无效导致签名校验失败',
    207: '重放请求',
    301: '辞典查询失败',
    302: '翻译查询失败',
    303: '服务端的其它异常',
    304: '会话闲置太久超时',
    401: '账户已经欠费，请进行账户充值',
    402: 'offlinesdk不可用',
    411: '访问频率受限,请稍后访问',
    412: '长请求过于频繁，请稍后访问',
    1001: '无效的OCR类型',
    1002: '不支持的OCR image类型',
    1003: '不支持的OCR Language类型',
    1004: '识别图片过大',
    1201: '图片base64解密失败',
    1301: 'OCR段落识别失败',
    1411: '访问频率受限',
    1412: '超过最大识别字节数',
    2003: '不支持的语言识别Language类型',
    2004: '合成字符过长',
    2005: '不支持的音频文件类型',
    2006: '不支持的发音类型',
    2201: '解密失败',
    2301: '服务的异常',
    2411: '访问频率受限,请稍后访问',
    2412: '超过最大请求字符数',
    3001: '不支持的语音格式',
    3002: '不支持的语音采样率',
    3003: '不支持的语音声道',
    3004: '不支持的语音上传类型',
    3005: '不支持的语言类型',
    3006: '不支持的识别类型',
    3007: '识别音频文件过大',
    3008: '识别音频时长过长',
    3009: '不支持的音频文件类型',
    3010: '不支持的发音类型',
    3201: '解密失败',
    3301: '语音识别失败',
    3302: '语音翻译失败',
    3303: '服务的异常',
    3411: '访问频率受限,请稍后访问',
    3412: '超过最大请求字符数',
    4001: '不支持的语音识别格式',
    4002: '不支持的语音识别采样率',
    4003: '不支持的语音识别声道',
    4004: '不支持的语音上传类型',
    4005: '不支持的语言类型',
    4006: '识别音频文件过大',
    4007: '识别音频时长过长',
    4201: '解密失败',
    4301: '语音识别失败',
    4303: '服务的异常',
    4411: '访问频率受限,请稍后访问',
    4412: '超过最大请求时长',
    5001: '无效的OCR类型',
    5002: '不支持的OCR image类型',
    5003: '不支持的语言类型',
    5004: '识别图片过大',
    5005: '不支持的图片类型',
    5006: '文件为空',
    5201: '解密错误，图片base64解密失败',
    5301: 'OCR段落识别失败',
    5411: '访问频率受限',
    5412: '超过最大识别流量',
    9001: '不支持的语音格式',
    9002: '不支持的语音采样率',
    9003: '不支持的语音声道',
    9004: '不支持的语音上传类型',
    9005: '不支持的语音识别 Language类型',
    9301: 'ASR识别失败',
    9303: '服务器内部错误',
    9411: '访问频率受限（超过最大调用次数）',
    9412: '超过最大处理语音长度',
    10001: '无效的OCR类型',
    10002: '不支持的OCR image类型',
    10004: '识别图片过大',
    10201: '图片base64解密失败',
    10301: 'OCR段落识别失败',
    10411: '访问频率受限',
    10412: '超过最大识别流量',
    11001: '不支持的语音识别格式',
    11002: '不支持的语音识别采样率',
    11003: '不支持的语音识别声道',
    11004: '不支持的语音上传类型',
    11005: '不支持的语言类型',
    11006: '识别音频文件过大',
    11007: '识别音频时长过长，最大支持30s',
    11201: '解密失败',
    11301: '语音识别失败',
    11303: '服务的异常',
    11411: '访问频率受限,请稍后访问',
    11412: '超过最大请求时长',
    12001: '图片尺寸过大',
    12002: '图片base64解密失败',
    12003: '引擎服务器返回错误',
    12004: '图片为空',
    12005: '不支持的识别图片类型',
    12006: '图片无匹配结果',
    13001: '不支持的角度类型',
    13002: '不支持的文件类型',
    13003: '表格识别图片过大',
    13004: '文件为空',
    13301: '表格识别失败',
    15001: '需要图片',
    15002: '图片过大（1M）',
    15003: '服务调用失败',
    17001: '需要图片',
    17002: '图片过大（1M）',
    17003: '识别类型未找到',
    17004: '不支持的识别类型',
    17005: '服务调用失败',
  }
}
