import type { Context } from 'koishi'
import { OpenAI, toFile } from 'openai'

declare module 'koishi' {
  interface Tables {
    llm_provider_file: ProviderFileRow
  }
}

/** A file uploaded to a provider's Files API; belongs to that provider only. */
export interface ProviderFileRow {
  id: number
  provider: string
  image_id: string
  file_id: string
  bytes: number
  uploaded_at: number
  last_used_at: number
  expires_at: number
}

const DAY = 24 * 60 * 60 * 1000
/** Upload lifetime we ask for (and assume when the provider does not say). */
const FILE_TTL_S = 7 * 24 * 60 * 60
/** A pointer this close to expiry is re-uploaded rather than reused. */
const REUSE_MARGIN_MS = 60 * 60 * 1000

export function extendProviderFileTable(ctx: Context) {
  ctx.model.extend(
    'llm_provider_file',
    {
      id: 'unsigned',
      provider: 'string',
      image_id: 'string',
      file_id: 'string',
      bytes: 'unsigned',
      uploaded_at: 'double',
      last_used_at: 'double',
      expires_at: 'double',
    },
    { autoInc: true }
  )
}

/** Upload failures that more room on the provider may fix. */
function isQuotaError(e: any): boolean {
  const text = `${e?.status ?? ''} ${e?.message ?? ''}`.toLowerCase()
  return e?.status === 413 || /quota|storage|limit|space|exceed/.test(text)
}

/**
 * One provider's Files API pointers for stored images. We clean up after
 * ourselves rather than trusting the provider to expire files: few honour
 * `expires_after`, and left alone the files pile up until every upload
 * fails on quota.
 */
export class ProviderFiles {
  private inflight = new Map<string, Promise<string>>()

  constructor(
    private readonly ctx: Context,
    private readonly provider: string,
    private readonly client: OpenAI,
    private readonly maxBytes: number,
    private readonly now = Date.now
  ) {}

  /**
   * A file_id for the image: a pointer with at least an hour left, else a
   * fresh upload. With the local copy gone (`bytes` undefined), any
   * unexpired pointer still works; undefined when there is none.
   */
  async fileIdFor(imageId: string, bytes: Uint8Array | undefined, mime: string): Promise<string | undefined> {
    const now = this.now()
    const [row] = await this.ctx.database
      .select('llm_provider_file')
      .where({ provider: this.provider, image_id: imageId })
      .orderBy('expires_at', 'desc')
      .limit(1)
      .execute()
    const usable = row && (bytes ? row.expires_at - now >= REUSE_MARGIN_MS : row.expires_at > now)
    if (usable) {
      await this.ctx.database.set('llm_provider_file', { id: row.id }, { last_used_at: now })
      return row.file_id
    }
    if (!bytes) return undefined
    let pending = this.inflight.get(imageId)
    if (!pending) {
      pending = this.upload(imageId, bytes, mime).finally(() => this.inflight.delete(imageId))
      this.inflight.set(imageId, pending)
    }
    return pending
  }

  private async upload(imageId: string, bytes: Uint8Array, mime: string): Promise<string> {
    await this.makeRoom(bytes.length)
    const send = () =>
      this.client.files.create({
        file: toFile(bytes, `${imageId}.${mime.split('/')[1] ?? 'bin'}`, { type: mime }) as any,
        purpose: 'user_data',
        expires_after: { anchor: 'created_at', seconds: FILE_TTL_S },
      } as any)
    let file: any
    try {
      file = await send()
    } catch (e) {
      if (!isQuotaError(e)) throw e
      this.ctx.logger('llm').warn('[files] %s upload refused for space, evicting oldest: %s', this.provider, (e as any)?.message)
      await this.evictOldest(bytes.length, true)
      file = await send()
    }
    const now = this.now()
    await this.ctx.database.create('llm_provider_file', {
      provider: this.provider,
      image_id: imageId,
      file_id: file.id,
      bytes: bytes.length,
      uploaded_at: now,
      last_used_at: now,
      expires_at: typeof file.expires_at === 'number' ? file.expires_at * 1000 : now + FILE_TTL_S * 1000,
    })
    return file.id
  }

  /** Stay under the provider's total: delete least recently used first. */
  private async makeRoom(size: number) {
    const rows = await this.ctx.database.get('llm_provider_file', { provider: this.provider }, ['bytes'])
    const used = rows.reduce((s, r) => s + r.bytes, 0)
    if (used + size > this.maxBytes) await this.evictOldest(used + size - this.maxBytes)
  }

  /** Delete least recently used pointers (and their remote files) until `need` bytes are freed. */
  private async evictOldest(need: number, atLeastOne = false) {
    const rows = await this.ctx.database
      .select('llm_provider_file')
      .where({ provider: this.provider })
      .orderBy('last_used_at', 'asc')
      .execute()
    let freed = 0
    for (const row of rows) {
      if (freed >= need && !(atLeastOne && freed === 0)) break
      await this.remove(row)
      freed += row.bytes
    }
  }

  private async remove(row: ProviderFileRow) {
    try {
      await this.client.files.delete(row.file_id)
    } catch (e: any) {
      if (e?.status !== 404) throw e
    }
    await this.ctx.database.remove('llm_provider_file', { id: row.id })
  }

  /** Delete expired pointers and their remote files (a 404 counts as gone). */
  async cleanup(): Promise<number> {
    const rows = await this.ctx.database.get('llm_provider_file', {
      provider: this.provider,
      expires_at: { $lte: this.now() },
    })
    for (const row of rows) await this.remove(row)
    return rows.length
  }
}

export const PROVIDER_FILES_CLEANUP_MS = DAY
