export interface ChatUsage {
  promptTokens?: number
  completionTokens?: number
  totalTokens?: number
  cachedTokens?: number
  reasoningTokens?: number
}

export interface UsageRow {
  time: number
  model: string
  conversation_owner: number
  conversation_id: string
  usage: ChatUsage | null
}

export interface OverviewMetrics {
  calls: number
  totalTokens: number
  promptTokens: number
  completionTokens: number
  // cachedTokens ⊂ promptTokens — display-only insight, never part of totalTokens.
  cachedTokens: number
  activeUsers: number
  conversations: number
}

export interface DashboardStats {
  range: number
  overview: OverviewMetrics & { prev: OverviewMetrics }
  trend: Array<{
    date: string
    promptTokens: number
    completionTokens: number
    calls: number
  }>
  models: Array<{
    model: string
    calls: number
    totalTokens: number
    promptTokens: number
    completionTokens: number
  }>
  users: Array<{
    id: number
    name: string
    account: string
    totalTokens: number
    conversations: number
  }>
}

const DAY = 86_400_000

function toLocalDate(time: number): string {
  const d = new Date(time)
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${d.getFullYear()}-${m}-${day}`
}

// Local-midnight of the calendar day containing `time` (DST-safe; not fixed-ms).
function startOfLocalDay(time: number): number {
  const d = new Date(time)
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
}

// Local-midnight of the next calendar day (crosses DST via calendar arithmetic).
function nextLocalDay(time: number): number {
  const d = new Date(time)
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1).getTime()
}

// cachedTokens ⊂ promptTokens, reasoningTokens ⊂ completionTokens — never re-add.
// `cached` is surfaced only as a display-only breakdown, not summed into total.
function rowTokens(u: ChatUsage | null) {
  const prompt = u?.promptTokens ?? 0
  const completion = u?.completionTokens ?? 0
  const cached = u?.cachedTokens ?? 0
  const total = u?.totalTokens ?? prompt + completion
  return { prompt, completion, cached, total }
}

function overviewOf(rows: UsageRow[]): OverviewMetrics {
  let totalTokens = 0
  let promptTokens = 0
  let completionTokens = 0
  let cachedTokens = 0
  const users = new Set<number>()
  const convs = new Set<string>()
  for (const r of rows) {
    const t = rowTokens(r.usage)
    totalTokens += t.total
    promptTokens += t.prompt
    completionTokens += t.completion
    cachedTokens += t.cached
    users.add(r.conversation_owner)
    convs.add(r.conversation_id)
  }
  return {
    calls: rows.length,
    totalTokens,
    promptTokens,
    completionTokens,
    cachedTokens,
    activeUsers: users.size,
    conversations: convs.size,
  }
}

export function aggregateStats(
  rows: UsageRow[],
  rangeDays: number,
  now: number,
  identityOf: (id: number) => { name: string; account: string }
): DashboardStats {
  const windowMs = rangeDays * DAY
  const curStart = now - windowMs
  const prevStart = now - 2 * windowMs

  const current = rows.filter((r) => r.time >= curStart && r.time <= now)
  const previous = rows.filter((r) => r.time >= prevStart && r.time < curStart)

  // trend: bucket current window by local day, fill empty days with zeros
  const byDay = new Map<
    string,
    { promptTokens: number; completionTokens: number; calls: number }
  >()
  for (const r of current) {
    const key = toLocalDate(r.time)
    const b = byDay.get(key) ?? {
      promptTokens: 0,
      completionTokens: 0,
      calls: 0,
    }
    const t = rowTokens(r.usage)
    b.promptTokens += t.prompt
    b.completionTokens += t.completion
    b.calls += 1
    byDay.set(key, b)
  }
  // Iterate on local calendar-day boundaries (not fixed 86_400_000ms steps): a
  // fixed-ms step lands at the same wall-clock time each day and can skip a local
  // calendar day across a DST transition, dropping a real day's rows from `trend`.
  const trend: DashboardStats['trend'] = []
  for (
    let day = startOfLocalDay(curStart);
    day <= now;
    day = nextLocalDay(day)
  ) {
    const key = toLocalDate(day)
    trend.push({
      date: key,
      ...(byDay.get(key) ?? { promptTokens: 0, completionTokens: 0, calls: 0 }),
    })
  }

  const byModel = new Map<
    string,
    {
      calls: number
      totalTokens: number
      promptTokens: number
      completionTokens: number
    }
  >()
  for (const r of current) {
    const m = byModel.get(r.model) ?? {
      calls: 0,
      totalTokens: 0,
      promptTokens: 0,
      completionTokens: 0,
    }
    const t = rowTokens(r.usage)
    m.calls += 1
    m.totalTokens += t.total
    m.promptTokens += t.prompt
    m.completionTokens += t.completion
    byModel.set(r.model, m)
  }
  const models = [...byModel.entries()]
    .map(([model, v]) => ({ model, ...v }))
    .sort((a, b) => b.totalTokens - a.totalTokens)

  const byUser = new Map<number, { totalTokens: number; convs: Set<string> }>()
  for (const r of current) {
    const u = byUser.get(r.conversation_owner) ?? {
      totalTokens: 0,
      convs: new Set<string>(),
    }
    u.totalTokens += rowTokens(r.usage).total
    u.convs.add(r.conversation_id)
    byUser.set(r.conversation_owner, u)
  }
  const users = [...byUser.entries()]
    .map(([id, v]) => {
      const idt = identityOf(id)
      return {
        id,
        name: idt.name,
        account: idt.account,
        totalTokens: v.totalTokens,
        conversations: v.convs.size,
      }
    })
    .sort((a, b) => b.totalTokens - a.totalTokens)
    .slice(0, 10)

  return {
    range: rangeDays,
    overview: { ...overviewOf(current), prev: overviewOf(previous) },
    trend,
    models,
    users,
  }
}
