import * as fs from 'fs'
import path from 'path'

import { URLs } from '../../../constants/urls'
import type { BasePromotion, Dashboard } from '../../../interface/DashboardData'
import type { MicrosoftRewardsBot } from '../../../index'

import type { Page } from 'patchright'

interface ActivityQueries {
    title: string
    queries: string[]
}

export async function activateSearchOnBing(bot: MicrosoftRewardsBot, promotion: BasePromotion, page?: Page): Promise<boolean> {
    const offerId = promotion.offerId

    const attrs = (promotion.attributes ?? {}) as Record<string, unknown>
    const isAct = (promotion as unknown as { isActivated?: boolean }).isActivated === true || attrs.isActivated === true || String(attrs.isActivated || '').toLowerCase() === 'true'
    if (isAct || String(attrs.isInProgress || '').toLowerCase() === 'true') {
        bot.logger.info(
            bot.isMobile,
            'SEARCH-ON-BING-ACTIVATE',
            `Activity is already in activated state in cloud | offerId=${offerId}`,
            'cyan'
        )
        return true
    }

    if (bot.isMobile || bot.accessToken) {
        try {
            const appData = await bot.browser.func.getAppDashboardData().catch(() => null)
            if (appData) {
                const { submitAppActivity } = await import('../app/AppActivity')
                const appPromo = {
                    name: (promotion as unknown as { name?: string }).name || offerId,
                    priority: (promotion as unknown as { priority?: number }).priority || 0,
                    attributes: {
                        ...((promotion.attributes as Record<string, string>) || {}),
                        offerid: offerId
                    },
                    tags: []
                }
                const res = await submitAppActivity(bot, appPromo, appData)
                bot.logger.info(
                    bot.isMobile,
                    'SEARCH-ON-BING-ACTIVATE',
                    `Activated activity via App API | offerId=${offerId} | status=${res.status}`
                )
                if (res.status === 200) {
                    return true
                }
            }
        } catch (error) {
            bot.logger.warn(
                bot.isMobile,
                'SEARCH-ON-BING-ACTIVATE',
                `App API activation failed, falling back | offerId=${offerId} | message=${error instanceof Error ? error.message : String(error)}`
            )
        }
    }

    const actionId = bot.nextActions?.reportActivity

    if (actionId) {
        const live = await bot.browser.func.ensureOffer(offerId)
        const hash = live?.hash ?? promotion.hash ?? null
        if (hash) {
            try {
                const { status, acknowledged } = await bot.browser.func.reportServerAction(actionId, [
                    hash,
                    11,
                    {
                        offerid: offerId,
                        isPromotional: '$undefined',
                        timezoneOffset: bot.userData.timezoneOffset
                    }
                ])

                bot.logger.info(
                    bot.isMobile,
                    'SEARCH-ON-BING-ACTIVATE',
                    `Activated activity via RPC | offerId=${offerId} | status=${status} | acknowledged=${acknowledged}`
                )
                if (acknowledged) return true
            } catch (error) {
                bot.logger.warn(
                    bot.isMobile,
                    'SEARCH-ON-BING-ACTIVATE',
                    `RPC activation failed, falling back to browser navigation | offerId=${offerId} | message=${error instanceof Error ? error.message : String(error)}`
                )
            }
        }
    }

    if (page) {
        const rawAttrs = (promotion.attributes as Record<string, string>) || {}
        const dest = (promotion.destinationUrl || rawAttrs.destination_url || rawAttrs.destinationUrl || rawAttrs.destination || rawAttrs.url || '').trim()
        const targetUrl = dest && dest.startsWith('http')
            ? dest
            : 'https://www.bing.com/?form=ML2PCR&OCID=ML2PCR&PUBL=RewardsDO&CREA=ML2PCR&PC=ML2PCR&rwAutoFlyout=exb'

        bot.logger.info(
            bot.isMobile,
            'SEARCH-ON-BING-ACTIVATE',
            `Activating activity via browser navigation | offerId=${offerId} | url=${targetUrl}`
        )
        try {
            await page.goto(targetUrl, { timeout: 20000, waitUntil: 'domcontentloaded' }).catch(() => {})
            await bot.utils.wait(bot.utils.randomDelay(2000, 3500))
            await bot.browser.utils.tryDismissAllMessages(page)
            return true
        } catch (err) {
            bot.logger.warn(
                bot.isMobile,
                'SEARCH-ON-BING-ACTIVATE',
                `Browser navigation activation warning | offerId=${offerId} | message=${err instanceof Error ? err.message : String(err)}`
            )
            return true
        }
    }

    bot.logger.warn(
        bot.isMobile,
        'SEARCH-ON-BING-ACTIVATE',
        `Skipping ${offerId}: "reportActivity" not discovered and no browser page available`
    )
    return false
}

export function findSearchOnBingOffer(dashboard: Dashboard, offerId: string): BasePromotion | undefined {
    const offers = [
        ...Object.values(dashboard.dailySetPromotions ?? {}).flat(),
        ...(dashboard.morePromotions ?? []),
        ...(dashboard.promotionalItems ?? []),
        ...(dashboard.promotionalItem ? [dashboard.promotionalItem] : [])
    ]
    return offers.find(offer => offer.offerId === offerId)
}

export async function getSearchOnBingQueries(bot: MicrosoftRewardsBot, promotion: BasePromotion): Promise<string[]> {
    try {
        let activities: ActivityQueries[] = []

        const localQueriesPath = path.join(__dirname, '../../bing-search-activity-queries.json')
        if (bot.config.searchOnBingLocalQueries || fs.existsSync(localQueriesPath)) {
            try {
                activities = JSON.parse(fs.readFileSync(localQueriesPath, 'utf8')) as ActivityQueries[]
            } catch {}
        }

        if (!activities.length) {
            try {
                activities = (
                    await bot.http.request<ActivityQueries[]>({
                        method: 'GET',
                        url: URLs.github.searchOnBingQueries
                    })
                ).data
            } catch {}
        }

        const match = activities.find(
            activity => bot.utils.normalizeString(activity.title) === bot.utils.normalizeString(promotion.title)
        )
        if (match?.queries.length) {
            const shuffled = bot.utils.shuffleArray(match.queries)
            bot.logger.info(
                bot.isMobile,
                'SEARCH-ON-BING-QUERY',
                `Found ${shuffled.length} queries for "${promotion.title}"`
            )
            return shuffled
        }

        bot.logger.info(
            bot.isMobile,
            'SEARCH-ON-BING-QUERY',
            `No curated queries for "${promotion.title}", falling back to the activity title and description`
        )
        return fallbackQueries(promotion)
    } catch (error) {
        bot.logger.error(
            bot.isMobile,
            'SEARCH-ON-BING-QUERY',
            `Error resolving search queries | title="${promotion.title}" | message=${error instanceof Error ? error.message : String(error)} | fallback=titleAndDescription`
        )
        return fallbackQueries(promotion)
    }
}

function fallbackQueries(promotion: BasePromotion): string[] {
    const title = (promotion.title ?? '').trim()
    const description = (promotion.description ?? '').trim()
    const derived = extractSearchTerm(description)
    return [...new Set([derived, title, description].map(value => value.trim()).filter(Boolean))]
}

// Microsoft currently supplies English instruction prefixes for this fallback path.
function extractSearchTerm(description: string): string {
    if (!description) return ''

    return description
        .trim()
        .replace(
            /^\s*(?:search(?:\s+on\s+bing|\s+bing|\s+the\s+web)?\s+for|look\s+up|find|explore|discover)\b[\s:]+/i,
            ''
        )
        .replace(/^["'“”‘’]+|["'“”‘’]+$/g, '')
        .replace(/[.!?]+$/g, '')
        .trim()
}
