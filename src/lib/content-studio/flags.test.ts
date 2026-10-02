/** @jest-environment node */
import {
  enabledSocialPlatforms,
  isContentStudioEnabled,
  isEmailBridgeEnabled,
  isEmailDynamicEnabled,
  isSocialPlatformEnabled,
} from './flags'

describe('content studio flags', () => {
  it('are off unless explicitly true', () => {
    expect(isContentStudioEnabled({})).toBe(false)
    expect(isContentStudioEnabled({ CONTENT_STUDIO_ENABLED: 'yes' })).toBe(false)
    expect(isContentStudioEnabled({ CONTENT_STUDIO_ENABLED: ' TRUE ' })).toBe(true)
    expect(isEmailBridgeEnabled({})).toBe(false)
    expect(isEmailBridgeEnabled({ CONTENT_EMAIL_BRIDGE_ENABLED: 'true' })).toBe(true)
    expect(isEmailDynamicEnabled({})).toBe(false)
    expect(isEmailDynamicEnabled({ CONTENT_EMAIL_DYNAMIC_ENABLED: 'true' })).toBe(true)
  })

  it('enables only named, known social platforms', () => {
    expect(enabledSocialPlatforms({})).toEqual([])
    expect(enabledSocialPlatforms({ CONTENT_SOCIAL_PLATFORMS: ' LinkedIn, facebook ,tiktok' })).toEqual([
      'facebook',
      'linkedin',
    ])
    expect(isSocialPlatformEnabled('instagram', { CONTENT_SOCIAL_PLATFORMS: 'facebook' })).toBe(false)
    expect(isSocialPlatformEnabled('facebook', { CONTENT_SOCIAL_PLATFORMS: 'facebook' })).toBe(true)
  })

  it('read process.env by default', () => {
    const original = process.env
    process.env = { ...original, CONTENT_STUDIO_ENABLED: 'true', CONTENT_SOCIAL_PLATFORMS: 'instagram' }
    try {
      expect(isContentStudioEnabled()).toBe(true)
      expect(enabledSocialPlatforms()).toEqual(['instagram'])
      expect(isSocialPlatformEnabled('instagram')).toBe(true)
      expect(isEmailBridgeEnabled()).toBe(false)
      expect(isEmailDynamicEnabled()).toBe(false)
    } finally {
      process.env = original
    }
  })
})
