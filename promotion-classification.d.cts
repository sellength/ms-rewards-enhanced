export interface PromotionIdentity {
    offerId?: string
    name?: string | null
    destinationUrl?: string
    attributes?: unknown
}

export function earnKeepEarningIds(html: string): string[] | null
export function edgeWebProgress(text: string): { earned: number; max: number; complete: boolean } | null
export function appProgressFields(attrs?: Record<string, unknown>): { max: number; progress: number; complete: boolean }
export function isCurrentAppDailySetCandidate(promotion: PromotionIdentity, appDate: string): boolean

export function isExploreOnBingPromotion(promotion: PromotionIdentity): boolean

export function isAppInteractivePromotion(promotion: PromotionIdentity): boolean

export function isTomorrowLockedPromotion(promotion: PromotionIdentity): boolean

export function getExploreOnBingStatus(
    promotion: PromotionIdentity,
    sessionState?: {
        activatedOfferIds?: Set<string> | readonly string[]
        activeOfferId?: string | null
    }
): 'tomorrow_locked' | 'completed' | 'activated' | 'pending_activation' | null

export function isInteractiveDailySetDestination(promotion: PromotionIdentity): boolean

export function isManualKeepEarningPromotion(promotion: PromotionIdentity): boolean

export function selectPcKeepEarningPromotions<
    T extends PromotionIdentity,
    U extends PromotionIdentity
>(
    rawPromos?: readonly T[],
    dailySetItems?: readonly U[],
    visibleOfferIds?: readonly string[] | null
): T[]
