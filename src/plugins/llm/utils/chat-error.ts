/**
 * What to tell the user when a turn fails: one in-character sentence (SILI
 * never mentions models or services), then the real cause in parentheses.
 * The OpenAI and Anthropic SDKs name their errors alike
 * (APIConnectionError, RateLimitError, …) and carry an HTTP `status`, so
 * both are read by shape.
 */
export function describeChatError(e: unknown): string {
  const err = e as { name?: string; status?: number; message?: string; cause?: any; code?: string } | undefined
  const name = err?.name ?? ''
  const message = String(err?.message ?? e ?? '')
  const brief = (s: string) => {
    const one = s.replace(/\s+/g, ' ').trim()
    return one.length > 160 ? `${one.slice(0, 160)}…` : one
  }
  const say = (line: string, cause: string) => `${line}（${brief(cause)}）`
  const status = typeof err?.status === 'number' ? err.status : undefined
  const http = status ? `HTTP ${status}: ${message}` : message

  if (name === 'DsmlLeakUnrecoverableError') return say('SILI 刚才脑子打结了，换个说法再问问吧。', `DSML 泄漏：${message}`)
  if (/^Tool call JSON parse failed/.test(message)) return say('SILI 手忙脚乱填错了东西，再问一次试试？', message)
  if (name === 'APIConnectionTimeoutError' || /timed? ?out/i.test(message))
    return say('SILI 想了太久，卡住了，过会儿再来找 SILI 吧。', `超时：${message}`)
  const netCode = `${err?.code ?? ''} ${err?.cause?.code ?? ''}`.trim()
  if (
    name === 'APIConnectionError' ||
    /ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|socket hang up|fetch failed|network/i.test(`${message} ${netCode}`)
  )
    return say('SILI 这边信号不好，过会儿再联系。', `网络中断：${netCode || message}`)
  if (status === 401 || status === 403) return say('SILI 被关在门外了，得请 leader 来看看。', http)
  if (status === 429) return say('SILI 今天说太多话，嗓子哑了，歇一会儿再来吧。', http)
  if (status === 413 || (status === 400 && /context|too long|maximum.*tokens|token limit/i.test(message)))
    return say('聊得太多，SILI 记不下了。', http)
  if (status && status >= 500) return say('SILI 这边出了点故障，不是你的问题，过会儿再试吧。', http)
  if (status) return say('SILI 的请求被退回来了。', http)
  return say('SILI 出了点状况。', name && name !== 'Error' ? `${name}: ${message}` : message)
}
