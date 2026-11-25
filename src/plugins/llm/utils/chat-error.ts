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

  // In character: SILI never mentions models or services. The parenthesis
  // keeps the keyword or status needed to tell failures apart.
  if (name === 'DsmlLeakUnrecoverableError')
    return '[错误] SILI 刚才脑子打结了，说出来一串乱码，重来几次都没好（DSML 泄漏）……换个说法再问问 SILI 吧。'
  if (/^Tool call JSON parse failed/.test(message))
    return '[错误] SILI 手忙脚乱填错了东西（工具参数不是合法 JSON），再问一次试试？'
  if (name === 'APIConnectionTimeoutError' || /timed? ?out/i.test(message))
    return '[错误] SILI 想了太久，卡住了（超时），过一会儿再来找 SILI 吧。'
  if (
    name === 'APIConnectionError' ||
    /ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|socket hang up|fetch failed|network/i.test(
      `${message} ${err?.code ?? ''} ${err?.cause?.code ?? ''}`
    )
  )
    return '[错误] SILI 的信号断了（网络中断），过一会儿再来找 SILI 吧。'

  const status = typeof err?.status === 'number' ? err.status : undefined
  if (status === 401 || status === 403)
    return `[错误] SILI 被关在门外了（认证失败 ${status}），得请主人来看看。`
  if (status === 429) return '[错误] SILI 今天说太多话，嗓子哑了（限流或额度用完 429），歇一会儿再来吧。'
  if (status === 413 || (status === 400 && /context|too long|maximum.*tokens|token limit/i.test(message)))
    return `[错误] 聊得太多，SILI 记不下了（上下文超长 ${status}）。`
  if (status && status >= 500) return `[错误] SILI 这边出了点故障，不是你的问题（${status}），过一会儿再试吧。`
  if (status) return `[错误] SILI 的请求被退回来了（${status}）：${detail(message)}`
  return `[错误] SILI 出了点状况：${detail(`${name && name !== 'Error' ? `${name}: ` : ''}${message}`)}`
}
