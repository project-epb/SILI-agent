/**
 * Plugin configs shared by profiles. Only plugins installed by more than one
 * profile live here. Values that differ per profile (channel ids, QQ numbers)
 * must be parameters, never hard-coded here.
 */
import { Time } from 'koishi'

import { parseLLMProviders } from '@/utils/parseLLMProviders'

import { executablePath } from 'puppeteer'

type Env = NodeJS.ProcessEnv

export function assetsS3Config(env: Env) {
  const assetsPathPrefix =
    env.KOISHI_ENV === 'prod' ? 'sili/v4_prod/' : 'sili/v4_dev/'
  return {
    credentials: {
      accessKeyId: env.TOKEN_S3_ACCESS_KEY_ID,
      secretAccessKey: env.TOKEN_S3_ACCESS_KEY_SECRET,
    },
    bucket: env.TOKEN_S3_BUCKET,
    pathPrefix: assetsPathPrefix,
    publicUrl: `${env.TOKEN_S3_PUBLIC_URL}/${assetsPathPrefix}`,
    region: env.TOKEN_S3_REGION,
    endpoint: env.TOKEN_S3_ENDPOINT,
  }
}

export function consoleConfig() {
  return {
    title: 'SILI 监控中心',
    uiPath: '/dash',
    apiPath: '/api/status',
  }
}

export function githubConfig(env: Env) {
  return {
    path: '/api/github',
    appId: env.TOKEN_GITHUB_APPID,
    appSecret: env.TOKEN_GITHUB_APPSECRET,
    redirect: env.TOKEN_GITHUB_REDIRECT, // optional override; unset → derived from selfUrl (see applyOAuth)
    replyTimeout: 6 * Time.hour,
    replyFooter:
      '<sub>↪ by [SILI agent](https://github.com/project-epb/SILI-agent)</sub>',
  }
}

export function puppeteerConfig() {
  return {
    // headless: 'new',
    executablePath: executablePath(),
  }
}

export function llmConfig(env: Env) {
  return {
    providers: parseLLMProviders(env),
    maxTokens: env.LLM_MAX_TOKENS ? Number(env.LLM_MAX_TOKENS) : 16384,
    model: env.LLM_MODEL || 'gpt-4o',
    memoryModel: env.LLM_AGENT_MEMORY_MODEL,
    // IM 场景下 50 turn 就几千 token，DeepSeek 类便宜模型完全 cover；
    // 切贵模型时记得把这个数字也调小。
    historyTurnCount: 50,
    sessionIdleTimeoutMs: env.LLM_SESSION_IDLE_HOURS
      ? Number(env.LLM_SESSION_IDLE_HOURS) * 60 * 60 * 1000
      : undefined,
    tavily: env.LLM_TAVILY_API_KEY
      ? { apiKey: env.LLM_TAVILY_API_KEY }
      : undefined,
  }
}

// Gelbooru 标签/图片查询（agent 工具，只读）：凭据走 .env，未配则惰性无害
// （命令仍注册，调用返回未配置提示）。imageBlacklist 可按需启用，Computed 按群。
export function gelbooruConfig(env: Env) {
  return {
    apiKey: env.GELBOORU_API_KEY,
    userId: env.GELBOORU_USER_ID,
    // 含敏感标签的 post 去缩略图（保留 tags/score 供 agent 写 prompt 参考）。
    // imageBlacklist: (s) =>
    //   s.channelId === env.CHANNEL_QQ_XXX ? [] : ['nsfw', 'nude', 'explicit'],
  }
}
