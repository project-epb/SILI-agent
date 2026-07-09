export function matchUser(
  u: { id: number; name: string; account: string },
  query: string
): boolean {
  const q = (query ?? '').trim().toLowerCase()
  if (!q) return true
  return (
    `#${u.id}` === q ||
    String(u.id) === q ||
    u.account.toLowerCase().includes(q) ||
    u.name.toLowerCase().includes(q)
  )
}

export function paginate<T>(arr: T[], limit: number, offset: number): { total: number; page: T[] } {
  const off = Math.max(0, offset | 0)
  const lim = Math.max(0, limit | 0)
  return { total: arr.length, page: arr.slice(off, off + lim) }
}
