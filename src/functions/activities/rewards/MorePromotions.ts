import { BaseActivity } from '../BaseActivity'
import type { BasePromotion, DashboardData } from '../../../interface/DashboardData'
import { PromotionActivityRunner } from './PromotionActivityRunner'
import {
    isManualKeepEarningPromotion,
    isTomorrowLockedPromotion,
    selectPcKeepEarningPromotions
} from '../../../../promotion-classification.cjs'

export class MorePromotions extends BaseActivity {
    public async run(data: DashboardData): Promise<void> {
        const attemptedOfferIds = new Set<string>()
        let current = data
        let visibleOfferIds: string[] | null = null

        for (let pass = 1; pass <= 3; pass++) {
            visibleOfferIds = await this.bot.browser.func.getKeepEarningOfferIds()
            if (visibleOfferIds === null) {
                this.bot.logger.warn(this.bot.isMobile, 'MORE-PROMOTIONS',
                    '[PLAN] promotions skip_state_unavailable reason=earn_collection_unavailable')
                return
            }
            const promotions = this.getPromotions(current, visibleOfferIds)

            this.bot.logger.info(
                this.bot.isMobile,
                'PROMOTIONS-DUMP',
                JSON.stringify({
                    pass,
                    promotions: promotions.map(p => ({
                        title: p.title || p.name,
                        points: `${p.pointProgress || 0}/${p.pointProgressMax || 0}`,
                        complete: Boolean(
                            p.complete || (p.pointProgressMax > 0 && p.pointProgress >= p.pointProgressMax)
                        ),
                        type: p.promotionType,
                        offerId: p.offerId
                    }))
                })
            )

            promotions
                .filter(promotion => this.isPendingReward(promotion) && isTomorrowLockedPromotion(promotion))
                .filter(promotion => !attemptedOfferIds.has(promotion.offerId))
                .forEach(promotion => {
                    attemptedOfferIds.add(promotion.offerId)
                    this.bot.logger.info(
                        this.bot.isMobile,
                        'MORE-PROMOTIONS',
                        `[PLAN] promotion skip_tomorrow_locked offerId=${promotion.offerId}`
                    )
                })

            promotions
                .filter(promotion => this.isPendingReward(promotion) && isManualKeepEarningPromotion(promotion))
                .filter(promotion => !attemptedOfferIds.has(promotion.offerId))
                .forEach(promotion => {
                    attemptedOfferIds.add(promotion.offerId)
                    this.bot.logger.info(
                        this.bot.isMobile,
                        'MORE-PROMOTIONS',
                        `[PLAN] promotion skip_manual_required offerId=${promotion.offerId}`
                    )
                })

            const pending = promotions.filter(
                promotion => this.isActionable(promotion) && !attemptedOfferIds.has(promotion.offerId)
            )
            if (!pending.length) {
                this.logVerifiedState(promotions)
                return
            }

            this.bot.logger.info(
                this.bot.isMobile,
                'MORE-PROMOTIONS',
                `Started solving "More Promotions" items | pass=${pass}/3 | remaining=${pending.length}`
            )
            pending.forEach(promotion => attemptedOfferIds.add(promotion.offerId))
            await new PromotionActivityRunner(this.bot).run(pending)

            try {
                await this.bot.utils.wait(1000)
                current = await this.bot.browser.func.getDashboardData()
            } catch (error) {
                this.bot.logger.warn(
                    this.bot.isMobile,
                    'MORE-PROMOTIONS',
                    `Unable to refresh the official promotion collection after pass ${pass}; stopping safely | message=${
                        error instanceof Error ? error.message : String(error)
                    }`
                )
                return
            }
        }

        this.logVerifiedState(this.getPromotions(current, visibleOfferIds))
    }

    private getPromotions(data: DashboardData, visibleOfferIds: string[] | null): BasePromotion[] {
        const dailySetItems = this.bot.dailySetDate
            ? (data.dashboard.dailySetPromotions?.[this.bot.dailySetDate] ?? [])
            : []
        return selectPcKeepEarningPromotions(
            [
                ...(data.dashboard.morePromotions ?? []),
                ...(data.dashboard.morePromotionsWithoutPromotionalItems ?? [])
            ].filter(Boolean) as BasePromotion[],
            dailySetItems,
            visibleOfferIds
        )
    }

    private logVerifiedState(promotions: BasePromotion[]): void {
        const remaining = promotions.filter(promotion => this.isPendingReward(promotion))
        if (remaining.length) {
            this.bot.logger.info(
                this.bot.isMobile,
                'MORE-PROMOTIONS',
                `Microsoft still reports pending "More Promotions" items | remaining=${remaining
                    .map(promotion => promotion.offerId)
                    .join(', ')}`
            )
        } else {
            this.bot.logger.info(
                this.bot.isMobile,
                'MORE-PROMOTIONS',
                'All "More Promotions" items are complete according to the latest Microsoft collection',
                'green'
            )
        }
    }

    private isActionable(promotion: BasePromotion): boolean {
        if (!this.isPendingReward(promotion)) return false
        if (isTomorrowLockedPromotion(promotion)) return false
        if (isManualKeepEarningPromotion(promotion)) return false
        if (promotion.exclusiveLockedFeatureStatus === 'locked') return false
        return true
    }

    private isPendingReward(promotion: BasePromotion): boolean {
        if (promotion.complete) return false
        const max = promotion.pointProgressMax || 0
        const cur = promotion.pointProgress || 0
        if (max <= 0) return false
        if (max > 0 && cur >= max) return false
        return true
    }
}
