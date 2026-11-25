/**
 * Bootstrap shared by every profile: env loading, and the Koishi app with its
 * core services (server, database).
 */
import { config as setupDotEnv } from 'dotenv'

import { App } from 'koishi'

import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import process from 'node:process'

import type { Profile } from '@/profiles/types'

import PluginMongo from '@koishijs/plugin-database-mongo'
import PluginSQLite from '@koishijs/plugin-database-sqlite'
import PluginServer from '@koishijs/plugin-server'

import NativeSQLite from '@sili/database-sqlite-native'

/**
 * `.env.production` / `.env.development` and `.env.local` are loaded with
 * `override: true`, so they overwrite variables passed in by compose. Never put
 * `SILI_PROFILE` in those files; the entry reads it before calling this.
 */
export function loadEnv() {
  const PROD = process.env.NODE_ENV === 'production'
  setupDotEnv()
  setupDotEnv({
    path: resolve(
      import.meta.dirname,
      '..',
      PROD ? '.env.production' : '.env.development'
    ),
    override: true,
  })
  setupDotEnv({
    path: resolve(import.meta.dirname, '..', '.env.local'),
    override: true,
  })
}

/**
 * Log unhandled rejections and uncaught exceptions instead of letting them kill
 * the process: bun exits on an unhandled rejection, and Koishi only installs
 * these listeners in its CLI worker, which SILI does not use.
 */
export function logProcessErrors(app: App) {
  const logger = app.logger('process')
  for (const event of ['unhandledRejection', 'uncaughtException'] as const) {
    process.on(event, (error) => logger.error(event, error))
  }
}

/** Create the app with options shared by every profile, plus core services. */
export function createApp(profile: Profile, env = process.env) {
  /** 初始化 Koishi 实例 */
  const app = new App({
    nickname: env.KOISHI_NICKNAME?.split('|'),
    minSimilarity: 0.8,
    delay: {
      message: 3 * 1000,
      broadcast: 10 * 1000,
      prompt: 60 * 1000,
    },
    ...profile.appOptions(env),
  })
  // core services, init immediately
  app.plugin(PluginServer, {
    host: '0.0.0.0',
    port: env.KOISHI_PROT ? +env.KOISHI_PROT : undefined,
    selfUrl: env.KOISHI_SELF_URL,
  })

  installDatabase(app, env)
  return app
}

export function installDatabase(app: App, env = process.env) {
  const backend = env.SILI_DATABASE || 'mongo'
  if (backend === 'sqlite') {
    const path = resolve(app.baseDir, 'data/sili.sqlite')
    if (!existsSync(path))
      throw new Error('SILI SQLite migration file is missing')
    const driver = env.SILI_SQLITE_DRIVER || 'wasm'
    if (driver !== 'wasm' && driver !== 'native')
      throw new Error('Unknown SILI_SQLITE_DRIVER')
    app.plugin(driver === 'native' ? NativeSQLite : PluginSQLite, { path })
    app.logger('database').info('SQLite driver: %s', driver)
    return
  }
  if (backend !== 'mongo') throw new Error('Unknown SILI_DATABASE backend')
  app.plugin(PluginMongo, {
    host: env.DB_MONGO_HOST,
    port: Number(env.DB_MONGO_PORT),
    // username: env.DB_MONGO_USER,
    // password: env.DB_MONGO_PASSWORD,
    database: env.DB_MONGO_DATABASE,
  })
}
