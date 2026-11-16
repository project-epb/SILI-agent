/**
 * @name SILI-agent 万界规划局QQ机器人
 * @author Dragon-Fish <dragon-fish@qq.com>
 *
 * @license MIT
 */
import process from 'node:process'

import { createApp, loadEnv } from '@/bootstrap'
import { loadProfile, resolveProfileName } from '@/profiles'

async function main() {
  // Read the profile name before loadEnv(): it loads .env.* with
  // `override: true`, which would clobber a SILI_PROFILE passed by compose.
  const profileName = resolveProfileName(process.argv, process.env)
  loadEnv()

  const profile = await loadProfile(profileName)
  const app = createApp(profile)
  const logger = app.logger('INIT')
  logger.info('profile: %s', profileName)

  await profile.install(app)

  /** 启动应用程序 */
  await app.start()
  // Deployment treats this exact line as the readiness signal; keep it verbatim.
  logger.info('🌈', 'SILI启动成功~')
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
