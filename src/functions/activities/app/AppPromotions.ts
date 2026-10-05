import { BaseActivity } from '../BaseActivity'
import type { AppDashboardData } from '../../../interface/AppDashBoardData'
import type { BasePromotion } from '../../../interface/DashboardData'
import { findAppPromotions, progressOf } from './AppState'
import {
    isExploreOnBingPromotion,
    isAppInteractivePromotion,
    isTomorrowLockedPromotion,
    isManualKeepEarningPromotion
} from '../../../../promotion-classification.cjs'

export class AppPromotions extends BaseActivity {
    public async run(data: AppDashboardData): Promise<void> {
        const allPromotions = findAppPromotions(data)
        const pending = allPromotions.filter(promotion => !progressOf(promotion).complete)

        if (!pending.length) {
            this.bot.logger.info(
                this.bot.isMobile,
                'APP-PROMOTIONS',
                'All "App Promotions" items have already been completed'
            )
            return
        }

        this.bot.logger.info(
            this.bot.isMobile,
            'APP-PROMOTIONS',
            `Started solving "App Promotions" items | remaining=${pending.length}`
        )
        let consecutiveZeroGainCount = 0
        for (const [index, promotion] of pending.entries()) {
            const offerId = promotion.attributes.offerid
            const fresh = await this.bot.browser.func.getAppDashboardData()
            const freshPromos = findAppPromotions(fresh)
            const current = freshPromos.find(item => item.attributes.offerid === offerId)
            if (!current) {
                this.bot.logger.warn(
                    this.bot.isMobile,
                    'APP-PROMOTIONS',
                    `[PLAN] appPromotion skip_state_unavailable offerId=${offerId}`
                )
                continue
            }
            if (progressOf(current).complete) {
                this.bot.logger.info(
                    this.bot.isMobile,
                    'APP-PROMOTIONS',
                    `[PLAN] appPromotion skip_complete offerId=${offerId}`
                )
                continue
            }

            if (isTomorrowLockedPromotion(current)) {
                this.bot.logger.info(
                    this.bot.isMobile,
                    'APP-PROMOTIONS',
                    `[PLAN] appPromotion skip_tomorrow_locked offerId=${offerId}`
                )
                continue
            }

            if (isExploreOnBingPromotion(current)) {
                // 若连续多次探索搜索均未产生任何积分，说明已触及微软云端真实冷却限制
                if (consecutiveZeroGainCount >= 2) {
                    this.bot.logger.info(
                        this.bot.isMobile,
                        'APP-PROMOTIONS',
                        `[PLAN] appPromotion skip_cooldown_reached | Explore on Bing cloud cooldown or limit reached after consecutive zero gains, skipping | offerId=${offerId}`
                    )
                    continue
                }

                if (typeof this.bot.activities?.doSearchOnBing === 'function' && this.bot.config?.activities?.searchOnBing !== false) {
                    this.bot.logger.info(
                        this.bot.isMobile,
                        'APP-PROMOTIONS',
                        `Found Explore on Bing activity | title="${current.attributes.title || current.name}" | offerId=${offerId}`
                    )

                    const progress = progressOf(current)
                    const basePromo: BasePromotion = {
                        name: current.name,
                        priority: current.priority,
                        attributes: current.attributes,
                        offerId,
                        complete: progress.complete,
                        counter: 0,
                        activityProgress: progress.earned,
                        activityProgressMax: progress.max,
                        pointProgressMax: progress.max,
                        pointProgress: progress.earned,
                        promotionType: current.attributes.type || 'urlreward',
                        promotionSubtype: '',
                        title: current.attributes.title || current.name,
                        extBannerTitle: '',
                        destinationUrl: current.attributes.destination_url || current.attributes.destinationUrl || current.attributes.destination || current.attributes.url || ''
                    } as unknown as BasePromotion

                    const page = this.bot.isMobile ? this.bot.mainMobilePage : this.bot.mainDesktopPage
                    const startBalance = Number(this.bot.userData.currentPoints ?? 0)
                    const result = await this.bot.activities.doSearchOnBing(basePromo, page)
                    const gained = Number(this.bot.userData.currentPoints ?? 0) - startBalance

                    if (result || gained > 0) {
                        consecutiveZeroGainCount = 0
                    } else {
                        consecutiveZeroGainCount += 1
                        this.bot.logger.info(
                            this.bot.isMobile,
                            'APP-PROMOTIONS',
                            `[PLAN] Explore on Bing search yielded 0 points | offerId=${offerId} | consecutiveZeroGainCount=${consecutiveZeroGainCount}`
                        )
                    }

                    if (index < pending.length - 1) {
                        await this.bot.utils.wait(this.bot.utils.randomDelay(5000, 15000))
                    }
                    continue
                }

                this.bot.logger.info(
                    this.bot.isMobile,
                    'APP-PROMOTIONS',
                    `[PLAN] appPromotion skip_manual_app_interaction offerId=${offerId}`
                )
                continue
            }

            if (isManualKeepEarningPromotion(current)) {
                const reason = isAppInteractivePromotion(current)
                    ? 'skip_manual_app_interaction'
                    : 'skip_manual_required'
                this.bot.logger.info(
                    this.bot.isMobile,
                    'APP-PROMOTIONS',
                    `[PLAN] appPromotion ${reason} offerId=${offerId}`
                )
                continue
            }
            await this.bot.activities.doAppReward(current)
            if (index < pending.length - 1) {
                await this.bot.utils.wait(this.bot.utils.randomDelay(5000, 15000))
            }
        }
        this.bot.logger.info(this.bot.isMobile, 'APP-PROMOTIONS', 'Finished processing "App Promotions" items')
    }
}
