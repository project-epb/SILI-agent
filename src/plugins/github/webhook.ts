import type { Context } from 'koishi'
import { isSignatureValid } from './verify'
import { renderers } from './events'
import { buildActions, type ActionMap } from './actions'
import { DedupStore } from './dedup'
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
  /** Record broadcast message ids → quick-reply actions (optional; wired to HistoryStore). */
  recordHistory?(messageIds: string[], actions: ActionMap): void
}

export interface WebhookResult {
  status: number
  targets?: string[]
  message?: import('koishi').Fragment
  actions?: ActionMap
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
  renderOptions: RenderOptions = { bodyMaxLength: 500 }
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
  const targets = deps.targets(repo, event, payload.action)
  const render = renderers[event]
  const message = render ? render(payload, renderOptions) : null
  if (!targets.length || message == null) return { status: 200 }
  return { status: 200, targets, message, actions: buildActions(event, payload) }
}

/** Register the koa webhook route; broadcasts rendered messages to subscribers. */
export function applyWebhook(ctx: Context, config: Config, deps: WebhookDeps): void {
  const prefix = config.messagePrefix ?? ''
  const dedup = new DedupStore(ctx, DEDUP_TTL)
  ctx.server.post((config.path ?? '/github') + '/webhook', async (koa) => {
    const reqBody = koa.request.body as any
    const rawBody = reqBody?.[UNPARSED_BODY] as string | undefined
    const result = await handleWebhook(koa.headers, rawBody, reqBody, deps, {
      bodyMaxLength: config.bodyMaxLength ?? 500,
    })
    // Respond immediately (incl. 200) — never await broadcast, or a slow QQ send would blow
    // GitHub's 10s webhook timeout and trigger retries.
    koa.status = result.status
    if (result.status !== 200 || !result.targets?.length || result.message == null) return
    const deliveryId = String(koa.headers['x-github-delivery'] ?? '')
    if (!dedup.firstSeen(deliveryId)) return // duplicate delivery (GitHub retry): already 200, skip
    const content =
      typeof result.message === 'string' ? prefix + result.message : [prefix, result.message]
    // fire-and-forget: 200 already sent; broadcast + record history run async.
    ctx
      .broadcast(result.targets, content as any)
      .then((messageIds) => {
        if (result.actions && deps.recordHistory) deps.recordHistory(messageIds, result.actions)
      })
      .catch((e) => ctx.logger('github').warn(e))
  })
}
