/** Keep the signed URL intact and give the browser only QQ-hosted images. */
export function qqAvatar(value: unknown) {
  if (typeof value !== 'string' || !value || value.length > 2048) return
  try {
    const url = new URL(value)
    const domains = ['qq.com', 'qq.com.cn', 'qlogo.cn', 'qpic.cn']
    if (
      url.protocol === 'https:' &&
      !url.username &&
      !url.password &&
      domains.some(
        (domain) =>
          url.hostname === domain || url.hostname.endsWith('.' + domain)
      )
    )
      return value
  } catch {
    return
  }
}
