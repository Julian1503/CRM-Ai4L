import 'server-only'

import { SOCIAL_PLATFORMS, type SocialPlatform } from './types'

/**
 * Content Studio feature flags (docs/CONTENT_STUDIO_CONTRACTS.md §5). Read at call time
 * so a deployment toggles them without a rebuild, and disabled unless explicitly `true`:
 * an unset or misspelt flag switches the feature off rather than on.
 */

type Env = Record<string, string | undefined>

function isTrue(value: string | undefined): boolean {
  return value?.trim().toLowerCase() === 'true'
}

/** The tab, and every new request (creating, generating, uploading, publishing). */
export function isContentStudioEnabled(env: Env = process.env): boolean {
  return isTrue(env.CONTENT_STUDIO_ENABLED)
}

/** Networks that may be published to. Empty (the default) means none. Unknown names are ignored. */
export function enabledSocialPlatforms(env: Env = process.env): SocialPlatform[] {
  const requested = (env.CONTENT_SOCIAL_PLATFORMS ?? '')
    .split(',')
    .map((entry) => entry.trim().toLowerCase())

  return SOCIAL_PLATFORMS.filter((platform) => requested.includes(platform))
}

export function isSocialPlatformEnabled(platform: string, env: Env = process.env): boolean {
  return (enabledSocialPlatforms(env) as string[]).includes(platform)
}

/** Creating an email draft / HTML export from the Studio. */
export function isEmailBridgeEnabled(env: Env = process.env): boolean {
  return isTrue(env.CONTENT_EMAIL_BRIDGE_ENABLED)
}

/** Dynamic, field-based EmailOctopus automation. Off until the provider matrix passes. */
export function isEmailDynamicEnabled(env: Env = process.env): boolean {
  return isTrue(env.CONTENT_EMAIL_DYNAMIC_ENABLED)
}
