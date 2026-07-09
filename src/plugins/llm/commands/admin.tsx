import { Context, h } from '@koishijs/core'

import BasePlugin from '~/_boilerplate'

/**
 * Subplugin: admin/utility commands.
 *
 * Loaded by PluginLLM via `ctx.plugin(AdminCommands)`. Reads everything it
 * needs from `ctx.llm` (the parent plugin instance), so it carries no
 * state of its own. Disposed automatically when the parent unloads.
 *
 * Hosted commands:
 *   - llm.providers   list configured providers (auth 3)
 *   - llm.models      list models for a provider (auth 3)
 *   - llm.reset       start a new conversation; aborts in-flight reply
 *   - llm.stop        cut SILI off mid-reply (hidden)
 *   - llm.catalog     force-rebuild agent command catalog (hidden, auth 3)
 *   - llm.memory      read/write/reset the user's long-term memory (hidden)
 *   - llm.compact     force-trigger summary compaction on current convo (hidden, auth 3)
 */
export default class AdminCommands extends BasePlugin {
  static inject = ['llm', 'database']

  constructor(ctx: Context) {
    super(ctx, {}, 'llm-admin')
    this.#registerProviders(ctx)
    this.#registerModels(ctx)
    this.#registerReset(ctx)
    this.#registerStop(ctx)
    this.#registerCatalog(ctx)
    this.#registerMemory(ctx)
    this.#registerCompact(ctx)
  }

  #registerProviders(ctx: Context) {
    ctx
      .command('llm.providers', 'List configured providers', { authority: 3 })
      .action(async () => {
        const llm = ctx.llm
        const providers = llm.config.providers
        if (!providers.length) return 'No providers configured.'

        const html = ctx.get('html')
        if (html) {
          const tableHtml = `
<div style="padding: 16px; max-width: 600px;">
  <h3 style="margin: 0 0 12px;">LLM Providers (${providers.length})</h3>
  <table style="width: 100%; border-collapse: collapse; font-size: 13px;">
    <thead>
      <tr style="background: #f0f0f0; text-align: left;">
        <th style="padding: 6px 10px; border: 1px solid #ddd;">Name</th>
        <th style="padding: 6px 10px; border: 1px solid #ddd;">Type</th>
        <th style="padding: 6px 10px; border: 1px solid #ddd;">Model</th>
      </tr>
    </thead>
    <tbody>
      ${providers
        .map(
          (p, i) => `
        <tr style="background: ${i % 2 ? '#fafafa' : '#fff'};">
          <td style="padding: 4px 10px; border: 1px solid #ddd; font-family: monospace;">${p.name}${i === 0 ? ' <span style="color: #888; font-size: 11px;">default</span>' : ''}</td>
          <td style="padding: 4px 10px; border: 1px solid #ddd;">${p.type}</td>
          <td style="padding: 4px 10px; border: 1px solid #ddd; font-family: monospace;">${p.model || '-'}</td>
        </tr>`
        )
        .join('')}
    </tbody>
  </table>
</div>`
          const img = await html.html(tableHtml, 'div')
          if (img) return h.image(img, 'image/jpeg')
        }

        return providers
          .map((p, i) => {
            const def = i === 0 ? ' (default)' : ''
            return `${p.name} [${p.type}]${def}${p.model ? ` model=${p.model}` : ''}`
          })
          .join('\n')
      })
  }

  #registerModels(ctx: Context) {
    ctx
      .command('llm.models <provider:string>', 'List available models', {
        authority: 3,
      })
      .action(async (_, providerName) => {
        const llm = ctx.llm
        const name = providerName || llm.config.providers[0]?.name
        if (!name) return 'No providers configured.'

        const provider = llm.providers.get(name)
        if (!provider) return `Provider "${name}" not found.`

        const models = await provider.listModels()
        if (!models.length) {
          return `Provider "${name}" does not support model listing.`
        }

        const hasPricing = models.some(
          (m) => m.inputPrice != null || m.outputPrice != null
        )
        const hasName = models.some((m) => m.name)
        const hasContext = models.some((m) => m.contextLength)

        const formatPrice = (v?: number) =>
          v != null ? `$${v.toFixed(2)}` : '-'
        const formatContext = (v?: number) => {
          if (v == null) return '-'
          if (v >= 1_000_000)
            return `${(v / 1_000_000).toFixed(v % 1_000_000 === 0 ? 0 : 1)}M`
          if (v >= 1_000)
            return `${(v / 1_000).toFixed(v % 1_000 === 0 ? 0 : 1)}k`
          return String(v)
        }

        const th = (text: string) =>
          `<th style="padding: 6px 10px; border: 1px solid #ddd;">${text}</th>`
        const td = (text: string, mono = false) =>
          `<td style="padding: 4px 10px; border: 1px solid #ddd;${mono ? ' font-family: monospace;' : ''}">${text}</td>`

        const html = ctx.get('html')
        if (html) {
          const tableHtml = `
<div style="padding: 16px; max-width: 900px;">
  <h3 style="margin: 0 0 12px;">Models from ${name} (${models.length})</h3>
  <table style="width: 100%; border-collapse: collapse; font-size: 13px;">
    <thead>
      <tr style="background: #f0f0f0; text-align: left;">
        ${th('ID')}
        ${hasName ? th('Name') : ''}
        ${hasContext ? th('Context') : ''}
        ${hasPricing ? th('Input $/M') + th('Output $/M') : ''}
      </tr>
    </thead>
    <tbody>
      ${models
        .map(
          (m, i) => `
        <tr style="background: ${i % 2 ? '#fafafa' : '#fff'};">
          ${td(m.id, true)}
          ${hasName ? td(m.name || '-') : ''}
          ${hasContext ? td(formatContext(m.contextLength)) : ''}
          ${hasPricing ? td(formatPrice(m.inputPrice)) + td(formatPrice(m.outputPrice)) : ''}
        </tr>`
        )
        .join('')}
    </tbody>
  </table>
</div>`
          const img = await html.html(tableHtml, 'div')
          if (img) return h.image(img, 'image/jpeg')
        }

        return (
          `Models from ${name} (${models.length}):\n` +
          models
            .map((m) => {
              const parts = [m.id]
              if (m.name) parts.push(`(${m.name})`)
              if (m.contextLength)
                parts.push(`[${formatContext(m.contextLength)}]`)
              return parts.join(' ')
            })
            .join('\n')
        )
      })
  }

  #registerReset(ctx: Context) {
    ctx
      .command('llm.reset', '开始新的对话')
      .alias('llm.new', 'llm.clear')
      .userFields(['id', 'openai_last_conversation_id'])
      .shortcut('聊点别的', { prefix: true, fuzzy: false })
      .action(async ({ session }) => {
        // 如果当前还在说话，先掐断；否则即便清了 conversation_id 也会被
        // 后续 sendQueued 继续发出来，UX 错乱。
        ctx.llm.activeChats.abort(session.user.id, 'user-reset')
        if (!session.user.openai_last_conversation_id) {
          return (
            <random>
              <>嗯……我们好像还没聊过什么呀……</>
              <>咦？你还没有和SILI分享过你的故事呢！</>
              <>欸？SILI好像还没和你讨论过什么哦。</>
            </random>
          )
        } else {
          session.user.openai_last_conversation_id = ''
          await session.user.$update()
          return (
            <random>
              <>让我们开始新话题吧！</>
              <>嗯……那我们聊点别的吧！</>
              <>好吧，那我就不提之前的事了。</>
              <>你有更好的点子和SILI分享吗？</>
              <>咦？是还有其他问题吗？</>
            </random>
          )
        }
      })
  }

  #registerStop(ctx: Context) {
    ctx
      .command('llm.stop', 'Stop SILI from talking right now', { hidden: true })
      .userFields(['id'])
      .action(async ({ session }) => {
        const aborted = ctx.llm.activeChats.abort(session.user.id, 'user-stop')
        if (aborted) {
          session?.setReaction?.('🤐').catch(() => {})
        }
        // 没在说话就静默无反应——避免被滥用刷屏
      })
  }

  #registerCatalog(ctx: Context) {
    ctx
      .command('llm.catalog', 'Force-rebuild the agent command catalog', {
        hidden: true,
        authority: 3,
      })
      .action(() => {
        ctx.llm.catalog.refresh('manual')
        const { topLevel, total } = ctx.llm.catalog.stats()
        return `Catalog: ${topLevel} top-level / ${total} total. New text picked up on the next chat turn (system prompt is process-wide cached and re-derives when catalog changes).`
      })
  }

  #registerMemory(ctx: Context) {
    ctx
      .command('llm.memory', 'Manage long-term memory for the current user', {
        hidden: true,
      })
      .option('read', '-r Show the current memory document')
      .option('write', '-w Force a memory update from this session right now')
      .option('reset', '-x Erase the current memory (requires confirmation)')
      .userFields(['id', 'openai_last_conversation_id'])
      .action(async ({ session, options }) => {
        const llm = ctx.llm
        const flags = [options.read, options.write, options.reset].filter(
          Boolean
        ).length
        if (flags === 0) {
          return 'Usage: llm.memory --read | --write | --reset'
        }
        if (flags > 1) {
          return 'Use only one of --read / --write / --reset at a time.'
        }

        const { platform, userId } = llm.resolveMemoryKey(session)

        if (options.read) {
          const meta = await llm.memory.getMeta(platform, userId)
          if (!meta || !meta.content) return '(空)'
          const updatedAt = meta.last_updated_at
            ? new Date(meta.last_updated_at).toLocaleString('sv', {
                timeZone: 'Asia/Shanghai',
              })
            : '从未更新'
          return [
            `更新时间: ${updatedAt} | 字节: ${meta.byte_size} | 累计更新: ${meta.update_count}`,
            '',
            meta.content,
          ].join('\n')
        }

        if (options.write) {
          const conversation_id = session.user.openai_last_conversation_id
          if (!conversation_id) {
            return '当前用户还没有任何对话记录，无法生成记忆。'
          }
          await session.send('正在生成记忆，请稍候……')
          try {
            await llm.memoryFork.maybeTrigger(
              {
                platform,
                userId,
                conversation_id,
                conversation_owner: session.user.id,
              },
              { force: true }
            )
          } catch (e: any) {
            llm.logger.error('[llm.memory --write] failed:', e)
            return `生成失败: ${e?.message || String(e)}`
          }
          const meta = await llm.memory.getMeta(platform, userId)
          return `Done. 当前记忆 ${meta?.byte_size ?? 0} 字节，累计更新 ${meta?.update_count ?? 0} 次。`
        }

        if (options.reset) {
          const meta = await llm.memory.getMeta(platform, userId)
          if (!meta) return '当前用户没有记忆记录，无需清空。'
          await session.send(
            `即将清空当前记忆（${meta.byte_size} 字节）。如果确认，请回复 y。`
          )
          const reply = await session.prompt(30 * 1000)
          if (reply?.trim().toLowerCase() !== 'y') {
            return '已取消。'
          }
          const removed = await llm.memory.delete(platform, userId)
          return removed ? '记忆已清空。' : '记忆已不存在。'
        }
      })
  }

  #registerCompact(ctx: Context) {
    ctx
      .command(
        'llm.compact',
        'Force-trigger summary compaction on the current conversation',
        { hidden: true, authority: 3 }
      )
      .userFields(['id', 'openai_last_conversation_id'])
      .action(async ({ session }) => {
        const llm = ctx.llm
        const conversation_id = session.user.openai_last_conversation_id
        if (!conversation_id) return 'No active conversation to compact.'

        const provider = llm.defaultProvider
        const model =
          llm.config.providers[0]?.model || llm.config.model || 'gpt-4o-mini'
        const { platform, userId } = llm.resolveMemoryKey(session)
        const commandCatalog = llm.catalog.getOrRefresh()
        const systemPromptText = llm.systemPrompt.get(commandCatalog)

        const t0 = Date.now()
        const res = await llm.summary.compactNow({
          conversation_id,
          conversation_owner: session.user.id,
          systemPrompt: systemPromptText,
          provider,
          model,
          platform,
          userId,
        })
        const elapsed = Date.now() - t0

        if (!res.ran) {
          return `Did not compact: ${res.reason} (${elapsed}ms)`
        }

        // Adopt the new id so the next chat turn from this user continues
        // on the compacted session — same handoff the chat command does
        // when threshold-triggered compaction fires.
        session.user.openai_last_conversation_id = res.newConversationId!
        await session.user.$update()
        const active = llm.activeChats.get(session.user.id)
        if (active) active.conversationId = res.newConversationId!

        return [
          `Compacted in ${elapsed}ms.`,
          `Old: ${res.prevConversationId}`,
          `New: ${res.newConversationId}`,
          `Summary length: ${res.summaryLength} chars`,
        ].join('\n')
      })
  }
}
