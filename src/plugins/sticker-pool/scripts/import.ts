/**
 * Bulk-add stickers from a manifest, outside the running bot.
 *
 *   bun src/plugins/sticker-pool/scripts/import.ts <manifest.json>
 *
 * The manifest is a JSON array; file paths are relative to the manifest:
 *   [{ "file": "gif/424.gif", "source": "qface", "tags": ["拒绝"], "desc": "…", "usage": "…" }]
 * Own stickers also carry "owner" (persona key) and "name".
 * Entries without tags/desc are described by the vision model.
 *
 * Run it where the bot's .env and database are reachable — in production,
 * inside the core container after `docker compose cp`-ing the files in.
 */
import { App } from 'koishi'

import { readFile } from 'node:fs/promises'
import { dirname, extname, resolve } from 'node:path'

import { loadEnv } from '@/bootstrap'
import {
  assetsS3Config,
  stickerPoolConfig,
} from '@/profiles/shared/plugin-configs'

import PluginMongo from '@koishijs/plugin-database-mongo'

import PluginAssetsS3 from 'koishi-plugin-assets-s3'

import PluginHTTP from '@cordisjs/plugin-http'

import StickerPool, { StickerSource } from '..'

interface Entry {
  file: string
  source: StickerSource
  tags?: string[]
  desc?: string
  usage?: string
  owner?: string
  name?: string
}

const MIME: Record<string, string> = {
  '.gif': 'image/gif',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
}

const manifestPath = resolve(process.argv[2] ?? '')
const entries: Entry[] = JSON.parse(await readFile(manifestPath, 'utf8'))
loadEnv()
const env = process.env
const config = stickerPoolConfig(env)
if (!config) throw new Error('no deepseek provider configured')

const app = new App()
app.plugin(PluginMongo, {
  host: env.DB_MONGO_HOST,
  port: Number(env.DB_MONGO_PORT),
  database: env.DB_MONGO_DATABASE,
})
app.plugin(PluginHTTP)
app.plugin(PluginAssetsS3, assetsS3Config(env))
app.plugin(StickerPool, config)
await app.start()

app.inject(['stickerPool'], async (ctx) => {
  let ok = 0
  for (const entry of entries) {
    const path = resolve(dirname(manifestPath), entry.file)
    const mime = MIME[extname(path).toLowerCase()]
    if (!mime) {
      console.log('skip (unknown type):', entry.file)
      continue
    }
    try {
      const row = await ctx.stickerPool.add(await readFile(path), mime, entry)
      ok++
      console.log(
        `#${row.id} [${row.tags.join('/')}] ${row.desc}${row.usage ? ` | ${row.usage}` : ''}`
      )
    } catch (e) {
      console.log('failed:', entry.file, e)
    }
  }
  console.log(`done: ${ok}/${entries.length}`)
  await app.stop()
  process.exit(0)
})
