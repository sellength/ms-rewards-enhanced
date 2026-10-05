import { URLs } from '../../../constants/urls'
import type { BasePromotion, DashboardData } from '../../../interface/DashboardData'
import { BaseActivity } from '../BaseActivity'

export class UrlReward extends BaseActivity {
    public async doUrlReward(promotion: BasePromotion): Promise<boolean> {
        return await this.runUrlReward(promotion, true)
    }

    private async runUrlReward(promotion: BasePromotion, allowSessionRepair: boolean): Promise<boolean> {
        const offerId = promotion.offerId

        const actionId = this.bot.nextActions.reportActivity
        if (!actionId) {
            this.bot.logger.warn(
                this.bot.isMobile,
                'URL-REWARD',
                `Skipping ${offerId}: "reportActivity" not discovered in bundle`
            )
            return false
        }

        const live = await this.bot.browser.func.ensureOffer(offerId)
        const hash = live?.hash || promotion.hash || null
        const isCompleted = live?.isCompleted || this.isPromotionComplete(promotion)
        const isLocked = live?.isLocked || promotion.exclusiveLockedFeatureStatus === 'locked'

        if (isCompleted) {
            this.bot.logger.info(this.bot.isMobile, 'URL-REWARD', `Skipping ${offerId}: already completed`)
            return true
        }
        if (isLocked) {
            this.bot.logger.warn(this.bot.isMobile, 'URL-REWARD', `Skipping ${offerId}: offer is locked`)
            return false
        }
        if (!hash) {
            this.bot.logger.warn(
                this.bot.isMobile,
                'URL-REWARD',
                `No reportable hash for ${offerId}; trying the destination and verifying the cloud state`
            )
            return await this.visitDestinationAndVerify(promotion)
        }

        const expectedPoints = live?.points || promotion.pointProgressMax || 0
        if (this.bot.config.skipNonPointTasks && expectedPoints === 0) {
            this.bot.logger.info(
                this.bot.isMobile,
                'URL-REWARD',
                `Skipping ${offerId}: awards no points (points=${expectedPoints}${live?.promotionSubtype ? ` subtype=${live.promotionSubtype}` : ''}) - likely a free trial/non-crediting offer. Set skipNonPointTasks=false to attempt anyway.`
            )
            return false
        }

        const oldBalance = this.bot.userData.currentPoints

        const dashboardActivityType = Number(promotion.activityType)
        const activityType =
            live?.activityType ??
            (Number.isInteger(dashboardActivityType) && dashboardActivityType > 0 ? dashboardActivityType : 11)

        this.bot.logger.info(
            this.bot.isMobile,
            'URL-REWARD',
            `Starting UrlReward | offerId=${offerId} | geo=${this.bot.userData.geoLocale} | currentBalance=${oldBalance}`
        )

        try {
            const { status, acknowledged, availablePoints } = await this.bot.browser.func.reportServerAction(
                actionId,
                [
                    hash,
                    activityType,
                    {
                        offerid: offerId,
                        isPromotional: live?.isPromotional ? true : '$undefined',
                        timezoneOffset: this.bot.userData.timezoneOffset
                    }
                ]
            )

            if (!acknowledged) {
                this.bot.logger.warn(
                    this.bot.isMobile,
                    'URL-REWARD',
                    `UrlReward request was not acknowledged | offerId=${offerId} | status=${status}`
                )
                if (await this.retryAfterRequestFailure(promotion, allowSessionRepair)) return true
                return await this.visitDestinationAndVerify(promotion)
            }

            const newBalance = availablePoints ?? (await this.bot.browser.func.getCurrentPoints())
            const gainedPoints = newBalance - oldBalance

            this.bot.logger.debug(
                this.bot.isMobile,
                'URL-REWARD',
                `Response | offerId=${offerId} | status=${status} | acknowledged=${acknowledged} | pointsGained=${gainedPoints} | currentBalance=${newBalance}`
            )

            const verifiedComplete = await this.verifyOfferCompleted(offerId)

            if (verifiedComplete) {
                if (gainedPoints > 0) {
                    this.bot.userData.currentPoints = newBalance
                    this.bot.userData.gainedPoints = (this.bot.userData.gainedPoints ?? 0) + gainedPoints
                } else if (newBalance > 0) {
                    this.bot.userData.currentPoints = newBalance
                }
                const shortfall = expectedPoints > 0 && gainedPoints < expectedPoints && gainedPoints > 0
                this.bot.logger.info(
                    this.bot.isMobile,
                    'URL-REWARD',
                    `Completed UrlReward | offerId=${offerId} | pointsGained=${gainedPoints} | currentBalance=${newBalance}${shortfall ? ' | WARNING: credited less than advertised' : ''}`,
                    'green'
                )
                return true
            } else {
                this.bot.logger.warn(
                    this.bot.isMobile,
                    'URL-REWARD',
                    `UrlReward action acknowledged but offer not verified complete | offerId=${offerId} | acknowledged=${acknowledged} | expected=${expectedPoints} | pointsGained=${gainedPoints} | currentBalance=${newBalance}`
                )
                return await this.visitDestinationAndVerify(promotion, oldBalance)
            }
        } catch (error) {
            this.bot.logger.error(
                this.bot.isMobile,
                'URL-REWARD',
                `Error in doUrlReward | offerId=${offerId} | message=${error instanceof Error ? error.message : String(error)}`
            )
            if (await this.retryAfterRequestFailure(promotion, allowSessionRepair)) return true
            return await this.visitDestinationAndVerify(promotion)
        }
    }

    private async retryAfterRequestFailure(promotion: BasePromotion, allowSessionRepair: boolean): Promise<boolean> {
        if (!allowSessionRepair) return false

        const refreshed = await this.bot.refreshCurrentRewardsContext(`URL-REWARD:${promotion.offerId}`)
        if (!refreshed) return false

        this.bot.logger.info(
            this.bot.isMobile,
            'URL-REWARD',
            `Retrying UrlReward once with refreshed cookies and bootstrap data | offerId=${promotion.offerId}`
        )
        return await this.runUrlReward(promotion, false)
    }

    private async visitDestinationAndVerify(promotion: BasePromotion, baselinePoints?: number): Promise<boolean> {
        const destination = promotion.destinationUrl
        const page = this.bot.isMobile ? this.bot.mainMobilePage : this.bot.mainDesktopPage
        if (!destination || !page) {
            this.bot.logger.warn(
                this.bot.isMobile,
                'URL-REWARD',
                `Cannot use browser fallback for ${promotion.offerId}: destination or active page missing`
            )
            return false
        }

        try {
            this.bot.logger.info(
                this.bot.isMobile,
                'URL-REWARD',
                `Opening destination for ${promotion.offerId}; completion will be checked against Microsoft`
            )

            let clickedInPage = false
            const currentUrl = typeof page.url === 'function' ? page.url() : ''
            if (currentUrl.includes('rewards.bing.com') && typeof page.locator === 'function') {
                try {
                    const card = page.locator(`a[href*="${promotion.offerId}"], a[href="${destination}"]`).first()
                    if (await card.isVisible({ timeout: 1500 }).catch(() => false)) {
                        const context = typeof page.context === 'function' ? page.context() : null
                        const [popup] = await Promise.all([
                            context ? context.waitForEvent('page', { timeout: 5000 }).catch(() => null) : Promise.resolve(null),
                            card.click().catch(() => {})
                        ])
                        clickedInPage = true
                        if (popup) {
                            await popup.waitForLoadState('domcontentloaded', { timeout: 5000 }).catch(() => {})
                            await popup.close().catch(() => {})
                        }
                    }
                } catch {}
            }

            if (!clickedInPage) {
                await page.goto(destination, { waitUntil: 'domcontentloaded', timeout: 20000 })
            }
            await this.bot.utils.wait(this.bot.utils.randomDelay(3000, 6000))

            await this.bot.browser.func.synchronizeActiveBrowserCookies('URL-REWARD-FALLBACK')
            const dashboard = await this.bot.browser.func.getDashboardData()
            const current = this.findPromotion(dashboard, promotion.offerId)
            const complete = current ? this.isPromotionComplete(current) : false
            const newBalance = dashboard.dashboard.userStatus.availablePoints
            const previousBalance = baselinePoints ?? Number(this.bot.userData.currentPoints ?? 0)
            const gainedPoints = Math.max(0, newBalance - previousBalance)

            if (complete) {
                if (gainedPoints > 0) {
                    this.bot.userData.currentPoints = newBalance
                    this.bot.userData.gainedPoints = (this.bot.userData.gainedPoints ?? 0) + gainedPoints
                } else if (newBalance > 0) {
                    this.bot.userData.currentPoints = newBalance
                }
                this.bot.logger.info(
                    this.bot.isMobile,
                    'URL-REWARD',
                    `Browser fallback verified by Microsoft | offerId=${promotion.offerId} | progress=${current?.pointProgress ?? '?'} / ${current?.pointProgressMax ?? '?'} | pointsGained=${gainedPoints}`,
                    'green'
                )
                return true
            }

            this.bot.logger.warn(
                this.bot.isMobile,
                'URL-REWARD',
                `Destination opened but Microsoft still reports incomplete | offerId=${promotion.offerId}`
            )
            return false
        } catch (error) {
            this.bot.logger.warn(
                this.bot.isMobile,
                'URL-REWARD',
                `Browser fallback failed | offerId=${promotion.offerId} | message=${error instanceof Error ? error.message : String(error)}`
            )
            return false
        } finally {
            const finalUrl = typeof page.url === 'function' ? page.url() : ''
            if (finalUrl && finalUrl !== URLs.rewards.earn && !finalUrl.includes('rewards.bing.com')) {
                await page.goto(URLs.rewards.earn, { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {})
            }
        }
    }

    private async verifyOfferCompleted(offerId: string): Promise<boolean> {
        if (typeof this.bot.browser?.func?.getDashboardData === 'function') {
            try {
                const dashboard = await this.bot.browser.func.getDashboardData()
                if (dashboard) {
                    const current = this.findPromotion(dashboard, offerId)
                    if (current && this.isPromotionComplete(current)) {
                        return true
                    }
                }
            } catch {}
        }
        if (typeof this.bot.browser?.func?.ensureOffer === 'function') {
            try {
                const live = await this.bot.browser.func.ensureOffer(offerId)
                if (live?.isCompleted) {
                    return true
                }
            } catch {}
        }
        return false
    }

    private findPromotion(data: DashboardData, offerId: string): BasePromotion | undefined {
        const dashboard = data.dashboard
        return [
            ...Object.values(dashboard.dailySetPromotions ?? {}).flat(),
            ...(dashboard.morePromotions ?? []),
            ...(dashboard.morePromotionsWithoutPromotionalItems ?? []),
            ...(dashboard.promotionalItems ?? []),
            ...(dashboard.promotionalItem ? [dashboard.promotionalItem] : [])
        ].find(item => item.offerId === offerId)
    }

    private isPromotionComplete(promotion: BasePromotion): boolean {
        return (
            promotion.complete ||
            (promotion.pointProgressMax > 0 && promotion.pointProgress >= promotion.pointProgressMax)
        )
    }
}
