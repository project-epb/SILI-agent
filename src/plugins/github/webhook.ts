import type { Context } from 'koishi'
import { isSignatureValid } from './verify'
import { escapeMarkup } from './events/util'
import { renderers } from './events'
import { buildActions, buildQuoteBody, type ActionMap } from './actions'
import { DedupStore } from './dedup'
import { isAutomatedSender } from './bot-filter'
import type { Config, RenderOptions } from './types'

const UNPARSED_BODY = Symbol.for('unparsedBody')
const DEDUP_TTL = 10 * 60 * 1000 // 10min covers GitHub's retry window

export interface WebhookDeps {
  /** Look up a webhook's stored repo name + secret by its GitHub hook id. */
  getHook(hookId: number): Promise<{ name: string; secret: string } | undefined>
  /** Resolve subscribed cids for a repo + event (+ action). */
  targets(repo: string, event: string, action?: string): string[]
  /** Migrate subscriptions when the repo was renamed (optional; no-op if absent). */
  onRename?(hookId: number, oldName: string, newName: string, secret: string): Promise<void>
  /** Record broadcast message ids → quick-reply context (optional; wired to HistoryStore). */
  recordHistory?(messageIds: string[], actions: ActionMap, body: string): void
}

export interface WebhookResult {
  status: number
  targets?: string[]
  message?: import('koishi').Fragment
  actions?: ActionMap
  /** The original body to quote (`> ...`) when a user quote-replies this message. */
  quoteBody?: string
  /** Set when the delivery was intentionally dropped; surfaced for the debug log. */
  filtered?: 'bot'
  /** The dropped sender's login, so the debug log can name it. */
  filteredSender?: string
}

/** Sender-based delivery filter. Disabled by default here; `applyWebhook` injects the config. */
export interface BotFilterOptions {
  enabled: boolean
  /** Sender logins to treat as automated even though GitHub reports them as users. */
  extraLogins: string[]
}

function safeParse(source: any): any {
  try {
    return JSON.parse(source)
  } catch {
    return undefined
  }
}

/**
 * Pure webhook core: validate signature over the raw body, resolve targets, render.
 * Status codes mirror the old plugin: 400 bad payload, 202 unknown hook, 403 bad
 * signature, 200 otherwise. No koa/HTTP here so it is directly unit-testable.
 */
export async function handleWebhook(
  headers: Record<string, any>,
  rawBody: string | undefined,
  body: any,
  deps: WebhookDeps,
  renderOptions: RenderOptions = { bodyMaxLength: 500 },
  botFilter: BotFilterOptions = { enabled: false, extraLogins: [] }
): Promise<WebhookResult> {
  const event = String(headers['x-github-event'] ?? '')
  const signature = headers['x-hub-signature-256'] as string | undefined
  const hookId = +headers['x-github-hook-id']
  const payload = safeParse(body?.payload)
  if (!event || !payload?.repository?.full_name) return { status: 400 }

  const hook = await deps.getHook(hookId)
  if (!hook) return { status: 202 } // unknown hook: repos -a probe window

  if (!(await isSignatureValid(hook.secret, rawBody, signature))) return { status: 403 }

  const repo = payload.repository.full_name.toLowerCase()
  // Repo rename: the stored name no longer matches the incoming full_name. Migrate before
  // resolving targets so the (renamed) subscription index is used. Only after a valid signature.
  if (hook.name !== repo && deps.onRename) {
    await deps.onRename(hookId, hook.name, repo, hook.secret)
  }
  // Drop automated senders (renovate/dependabot/actions …). After the rename migration so a
  // bot-triggered delivery still keeps the subscription index in sync, before target resolution
  // so nothing is broadcast or deduped.
  if (botFilter.enabled && isAutomatedSender(payload.sender, botFilter.extraLogins)) {
    return { status: 200, filtered: 'bot', filteredSender: payload.sender?.login }
  }
  const targets = deps.targets(repo, event, payload.action)
  const render = renderers[event]
  const message = render ? render(payload, renderOptions) : null
  if (!targets.length || message == null) return { status: 200 }
  return {
    status: 200,
    targets,
    // Renderers return plain text, but koishi parses a string as h-element source —
    // so an `<img src=…>` inside a GitHub body would become a real image element and
    // a dead URL would fail the entire send. Escape here, once, for every renderer.
    // `quoteBody` below is deliberately NOT escaped: it goes back to GitHub as
    // markdown, where entities would render literally.
    message: typeof message === 'string' ? escapeMarkup(message) : message,
    actions: buildActions(event, payload),
    quoteBody: buildQuoteBody(event, payload, renderOptions),
  }
}

/** Register the koa webhook route; broadcasts rendered messages to subscribers. */
export function applyWebhook(ctx: Context, config: Config, deps: WebhookDeps): void {
  const prefix = config.messagePrefix ?? ''
  const dedup = new DedupStore(ctx, DEDUP_TTL)
  const logger = ctx.logger('github')
  const botFilter: BotFilterOptions = {
    enabled: config.filterBots ?? true,
    extraLogins: config.extraBotLogins ?? [],
  }
  ctx.server.post((config.path ?? '/github') + '/webhook', async (koa) => {
    const reqBody = koa.request.body as any
    const rawBody = reqBody?.[UNPARSED_BODY] as string | undefined
    const result = await handleWebhook(
      koa.headers,
      rawBody,
      reqBody,
      deps,
      { bodyMaxLength: config.bodyMaxLength ?? 500 },
      botFilter
    )
    // Respond immediately (incl. 200) — never await broadcast, or a slow QQ send would blow
    // GitHub's 10s webhook timeout and trigger retries.
    koa.status = result.status
    if (result.filtered === 'bot') {
      // Makes "why didn't this event show up?" answerable without reading the code.
      logger.debug(
        'dropped %s event from bot sender %s',
        koa.headers['x-github-event'],
        result.filteredSender ?? '(unknown)'
      )
    }
    if (result.status !== 200 || !result.targets?.length || result.message == null) return
    const deliveryId = String(koa.headers['x-github-delivery'] ?? '')
    if (!dedup.firstSeen(deliveryId)) return // duplicate delivery (GitHub retry): already 200, skip
    const content =
      typeof result.message === 'string' ? prefix + result.message : [prefix, result.message]
    // fire-and-forget: 200 already sent; broadcast + record history run async.
    ctx
      .broadcast(result.targets, content as any)
      .then((messageIds) => {
        if (result.actions && deps.recordHistory) {
          deps.recordHistory(messageIds, result.actions, result.quoteBody ?? '')
        }
      })
      .catch((e) => ctx.logger('github').warn(e))
  })
}
