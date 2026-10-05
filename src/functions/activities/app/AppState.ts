import type { AppDashboardData, Promotion } from '../../../interface/AppDashBoardData'
import { appProgressFields, isCurrentAppDailySetCandidate } from '../../../../promotion-classification.cjs'

export interface AppProgress {
    earned: number
    max: number
    remaining: number
    complete: boolean
    promotion: Promotion | null
}

export function isDailySetPromotion(promotion: Promotion): boolean {
    const attrs = promotion.attributes ?? {}
    return Boolean(attrs.daily_set_date)
}

export function progressOf(promotion: Promotion | null): AppProgress {
    if (!promotion) return { earned: 0, max: 0, remaining: 0, complete: false, promotion: null }

    const attrs = promotion.attributes ?? {}
    const { max, progress: earned, complete } = appProgressFields(attrs)

    return { earned, max, remaining: Math.max(0, max - earned), complete, promotion }
}

export function findAppSearch(data: AppDashboardData): AppProgress {
    const promotions = data.response?.promotions ?? []
    const level = promotions.find(promotion => promotion.name === 'level_info')?.attributes?.level?.toLowerCase() ?? ''
    const candidates = promotions.filter(promotion => {
        const attrs = promotion.attributes ?? {}
        return (
            attrs.type?.toLowerCase() === 'search' &&
            attrs.give_eligible?.toLowerCase() !== 'false' &&
            attrs.hidden?.toLowerCase() !== 'true' &&
            appProgressFields(attrs).max > 0
        )
    })

    const levelMatch = level
        ? candidates.find(promotion => `${promotion.name ?? ''} ${promotion.attributes.offerid ?? ''}`.toLowerCase().includes(level))
        : undefined
    const selected = levelMatch ?? candidates.sort((a, b) => b.priority - a.priority)[0] ?? null
    return progressOf(selected)
}

export function findReadToEarn(data: AppDashboardData): AppProgress {
    const promotion =
        (data.response?.promotions ?? []).find(item => {
            const attrs = item.attributes ?? {}
            return attrs.type?.toLowerCase() === 'msnreadearn'
        }) ?? null
    return progressOf(promotion)
}

export function findPromotionByOfferId(data: AppDashboardData, offerId: string): AppProgress {
    const promotion =
        (data.response?.promotions ?? []).find(item => item.attributes?.offerid === offerId) ?? null
    return progressOf(promotion)
}

export function resolveAppDailySetDate(data: AppDashboardData): string | null {
    const promotions = data.response?.promotions ?? []
    const marketTime = promotions.find(promotion => promotion.name === 'BingFlyout_Layout_DailyCheckIn')
        ?.attributes?.markettime
    const stamp = String(marketTime ?? '').match(/^(\d{4})(\d{2})(\d{2})T/)
    if (stamp) {
        const appDate = `${stamp[2]}/${stamp[3]}/${stamp[1]}`
        return promotions.some(promotion => promotion.attributes?.daily_set_date === appDate) ? appDate : null
    }

    const dateMap = new Map<string, number>()
    for (const p of promotions) {
        const dsDate = p.attributes?.daily_set_date
        const offerId = p.attributes?.offerid || p.name || ''
        if (dsDate && /_Child[123]$/i.test(offerId)) {
            dateMap.set(dsDate, (dateMap.get(dsDate) || 0) + 1)
        }
    }
    const completeDates = Array.from(dateMap.entries())
        .filter(([_, count]) => count >= 3)
        .map(([date]) => date)
        .sort((a, b) => {
            const [am = 0, ad = 0, ay = 0] = a.split('/').map(Number)
            const [bm = 0, bd = 0, by = 0] = b.split('/').map(Number)
            return new Date(ay, am - 1, ad).getTime() - new Date(by, bm - 1, bd).getTime()
        })

    return completeDates[0] ?? null
}

export function findMobileDailySet(data: AppDashboardData, appDate: string): Promotion[] {
    return (data.response?.promotions ?? []).filter(promotion => isCurrentAppDailySetCandidate(promotion, appDate))
}

export function findAppPromotions(data: AppDashboardData): Promotion[] {
    return (data.response?.promotions ?? []).filter(promotion => {
        const attrs = promotion.attributes ?? {}
        const name = promotion.name?.toLowerCase() ?? ''
        const type = attrs.type?.toLowerCase() ?? ''
        const isDailySet = isDailySetPromotion(promotion)
        const excluded = ['impression', 'trialuser', 'progress_info', '_info', 'userwarning']
            .some(marker => name.includes(marker))

        return (
            (type === 'urlreward' || type === 'sapphire') &&
            !isDailySet &&
            !excluded &&
            Boolean(attrs.offerid) &&
            attrs.give_eligible?.toLowerCase() !== 'false' &&
            attrs.hidden?.toLowerCase() !== 'true' &&
            progressOf(promotion).max > 0
        )
    })
}
