import type { App, Context } from 'koishi'

/**
 * A profile decides which adapters and plugins SILI runs with. Exactly one
 * profile runs at a time; switching means changing the profile and restarting.
 */
export interface Profile {
  /**
   * App-level options owned by the profile (`prefix`, `autoAssign`,
   * `autoAuthorize`, ...). Merged over the options shared by every profile.
   */
  appOptions(env: NodeJS.ProcessEnv): Partial<Context.Config>
  /** Install adapters and plugins. Server and database are already installed. */
  install(app: App): void | Promise<void>
}
