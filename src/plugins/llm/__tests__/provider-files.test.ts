import { describe, expect, it } from 'vitest'

import { type ProviderFileRow, ProviderFiles } from '../services/provider-files'

/** Just enough of koishi's database for ProviderFiles. */
function fakeDb() {
  const rows: ProviderFileRow[] = []
  let nextId = 1
  const match = (r: any, q: any) =>
    Object.entries(q).every(([k, v]: [string, any]) => (v && typeof v === 'object' && '$lte' in v ? r[k] <= v.$lte : r[k] === v))
  const database = {
    select: (_t: string) => {
      let q: any = {}
      let order: [string, string] | undefined
      let lim = Infinity
      const chain = {
        where: (w: any) => ((q = w), chain),
        orderBy: (f: string, d: string) => ((order = [f, d]), chain),
        limit: (n: number) => ((lim = n), chain),
        execute: async () => {
          const out = rows.filter((r) => match(r, q))
          if (order) {
            const [f, d] = order
            out.sort((a: any, b: any) => (d === 'asc' ? a[f] - b[f] : b[f] - a[f]))
          }
          return out.slice(0, lim)
        },
      }
      return chain
    },
    get: async (_t: string, q: any) => rows.filter((r) => match(r, q)),
    set: async (_t: string, q: any, patch: any) => rows.filter((r) => match(r, q)).forEach((r) => Object.assign(r, patch)),
    create: async (_t: string, row: any) => rows.push({ ...row, id: nextId++ }),
    remove: async (_t: string, q: any) => {
      for (let i = rows.length - 1; i >= 0; i--) if (match(rows[i], q)) rows.splice(i, 1)
    },
  }
  return { rows, ctx: { database, logger: () => ({ warn() {} }) } as any }
}

function fakeClient(opts: { refuseOnce?: boolean } = {}) {
  let n = 0
  let refuse = opts.refuseOnce
  const deleted: string[] = []
  const client = {
    files: {
      create: async () => {
        if (refuse) {
          refuse = false
          throw Object.assign(new Error('storage quota exceeded'), { status: 400 })
        }
        return { id: `file-${++n}` }
      },
      delete: async (id: string) => {
        deleted.push(id)
        if (id === 'gone') throw Object.assign(new Error('nf'), { status: 404 })
      },
    },
  }
  return { client: client as any, deleted }
}

const bytes = (n: number) => new Uint8Array(n)

describe('ProviderFiles', () => {
  it('reuses a pointer with time left and uploads once per image', async () => {
    const { ctx, rows } = fakeDb()
    const { client } = fakeClient()
    let now = 1_000_000
    const files = new ProviderFiles(ctx, 'ds', client, 1000, () => now)
    expect(await files.fileIdFor('a', bytes(10), 'image/webp')).toBe('file-1')
    expect(await files.fileIdFor('a', bytes(10), 'image/webp')).toBe('file-1')
    expect(rows).toHaveLength(1)
    // Under an hour left: upload afresh while the local copy exists...
    now = rows[0].expires_at - 30 * 60 * 1000
    expect(await files.fileIdFor('a', bytes(10), 'image/webp')).toBe('file-2')
    // ...but without it, any unexpired pointer still serves.
    expect(await files.fileIdFor('a', undefined, 'image/webp')).toBe('file-2')
    now = rows.at(-1)!.expires_at + 1
    expect(await files.fileIdFor('a', undefined, 'image/webp')).toBeUndefined()
  })

  it('evicts least recently used files to stay under the total', async () => {
    const { ctx, rows } = fakeDb()
    const { client, deleted } = fakeClient()
    let now = 0
    const files = new ProviderFiles(ctx, 'ds', client, 25, () => ++now)
    await files.fileIdFor('a', bytes(10), 'image/webp')
    await files.fileIdFor('b', bytes(10), 'image/webp')
    await files.fileIdFor('a', bytes(10), 'image/webp') // a is now newer than b
    await files.fileIdFor('c', bytes(10), 'image/webp')
    expect(deleted).toEqual(['file-2'])
    expect(rows.map((r) => r.image_id).sort()).toEqual(['a', 'c'])
  })

  it('frees space and retries once when the provider refuses for quota', async () => {
    const { ctx, rows } = fakeDb()
    const { client, deleted } = fakeClient()
    const files = new ProviderFiles(ctx, 'ds', client, 1e9)
    await files.fileIdFor('a', bytes(10), 'image/webp')
    const refusing = fakeClient({ refuseOnce: true })
    const files2 = new ProviderFiles(ctx, 'ds', refusing.client, 1e9)
    expect(await files2.fileIdFor('b', bytes(10), 'image/webp')).toBe('file-1')
    expect(refusing.deleted).toEqual(['file-1'])
    expect(rows.map((r) => r.image_id)).toEqual(['b'])
    expect(deleted).toEqual([])
  })

  it('deletes expired files, treating 404 as already gone', async () => {
    const { ctx, rows } = fakeDb()
    const { client, deleted } = fakeClient()
    rows.push(
      { id: 1, provider: 'ds', image_id: 'x', file_id: 'gone', bytes: 1, uploaded_at: 0, last_used_at: 0, expires_at: 5 },
      { id: 2, provider: 'ds', image_id: 'y', file_id: 'live', bytes: 1, uploaded_at: 0, last_used_at: 0, expires_at: 50 }
    )
    const files = new ProviderFiles(ctx, 'ds', client, 1e9, () => 10)
    expect(await files.cleanup()).toBe(1)
    expect(deleted).toEqual(['gone'])
    expect(rows.map((r) => r.file_id)).toEqual(['live'])
  })
})
