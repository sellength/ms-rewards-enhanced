import { constants as cryptoConstants, publicEncrypt, randomUUID } from 'node:crypto'

import type { MicrosoftRewardsBot } from '../../../index'
import type { AppDashboardData, Profile, Promotion, Response } from '../../../interface/AppDashBoardData'
import type { HttpRequestConfig } from '../../../util/Http'
import { getOrCreateMobileDeviceId, getOrCreateMobileSapphireId } from '../../../util/SessionStore'
import { URLs } from '../../../constants/urls'
import { BING_APP_CHANNEL } from '../../../constants/userAgents'
import { buildAppHeaders } from './AppRequest'

const DEFAULT_REWARDS_REDEEM_PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAzvymntj521v4icYDUhEP
8LOfrgo8qo0OL4oNN8tDp1j/jFgFhW+DkqJtSA1XXxprxi7bXiLKgDnGc9Mp+I/z
T51qaUuCnR3HsBdtxJzvUZTKFCtQ4ldcQHFZGq4EVYRe6PaU8JpW6KBYbpxv52ry
rYxyigMB4Ib0z+RsdJN5k4CXxoPvWSwnDgVG09EQPyuHKqAcb7xL4G7Z6hfZLbMg
+dZ0DYfeMWHVflHoFlb6vM29/CniD/PJjU5RwL9UMIOdhd1Va2q6kN2b5G3jrzsu
MIRpi7YrrozO/L1xLPnUqqcCrVhcyFoC/l8T4AHhFqHHBRxQics6T+TZVp90VMHN
fQIDAQAB
-----END PUBLIC KEY-----`

const activitySessionIds = new WeakMap<MicrosoftRewardsBot, string>()

function getActivitySessionId(bot: MicrosoftRewardsBot): string {
    const existing = activitySessionIds.get(bot)
    if (existing) return existing
    const generated = randomUUID()
    activitySessionIds.set(bot, generated)
    return generated
}

function resolveRedeemPublicKey(explicitKey?: string): string {
    if (explicitKey) return explicitKey
    if (process.env.REWARDS_REDEEM_PUBLIC_KEY_BASE64) {
        return Buffer.from(process.env.REWARDS_REDEEM_PUBLIC_KEY_BASE64, 'base64').toString('utf8')
    }
    if (process.env.REWARDS_REDEEM_PUBLIC_KEY) {
        return process.env.REWARDS_REDEEM_PUBLIC_KEY.replace(/\\n/g, '\n')
    }
    return DEFAULT_REWARDS_REDEEM_PUBLIC_KEY
}

interface AppActivityPayloadInput {
    offerId: string
    country: string
    ruid: string
    deviceId: string
    publicKey?: string
    requestId?: string
    timestamp?: number
}

export interface AppActivityPayload {
    id: string
    amount: number
    type: number
    attributes: { offerid: string }
    country: string
    risk_context: Record<string, never>
    channel: string
    meta: string
}

export function buildAppActivityPayload(input: AppActivityPayloadInput): AppActivityPayload {
    if (!input.offerId || !input.ruid || !input.deviceId) {
        throw new Error('app_activity_context_incomplete')
    }

    const publicKey = resolveRedeemPublicKey(input.publicKey)
    const meta = publicEncrypt(
        { key: publicKey, padding: cryptoConstants.RSA_PKCS1_PADDING },
        Buffer.from(JSON.stringify({
            userId: input.ruid,
            timestamp: input.timestamp ?? Date.now(),
            device_info: {
                isEmulator: false,
                location: { latitude: '', longitude: '' },
                device_id: input.deviceId
            }
        }), 'utf8')
    ).toString('base64')

    return {
        id: input.requestId ?? randomUUID(),
        amount: 1,
        type: 101,
        attributes: { offerid: input.offerId },
        country: input.country,
        risk_context: {},
        channel: BING_APP_CHANNEL,
        meta
    }
}

export async function submitAppActivity(
    bot: MicrosoftRewardsBot,
    promotion: Promotion,
    appData: AppDashboardData
): Promise<{ status: number; balance?: number }> {
    const offerId = promotion.attributes.offerid
    let ruid = appData.response?.profile?.ruid
    if (!ruid) {
        try {
            const profileRes = await bot.http.request<{
                response?: {
                    profile?: {
                        ruid?: string
                        attributes?: { country?: string; [key: string]: unknown }
                    }
                }
            }>({
                url: URLs.platform.profile(BING_APP_CHANNEL),
                method: 'GET',
                headers: buildAppHeaders(bot)
            })
            const fetchedProfile = profileRes.data?.response?.profile
            if (fetchedProfile?.ruid) {
                ruid = fetchedProfile.ruid
                const profileAttributes = (fetchedProfile.attributes ?? {}) as unknown as Profile['attributes']
                if (!appData.response) {
                    appData.response = { profile: { ruid, attributes: profileAttributes, offline_attributes: null } } as unknown as Response
                } else if (!appData.response.profile) {
                    appData.response.profile = { ruid, attributes: profileAttributes, offline_attributes: null }
                } else {
                    appData.response.profile.ruid = ruid
                    if (fetchedProfile.attributes) {
                        appData.response.profile.attributes = {
                            ...appData.response.profile.attributes,
                            ...profileAttributes
                        }
                    }
                }
            }
        } catch {
            // best-effort fallback
        }
    }
    const email = bot.currentAccountEmail
    if (!offerId || !ruid || !email) throw new Error('app_activity_context_incomplete')
    const country = appData.response?.profile?.attributes?.country || bot.userData.geoLocale

    const payload = buildAppActivityPayload({
        offerId,
        country,
        ruid,
        deviceId: getOrCreateMobileDeviceId(bot.config.sessionPath, email)
    })
    const sapphireId = getOrCreateMobileSapphireId(bot.config.sessionPath, email)
    const request: HttpRequestConfig = {
        url: URLs.platform.activities,
        method: 'POST',
        headers: buildAppHeaders(bot, true, {
            country,
            sapphireId,
            sessionId: getActivitySessionId(bot)
        }),
        data: JSON.stringify(payload)
    }
    const response = await bot.http.request<{ response?: { balance?: number } }>(request)
    return { status: response.status, balance: response.data?.response?.balance }
}
