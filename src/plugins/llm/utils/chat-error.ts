/**
 * What to tell the user when a turn fails, by kind of failure. The OpenAI
 * and Anthropic SDKs name their errors alike (APIConnectionError,
 * RateLimitError, …) and carry an HTTP `status`, so both are read by shape.
 */
export function describeChatError(e: unknown): string {
  const err = e as { name?: string; status?: number; message?: string; cause?: any; code?: string } | undefined
  const name = err?.name ?? ''
  const message = String(err?.message ?? e ?? '')
  const detail = (s: string) => {
    const one = s.replace(/\s+/g, ' ').trim()
    return one.length > 160 ? `${one.slice(0, 160)}…` : one
  }

  if (name === 'DsmlLeakUnrecoverableError')
    return '[错误] SILI 想用工具的时候脑子打结了，吐出来一串乱码（DSML 泄漏），重来几次都没好……换个说法再问问 SILI 吧。'
  if (/^Tool call JSON parse failed/.test(message))
    return '[错误] SILI 填工具参数的时候写错格式了（不是合法 JSON），再问一次试试？'
  if (name === 'APIConnectionTimeoutError' || /timed? ?out/i.test(message))
    return '[错误] SILI 等了好久，模型服务一直没回话（超时），过一会儿再找 SILI 吧。'
  if (
    name === 'APIConnectionError' ||
    /ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|socket hang up|fetch failed|network/i.test(
      `${message} ${err?.code ?? ''} ${err?.cause?.code ?? ''}`
    )
  )
    return '[错误] SILI 和模型服务断线了（网络中断），过一会儿再找 SILI 吧。'

  const status = typeof err?.status === 'number' ? err.status : undefined
  if (status === 401 || status === 403)
    return `[错误] 模型服务不认 SILI 的通行证了（${status}），得请主人检查一下 API key。`
  if (status === 429) return '[错误] SILI 今天说太多话，被模型服务限流了，也可能是额度用完了（429）。过一会儿再试吧。'
  if (status === 413 || (status === 400 && /context|too long|maximum.*tokens|token limit/i.test(message)))
    return `[错误] 这段对话太长，SILI 的脑子装不下了（${status}）。`
  if (status && status >= 500) return `[错误] 模型服务那边自己出故障了，不是 SILI 的错（${status}）。过一会儿再试吧。`
  if (status) return `[错误] 模型服务把 SILI 的请求退回来了（${status}）：${detail(message)}`
  return `[错误] SILI 出了点状况：${detail(`${name && name !== 'Error' ? `${name}: ` : ''}${message}`)}`
}
