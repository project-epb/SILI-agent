export interface Usage {
  promptTokens?: number
  completionTokens?: number
  totalTokens?: number
  cachedTokens?: number
}
export interface UserUsageRow {
  time: number
  model: string
  usage: Usage | null
}
export interface UserIdentity {
  id: number
  name: string
  account: string
}
export interface UserOverview extends UserIdentity {
  sessionCount: number
  firstActive: number | null
  lastActive: number | null
  calls: number
  totalTokens: number
  promptTokens: number
  completionTokens: number
  cachedTokens: number
  models: Array<{ model: string; calls: number; totalTokens: number }>
  trend: Array<{ date: string; promptTokens: number; completionTokens: number }>
}

const DAY = 86_400_000

// cachedTokens ⊂ promptTokens — 展示用，不计入 total。
function tok(u: Usage | null) {
  const prompt = u?.promptTokens ?? 0
  const completion = u?.completionTokens ?? 0
  const cached = u?.cachedTokens ?? 0
  return {
    prompt,
    completion,
    cached,
    total: u?.totalTokens ?? prompt + completion,
  }
}

function localDate(time: number): string {
  const d = new Date(time)
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${d.getFullYear()}-${m}-${day}`
}

export function aggregateUserOverview(
  rows: UserUsageRow[],
  sessionCount: number,
  identity: UserIdentity,
  now: number,
  rangeDays = 30
): UserOverview {
  let totalTokens = 0
  let promptTokens = 0
  let completionTokens = 0
  let cachedTokens = 0
  let firstActive: number | null = null
  let lastActive: number | null = null
  const byModel = new Map<string, { calls: number; totalTokens: number }>()
  const since = now - rangeDays * DAY
  const byDay = new Map<
    string,
    { promptTokens: number; completionTokens: number }
  >()

  for (const r of rows) {
    const t = tok(r.usage)
    totalTokens += t.total
    promptTokens += t.prompt
    completionTokens += t.completion
    cachedTokens += t.cached
    if (firstActive === null || r.time < firstActive) firstActive = r.time
    if (lastActive === null || r.time > lastActive) lastActive = r.time
    const m = byModel.get(r.model) ?? { calls: 0, totalTokens: 0 }
    m.calls += 1
    m.totalTokens += t.total
    byModel.set(r.model, m)
    if (r.time >= since) {
      const key = localDate(r.time)
      const b = byDay.get(key) ?? { promptTokens: 0, completionTokens: 0 }
      b.promptTokens += t.prompt
      b.completionTokens += t.completion
      byDay.set(key, b)
    }
  }

  const trend: UserOverview['trend'] = []
  for (
    let d = new Date(since);
    d.getTime() <= now;
    d.setDate(d.getDate() + 1)
  ) {
    const key = localDate(d.getTime())
    trend.push({
      date: key,
      ...(byDay.get(key) ?? { promptTokens: 0, completionTokens: 0 }),
    })
  }

  return {
    ...identity,
    sessionCount,
    firstActive,
    lastActive,
    calls: rows.length,
    totalTokens,
    promptTokens,
    completionTokens,
    cachedTokens,
    models: [...byModel.entries()]
      .map(([model, v]) => ({ model, ...v }))
      .sort((a, b) => b.totalTokens - a.totalTokens),
    trend,
  }
}
