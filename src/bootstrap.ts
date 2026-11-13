/**
 * Bootstrap shared by every profile: env loading, and the Koishi app with its
 * core services (server, database).
 */
import { config as setupDotEnv } from 'dotenv'

import { App } from 'koishi'

import { resolve } from 'node:path'
import process from 'node:process'

import type { Profile } from '@/profiles/types'

import PluginMongo from '@koishijs/plugin-database-mongo'
import PluginServer from '@koishijs/plugin-server'

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
 * these listeners in its CLI worker, which SILI does not use. v4 gets the same
 * from ProcessErrorHandler (which also DMs the owner over OneBot); profiles
 * without it call this.
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

  /** 安装数据库 */
  app.plugin(PluginMongo, {
    host: env.DB_MONGO_HOST,
    port: Number(env.DB_MONGO_PORT),
    // username: env.DB_MONGO_USER,
    // password: env.DB_MONGO_PASSWORD,
    database: env.DB_MONGO_DATABASE,
  })

  return app
}
