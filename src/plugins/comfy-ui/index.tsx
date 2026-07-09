import { Context, h, randomId } from '@koishijs/core'
import type { Awaitable, Computed, Session } from '@koishijs/core'

import BasePlugin from '~/_boilerplate'

import type { HTTP } from '@cordisjs/plugin-http'

import { basicAuth } from './auth'
import { ComfyError, ComfyUIClient } from './client'
import { validateLorasArg } from './lora-validate'
import { applyBuiltinFilter } from './filter'
import type { ResolvedFilter } from './filter'
import {
  ASPECT_RATIO_MAP,
  applyOverrides,
  scanGuides,
  scanWorkflowTemplates,
} from './template-loader'
import type { Guide, OverrideArgs, TemplateBindings } from './template-loader'

/** `comfyui/before-generate` 事件 payload —— 监听器可就地改 args，或返回字符串拒绝本次生成。 */
export interface ComfyuiBeforeGenerate {
  session: Session
  template: TemplateBindings
  args: OverrideArgs
}

declare module 'koishi' {
  interface Events {
    'comfyui/before-generate'(
      payload: ComfyuiBeforeGenerate
    ): Awaitable<string | void>
  }
}

export interface Config {
  http?: HTTP.Config
  workflows?: TemplateBindings[]
  guides?: Guide[]
  defaultGenerateTimeoutS?: number
  /**
   * 只在这些频道启用 comfyui 的功能命令（templates/guide/generate）。channel ID
   * 列表：群聊是群号，私聊是 `private:<用户号>`。空或未配 = 不限。临时措施。
   *
   * 用 action 内 channelId 检查实现，而非 ctx selector filter —— koishi 4.18 的
   * ctx.guild/channel().plugin() 对命令不生效（命令注册到全局 commander，且 agent
   * 的 session.execute 不走 selector filter，实测验证过）。
   */
  allowedChannels?: string[]
  /**
   * comfyui.generate 的访问控制——防止 agent 替群友反复画图刷爆显卡。限制施加
   * 在 koishi 命令层；agent 经 execute_koishi_command 调用时按调用者（群友）身份
   * 检查 authority 与频率（已实测 agent 调用沿用用户权限等级）。
   */
  generate?: {
    /** 调用所需 authority 等级。默认 1（所有注册用户）。 */
    authority?: number
    /** 两次调用最小间隔（ms）。默认 0（不限）；耗显卡建议设几十秒。 */
    minInterval?: number
    /** 每用户每日调用次数上限。默认 0（不限）。 */
    maxUsage?: number
  }
  /**
   * 提示词限制/改写（内置便利层，底层是 comfyui/before-generate 事件的内置监听器）。
   * Computed 支持按群/按人生效，例：
   *   blacklist: (s) => nsfwChannels.includes(s.channelId) ? ['nsfw','nude'] : []
   * 复杂逻辑（正则、外部审核 API）直接 ctx.on('comfyui/before-generate', ...) 自己写。
   */
  filter?: {
    /** prompt 命中任一词 → 拒绝生成。 */
    blacklist?: Computed<string[]>
    /** 强制 append 进 prompt。 */
    forcePositive?: Computed<string>
    /** 强制 append 进 negative（在模板 seed_negative 基础上追加）。 */
    forceNegative?: Computed<string>
  }
}

const ASPECT_RATIO_KEYS = Object.keys(ASPECT_RATIO_MAP)

const COMFYUI_DENY_MSG =
  'This channel is not authorized to use ComfyUI image generation. Inform the user that drawing is disabled here; do not retry or attempt to bypass it.'

export default class PluginComfyUI extends BasePlugin<Config> {
  static inject = { http: { required: true } }

  /** Re-exported directory scanners — used by the caller (src/index.ts) to build config. */
  static scanWorkflowTemplates = scanWorkflowTemplates
  static scanGuides = scanGuides
  static basicAuth = basicAuth

  private readonly templates: Map<string, TemplateBindings>
  private readonly guides: Map<string, Guide>
  private readonly client: ComfyUIClient | null
  private readonly defaultTimeoutS: number

  constructor(ctx: Context, config: Config) {
    super(ctx, config, 'comfyui')

    this.templates = new Map((config.workflows ?? []).map((t) => [t.name, t]))
    this.guides = new Map((config.guides ?? []).map((g) => [g.name, g]))
    this.defaultTimeoutS = Math.min(config.defaultGenerateTimeoutS ?? 600, 600)

    // Only wire a real client when a backend baseURL is configured. Without one,
    // commands still register (catalog stays consistent) but generate returns a
    // "backend not configured" notice instead of attempting any network call.
    if (config.http?.baseURL) {
      const http = ctx.http.extend({
        ...config.http,
        headers: { 'User-Agent': 'sili-comfyui/0.1', ...config.http?.headers },
      })
      this.client = new ComfyUIClient(http)
    } else {
      this.client = null
    }

    this.logger.info(
      'comfyui: %d templates, %d guides%s',
      this.templates.size,
      this.guides.size,
      this.client ? '' : ' (no backend configured)'
    )

    this.#registerCommands()
    this.#registerBuiltinFilter()
  }

  #registerCommands() {
    const ctx = this.ctx

    ctx
      .command('comfyui', 'ComfyUI 绘图工具箱', {
        descriptionForAgents:
          'Use this command when the user wants to generate, draw, or paint an image (such as anime, realistic, concept art, or avatars) using AI. ' +
          'This is a multi-step pipeline. Always check available templates via `comfyui.templates` before executing a generation request.',
      })
      .action(({ session }) =>
        session?.execute({ name: 'comfyui', options: { help: true } })
      )

    ctx
      .command('comfyui.templates', '列出可用工作流', {
        descriptionForAgents:
          'Use this command when you need to discover available models, styles, default resolutions, or supported LoRAs. ' +
          'You MUST call this command at least once before calling `comfyui.generate` so you know which templates exist and what parameters they support.',
        helpForAgents:
          'Returns a JSON list of templates. When preparing to generate:\n' +
          '1. Scan the keys of "templates" to find a style that matches the user\'s request.\n' +
          '2. Check "available_loras" to see if the user\'s requested LoRA is supported.\n' +
          '3. Check "guides_available" to see if there is an expert prompt guide for this model.',
      })
      .action(({ session }) =>
        this.#channelAllowed(session) ? this.#handleTemplates() : COMFYUI_DENY_MSG
      )

    ctx
      .command('comfyui.guide <series:string>', '模型家族提示词指南', {
        descriptionForAgents:
          'Use this command when you have selected a template and want to optimize your prompt to get the highest possible quality. ' +
          'For example, if you chose a template belonging to the "anima" series, call `comfyui.guide anima` to learn how to structure its positive/negative keywords.',
      })
      .usage('comfyui.guide anima → 获取 Anima 系列模型的提示词写法指南')
      .action(({ session }, series) =>
        this.#channelAllowed(session) ? this.#handleGuide(series) : COMFYUI_DENY_MSG
      )

    ctx
      .command('comfyui.generate <template:string> <prompt:text>', '开始生图', {
        // 访问控制：防止 agent 替群友反复画图刷爆显卡（按调用者身份检查）。
        authority: this.config.generate?.authority ?? 1,
        minInterval: this.config.generate?.minInterval ?? 0,
        maxUsage: this.config.generate?.maxUsage ?? 0,
        descriptionForAgents:
          'Use this command to render the actual image when you already have a target <template> and a clear <prompt>. ' +
          'Never guess the template name; always select one from the output of `comfyui.templates`.',
        helpForAgents:
          '### WHEN TO USE ARGUMENTS & OPTIONS:\n' +
          '- Use `prompt`: Always include descriptive tags. Highly recommended to append the template’s `seed_prompt` (from `comfyui.templates`) as a prefix to ensure the style holds.\n' +
          "- Use `--negative` / `-n`: Only use this when the user explicitly requests to exclude certain elements. Otherwise, let it fall back to the template's high-quality `seed_negative`.\n" +
          '- Use `--aspect-ratio` / `-a`: Use this preset (e.g., portrait, landscape, square) when the user specifies a general shape but not exact pixels.\n' +
          '- Use `--width` / `-w` and `height` (the final positional argument): Use these ONLY as a paired set. Both must be multiples of 8 within [64, 4096]. If you specify width, you MUST specify height. Note: `height` has no short option `-h` because `-h` is reserved for help.\n' +
          '- Use `--loras` / `-l`: Use this when the user requests a specific style/character and the template\'s `lora_locked` is false. Pass a JSON string: `[{"name":"lora_name","strengthModel":0.8}]`. The "name" must match one of the "available_loras" from the template.\n' +
          '- Use `--seed`: Only use this if the user wants to reproduce a specific image or perform minor prompt tweaks on a previous seed. Otherwise, omit it to randomize.\n\n' +
          '### CRITICAL POLICIES:\n' +
          '1. If the command fails with a frequency limit, authority block, or cooldown error (e.g., "Too frequent", "Unauthorized"), DO NOT retry, DO NOT modify arguments to bypass it, and DO NOT hallucinate a successful image. Immediately report the exact constraint to the user.',
      })
      .option('negative', '-n <negative:string> 负向提示词，缺省用模板默认')
      .option(
        'aspect-ratio',
        '-a <aspect_ratio:string> 尺寸预设（portrait/landscape/square/large_*/small_*），被 width/height 覆盖'
      )
      .option(
        'width',
        '-w <width:posint> 自定义宽（8 的倍数，须与 height 成对，优先于 aspect_ratio）'
      )
      .option(
        'height',
        '<height:posint> 自定义高（8 的倍数，须与 width 成对；不可使用 -h，与内置 --help 冲突）'
      )
      .option('steps', '-s <steps:posint> 采样步数，缺省用模板默认')
      .option('cfg', '-c <cfg:number> CFG，缺省用模板默认')
      .option('seed', '--seed <seed:integer> 随机种子，缺省随机')
      .option(
        'loras',
        '-l <loras:string> LoRA（JSON 字符串：[{name, strengthModel?, strengthClip?}]）'
      )
      .option(
        'timeout',
        '-t <timeout:posint> 整轮生成轮询超时（秒，默认 600，上限 600）'
      )
      .action((argv, template, prompt) =>
        this.#handleGenerate(argv, template, prompt)
      )
  }

  #guideNames(): string[] {
    return [...this.guides.keys()].sort()
  }

  #buildTemplateInfo(t: TemplateBindings): Record<string, any> {
    const width = t.defaults.width
    const height = t.defaults.height
    const defaultSize = width && height ? `${width}x${height}` : '(unspecified)'
    const publicDefaults: Record<string, any> = {}
    for (const k of ['steps', 'cfg', 'sampler_name', 'scheduler']) {
      if (k in t.defaults) publicDefaults[k] = t.defaults[k]
    }
    return {
      model: t.modelSummary,
      default_size: defaultSize,
      aspect_ratios: ASPECT_RATIO_KEYS,
      defaults: publicDefaults,
      seed_prompt: t.seedPrompt,
      seed_negative: t.seedNegative,
      available_loras: t.availableLoras.map((al) => ({
        name: al.name,
        default_strength_model: al.strengthModel,
        default_strength_clip: al.strengthClip,
      })),
      lora_locked: t.loraLocked,
    }
  }

  #handleTemplates(): string {
    if (this.templates.size === 0) {
      return 'no templates loaded; configure `workflows` for this plugin'
    }
    const templates: Record<string, any> = {}
    for (const [name, t] of this.templates) {
      templates[name] = this.#buildTemplateInfo(t)
    }
    return JSON.stringify(
      { templates, guides_available: this.#guideNames() },
      null,
      2
    )
  }

  #handleGuide(series: unknown): string {
    if (typeof series !== 'string' || !series) {
      return 'missing required arg: series'
    }
    const safe = series.trim().toLowerCase()
    if (safe.includes('/') || safe.includes('\\') || safe.endsWith('.md')) {
      return `invalid series name ${JSON.stringify(series)}; use a plain stem like "anima"`
    }
    const guide = this.guides.get(safe)
    if (!guide) {
      return `no guide for series ${JSON.stringify(safe)}; available: ${JSON.stringify(this.#guideNames())}`
    }
    return guide.content
  }

  /** 内置 filter 监听器：解析 Computed 配置（按 session）后应用 applyBuiltinFilter。 */
  #registerBuiltinFilter(): void {
    this.ctx.on('comfyui/before-generate', ({ session, template, args }) => {
      const f = this.config.filter
      if (!f) return
      const resolved: ResolvedFilter = {
        blacklist: f.blacklist ? session.resolve(f.blacklist) : undefined,
        forcePositive: f.forcePositive
          ? session.resolve(f.forcePositive)
          : undefined,
        forceNegative: f.forceNegative
          ? session.resolve(f.forceNegative)
          : undefined,
      }
      return applyBuiltinFilter(args, template, resolved)
    })
  }

  /**
   * 频道白名单：未配 allowedChannels = 不限；配了则仅白名单频道放行。
   * channelId 群聊是群号、私聊是 `private:<用户号>`，故可精确到群或个人私聊。
   */
  #channelAllowed(session: any): boolean {
    const allow = this.config.allowedChannels
    if (!allow || allow.length === 0) return true
    return !!session?.channelId && allow.includes(session.channelId)
  }

  async #handleGenerate(
    argv: any,
    template: string,
    prompt: string
  ): Promise<string | undefined> {
    const { session, options } = argv
    if (!this.#channelAllowed(session)) return COMFYUI_DENY_MSG
    if (!template) return 'missing required arg: template'
    if (!prompt) return 'missing required arg: prompt'

    const t = this.templates.get(template)
    if (!t) {
      return `unknown template ${JSON.stringify(template)}; available: ${JSON.stringify(
        [...this.templates.keys()].sort()
      )}`
    }

    // Size validation: width/height paired, multiple of 8, within [64, 4096].
    const width = options.width ?? null
    const height = options.height ?? null
    if ((width === null) !== (height === null)) {
      return 'width and height must be provided together'
    }
    if (width !== null && height !== null) {
      if (width < 64 || width > 4096 || height < 64 || height > 4096) {
        return `width/height out of range [64, 4096]: width=${width}, height=${height}`
      }
      if (width % 8 || height % 8) {
        return `width/height must be multiples of 8: width=${width}, height=${height}`
      }
    }

    // LoRA validation (accepts a JSON string or an already-parsed object/array).
    let rawLoras: unknown = options.loras ?? null
    if (typeof rawLoras === 'string') {
      const text = rawLoras.trim()
      if (!text) {
        rawLoras = null
      } else {
        try {
          rawLoras = JSON.parse(text)
        } catch (e) {
          return `loras is not valid JSON: ${e}`
        }
      }
    }
    const { loras, error: loraErr } = validateLorasArg(rawLoras, t)
    if (loraErr !== null) return loraErr

    // Seed: randomise when not given.
    const seed =
      options.seed === undefined || options.seed === null
        ? Math.floor(Math.random() * Number.MAX_SAFE_INTEGER)
        : options.seed

    let timeoutS = options.timeout ?? this.defaultTimeoutS
    timeoutS = Math.max(1, Math.min(timeoutS, 600))

    const overrideArgs: OverrideArgs = {
      prompt,
      negative: options.negative ?? null,
      aspectRatio: options['aspect-ratio'] ?? null,
      width,
      height,
      steps: options.steps ?? null,
      cfg: options.cfg ?? null,
      seed,
      loras,
    }

    // 扩展点：监听器（含内置 filter）可就地改写 overrideArgs，或返回字符串拒绝本次生成。
    let rejection: string | void
    try {
      rejection = await this.ctx.serial('comfyui/before-generate', {
        session,
        template: t,
        args: overrideArgs,
      })
    } catch (e) {
      return `生成前置检查出错，已取消：${(e as Error)?.message ?? e}`
    }
    if (rejection) return rejection

    const apiWf = applyOverrides(t, overrideArgs)

    if (!this.client) {
      return '未配置 ComfyUI 后端，无法生成图片（缺少 http.baseURL 配置）。'
    }

    const clientId = 'sili-' + randomId().slice(0, 8)
    const started = Date.now()
    try {
      const promptId = await this.client.submit(apiWf, clientId)
      const entry = await this.client.pollUntilDone(promptId, timeoutS)
      const outputs = (entry.outputs ?? {}) as Record<string, any>
      let imgMeta: any = null
      for (const nodeOut of Object.values(outputs)) {
        const imgs =
          nodeOut && typeof nodeOut === 'object'
            ? (nodeOut as any).images
            : null
        if (Array.isArray(imgs) && imgs.length > 0) {
          imgMeta = imgs[0]
          break
        }
      }
      if (!imgMeta) {
        return 'workflow completed but produced no images'
      }
      const buf = await this.client.fetchImage({
        filename: imgMeta.filename,
        subfolder: imgMeta.subfolder ?? '',
        type: imgMeta.type ?? 'output',
      })
      const dataUri = `data:image/png;base64,${Buffer.from(buf).toString('base64')}`
      await session.send(h.image(dataUri))
      const durationS = ((Date.now() - started) / 1000).toFixed(1)
      // 图随 session.send 走（被 execute-koishi-command 收成 img ref）；这行元信息
      // 作为命令返回值，让 agent / 直接调用者拿到 seed（复现用）、耗时、模板等。
      return `生成成功 · 模板: ${template} · seed: ${seed} · 耗时: ${durationS}s · prompt_id: ${promptId}`
    } catch (e) {
      if (e instanceof ComfyError) {
        return `image generation failed (${e.type}): ${e.message}`
      }
      this.logger.warn('comfyui.generate unexpected error: %o', e)
      return `image generation failed: ${(e as Error)?.message ?? e}`
    }
  }
}
