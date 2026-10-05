import type { MicrosoftRewardsBot } from '../../../index'
import { BING_APP_CHANNEL, BING_APP_USER_AGENT, BING_APP_VERSION } from '../../../constants/userAgents'

export function buildAppHeaders(
    bot: MicrosoftRewardsBot,
    contentType = false,
    overrides: { country?: string; language?: string; sapphireId?: string; sessionId?: string } = {}
): Record<string, string> {
    return {
        Authorization: `Bearer ${bot.accessToken}`,
        'User-Agent': BING_APP_USER_AGENT,
        'X-Rewards-AppId': `${BING_APP_CHANNEL}/${BING_APP_VERSION}`,
        'X-Rewards-PartnerId': 'startapp',
        'X-Rewards-Country': overrides.country ?? bot.userData.geoLocale,
        'X-Rewards-Language': overrides.language ?? bot.userData.langCode,
        'X-Rewards-Flights': 'rwgobig',
        'X-Rewards-IsMobile': 'true',
        ...(overrides.sapphireId ? { 'sapphire-id': overrides.sapphireId } : {}),
        ...(overrides.sessionId ? { 'session-id': overrides.sessionId } : {}),
        ...(overrides.sessionId ? { os: 'android' } : {}),
        ...(contentType ? { 'Content-Type': 'application/json', Accept: '*/*' } : {})
    }
}
