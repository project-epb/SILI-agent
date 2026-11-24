import { $, App } from 'koishi'

import { createReadStream } from 'node:fs'
import { open, rm } from 'node:fs/promises'
import { resolve } from 'node:path'
import { isDeepStrictEqual } from 'node:util'

import { loadProfile } from '@/profiles'

import SQLite from '@koishijs/plugin-database-sqlite'
import Server from '@koishijs/plugin-server'

import { BSON } from 'mongodb'

const archivedTables = new Set([
  '_fields',
  'fandom_verify',
  'mention_logs',
  'qqbot_message',
  'stats_daily',
  'stats_hourly',
  'stats_longterm',
  'test',
])

// These values keep the v5 models registered in an isolated process.
Object.assign(process.env, {
  TOKEN_GITHUB_APPID: 'migration',
  TOKEN_GITHUB_APPSECRET: 'migration',
  TOKEN_S3_BUCKET: 'migration',
  TOKEN_S3_REGION: 'auto',
  TOKEN_S3_ENDPOINT: 'http://127.0.0.1:9',
  TOKEN_S3_PUBLIC_URL: 'http://127.0.0.1:9',
  TOKEN_S3_ACCESS_KEY_ID: 'migration',
  TOKEN_S3_ACCESS_KEY_SECRET: 'migration',
  LLM_PROVIDER_0_NAME: 'deepseek',
  LLM_PROVIDER_0_TYPE: 'openai',
  LLM_PROVIDER_0_API_KEY: 'migration',
  LLM_PROVIDER_0_BASE_URL: 'http://127.0.0.1:9',
})

type Row = Record<string, any>
type Table = keyof import('koishi').Tables
type Driver = App['database']

class ImportError extends Error {}

async function* readExport(path: string) {
  const input = createReadStream(path, { encoding: 'utf8' })
  let rest = ''
  for await (const text of input) {
    // JSON strings can contain Unicode line separators. Use only LF as a delimiter.
    const lines = (rest + text).split('\n')
    rest = lines.pop()!
    yield* lines
  }
  if (rest) yield rest
}

async function importTables(database: Driver, sourcePath: string) {
  const imported: Record<string, number> = {}
  const archived: Record<string, number> = {}
  const normalized: Record<string, number> = {}
  const legacyFields: Record<string, number> = {}
  const seen = new Set<string>()
  const bindingsByUid = new Map<string, number>()
  let current: { name: Table; count: number } | undefined
  let sourceCount = 0
  let archiveOnlyCount = 0
  let chunk: Row[] = []

  function increment(counts: Record<string, number>, key: string) {
    counts[key] = (counts[key] || 0) + 1
  }

  async function flush() {
    if (!current || !chunk.length) return
    const { name } = current
    const model = database.tables[name]
    const keys = Array.isArray(model.primary) ? model.primary : [model.primary]
    const expected = new Map<string, Row>()
    const primaryOf = (row: Row) =>
      Object.fromEntries(keys.map((key) => [key, row[key]]))
    const identityOf = (row: Row) => JSON.stringify(primaryOf(row))
    const rows = chunk.map((raw) => {
      const fields = model.format(raw, false)
      for (const key of Object.keys(raw)) {
        if (
          key === '_id' ||
          key in fields ||
          Object.keys(fields).some((field) => field.startsWith(key + '.'))
        )
          continue
        increment(legacyFields, `${name}.${key}`)
      }
      for (const key of name === 'channel_message'
        ? ['recalled', 'isSelf']
        : name === 'qqbot_channel'
          ? ['activated']
          : []) {
        if (fields[key] != null) continue
        fields[key] = false
        increment(normalized, `${name}.${key}`)
      }
      if (
        name === 'openai_chat' &&
        typeof fields.time === 'number' &&
        !Number.isFinite(fields.time)
      ) {
        fields.time = null
        increment(normalized, 'openai_chat.time')
      }
      if (name === 'dialogue' && typeof fields.writer === 'string') {
        const writer = Number(fields.writer)
        if (/^\d+$/.test(fields.writer) && Number.isSafeInteger(writer)) {
          fields.writer = writer
          increment(normalized, 'dialogue.writer')
        } else if (
          fields.writer === '' ||
          /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(fields.writer)
        ) {
          // Koishi's current dialogue writer is a numeric user id.
          fields.writer = 0
          increment(normalized, 'dialogue.writer (unmapped)')
        }
      }
      if (name === 'binding' && Number.isSafeInteger(fields.aid)) {
        bindingsByUid.set(`${fields.platform}:${fields.pid}`, fields.aid)
      }
      if (
        name === 'openai_chat' &&
        typeof fields.conversation_owner === 'string'
      ) {
        const owner = bindingsByUid.get(fields.conversation_owner)
        fields.conversation_owner = owner ?? null
        increment(
          normalized,
          owner == null
            ? 'openai_chat.conversation_owner (unmapped)'
            : 'openai_chat.conversation_owner'
        )
      }
      if (
        name === 'openai_chat' &&
        typeof fields.content === 'string' &&
        fields.content.includes('\0')
      ) {
        // The sql.js text binding treats NUL as the end of the string.
        fields.content = fields.content.replaceAll('\0', '\uFFFD')
        increment(normalized, 'openai_chat.content (NUL)')
      }
      const row = model.parse(fields)
      const flat = model.format(row)
      if (keys.some((key) => flat[key] == null))
        throw new ImportError(
          `${name}: missing primary key (${keys.filter((key) => flat[key] == null).join(', ')})`
        )
      const identity = identityOf(flat)
      if (expected.has(identity))
        throw new ImportError(`${name}: duplicate source key`)
      expected.set(identity, flat)
      return row
    })

    await database.withTransaction(async (tx) => {
      for (const row of rows) await tx.create(name, row as never)
      const queries = [...expected.values()].map(primaryOf)
      // Keep the query expression small enough for the bundled WASM engine.
      for (let offset = 0; offset < queries.length; offset += 32) {
        const batch = queries.slice(offset, offset + 32)
        const written = await tx.get(name, { $or: batch })
        if (written.length !== batch.length)
          throw new ImportError(`${name}: batch count mismatch`)
        for (const row of written) {
          const flat = model.format(row)
          const before = expected.get(identityOf(flat))
          if (!before) throw new ImportError(`${name}: primary key mismatch`)
          for (const [key, value] of Object.entries(before)) {
            if (!isDeepStrictEqual(flat[key], value)) {
              throw new ImportError(
                `${name}.${key}: field mismatch (${typeof value} → ${typeof flat[key]})`
              )
            }
          }
        }
      }
    })
    chunk = []
  }

  async function finishTable() {
    if (!current) return
    const { name, count } = current
    if (sourceCount !== count)
      throw new ImportError(`${name}: export count mismatch`)
    if (archivedTables.has(name)) {
      archived[name] = count
      return
    }
    await flush()
    const total = await database.select(name).execute(() => $.sum(1))
    if (total !== count - archiveOnlyCount)
      throw new ImportError(`${name}: total count mismatch`)
    imported[name] = total
    if (archiveOnlyCount) archived[`${name} (invalid key)`] = archiveOnlyCount
    console.log(`verified ${name}: ${total}`)
  }

  try {
    for await (const line of readExport(sourcePath)) {
      const entry = BSON.EJSON.parse(line, { relaxed: true })
      if (typeof entry.table === 'string') {
        await finishTable()
        const name = entry.table as Table
        if (
          !/^[a-zA-Z0-9_.]+$/.test(name) ||
          seen.has(name) ||
          !Number.isSafeInteger(entry.count) ||
          entry.count < 0
        ) {
          throw new ImportError('Invalid or repeated collection header')
        }
        if (
          !archivedTables.has(name) &&
          !Object.hasOwn(database.tables, name)
        ) {
          throw new ImportError(`Unclassified collection: ${name}`)
        }
        current = { name, count: entry.count }
        sourceCount = 0
        archiveOnlyCount = 0
        seen.add(name)
        continue
      }
      if (!current || !entry.row || typeof entry.row !== 'object')
        throw new ImportError('Invalid row')
      sourceCount++
      if (archivedTables.has(current.name)) continue
      const { row } = entry
      // Null platform keys cannot be addressed by Koishi sessions.
      const obsoleteBinding =
        current.name === 'binding' &&
        (row.pid == null || row.platform == null) &&
        row.aid != null &&
        row.aid === row.bid
      const obsoleteChannel =
        current.name === 'channel' && row.id == null && row.platform != null
      if (obsoleteBinding || obsoleteChannel) {
        archiveOnlyCount++
        continue
      }
      chunk.push(row)
      if (chunk.length >= 256) await flush()
    }
    await finishTable()
    if (!imported.user || !imported.channel_message)
      throw new ImportError('Missing user or message records')
    console.log(
      JSON.stringify({ imported, archived, normalized, legacyFields })
    )
  } catch (error) {
    console.error(
      `Import stage: ${current?.name ?? 'header'}, source row ${sourceCount}`
    )
    throw error
  }
}

async function main() {
  const [source, output] = process.argv.slice(2)
  if (!source || !output)
    throw new ImportError(
      'Usage: bun scripts/import-mongo-to-sqlite.ts SOURCE.ndjson NEW.sqlite'
    )
  const path = resolve(output)
  const file = await open(path, 'wx', 0o600)
  await file.close()

  const profile = await loadProfile('v5')
  const app = new App(profile.appOptions(process.env))
  app.plugin(Server, { host: '127.0.0.1', port: 0 })
  app.plugin(SQLite, { path })
  let success = false
  try {
    await profile.install(app)
    await app.start()
    await importTables(app.database, source)
    success = true
  } finally {
    try {
      await app.stop()
    } finally {
      if (!success) await rm(path, { force: true })
    }
  }
}

main().catch((error: unknown) => {
  // The driver may include row values in exceptions. Report only safe context.
  console.error(
    error instanceof ImportError
      ? error.message
      : `Import failed: ${(error as Error)?.name}`
  )
  process.exitCode = 1
})
