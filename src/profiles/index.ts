import type { Profile } from './types'

/**
 * Known profiles. A static map of lazy imports (never a path built from user
 * input), so only the selected profile's dependencies get loaded.
 */
export const PROFILES = {
  v4: () => import('./v4'),
} satisfies Record<string, () => Promise<{ default: Profile }>>

export type ProfileName = keyof typeof PROFILES

export const DEFAULT_PROFILE: ProfileName = 'v4'

/**
 * Priority: `--profile=<name>` argument, then `SILI_PROFILE`, then the default.
 * Unknown names throw (fail-fast) and list the available profiles.
 */
export function resolveProfileName(
  argv: readonly string[],
  env: NodeJS.ProcessEnv
): ProfileName {
  const flag = argv.find((arg) => arg.startsWith('--profile='))
  const name = flag?.slice('--profile='.length) || env.SILI_PROFILE || DEFAULT_PROFILE
  if (!Object.hasOwn(PROFILES, name)) {
    throw new Error(
      `Unknown SILI profile "${name}". Available: ${Object.keys(PROFILES).join(', ')}`
    )
  }
  return name as ProfileName
}

export async function loadProfile(name: ProfileName): Promise<Profile> {
  return (await PROFILES[name]()).default
}
