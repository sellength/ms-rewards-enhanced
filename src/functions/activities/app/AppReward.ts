import type { Promotion } from '../../../interface/AppDashBoardData'
import { BaseActivity } from '../BaseActivity'
import { submitAppActivity } from './AppActivity'
import { findPromotionByOfferId } from './AppState'

export class AppReward extends BaseActivity {
    private gainedPoints: number = 0

    private oldBalance: number = this.bot.userData.currentPoints

    public async doAppReward(promotion: Promotion) {
        if (!this.bot.accessToken) {
            this.bot.logger.warn(
                this.bot.isMobile,
                'APP-REWARD',
                'Skipping: App access token not available, this activity requires it!'
            )
            return
        }

        const offerId = promotion.attributes['offerid']
        if (!offerId) {
            this.bot.logger.warn(this.bot.isMobile, 'APP-REWARD', 'Skipping AppReward without an offerId')
            return
        }

        this.bot.logger.info(
            this.bot.isMobile,
            'APP-REWARD',
            `Starting AppReward | offerId=${offerId} | country=${this.bot.userData.geoLocale} | currentBalance=${this.oldBalance}`
        )

        try {
            const appData = await this.bot.browser.func.getAppDashboardData()
            const response = await submitAppActivity(this.bot, promotion, appData)

            this.bot.logger.debug(
                this.bot.isMobile,
                'APP-REWARD',
                `Received activity response | offerId=${offerId} | status=${response.status}`
            )

            const newBalance = Number(response.balance ?? this.oldBalance)
            this.gainedPoints = newBalance - this.oldBalance
            await this.bot.utils.wait(750)
            const verified = findPromotionByOfferId(
                await this.bot.browser.func.getAppDashboardData(),
                offerId
            ).complete

            this.bot.logger.debug(
                this.bot.isMobile,
                'APP-REWARD',
                `Balance delta after AppReward | offerId=${offerId} | previousBalance=${this.oldBalance} | currentBalance=${newBalance} | pointsGained=${this.gainedPoints}`
            )

            if (verified) {
                this.bot.userData.currentPoints = newBalance
                if (this.gainedPoints > 0) {
                    this.bot.userData.gainedPoints = (this.bot.userData.gainedPoints ?? 0) + this.gainedPoints
                }

                this.bot.logger.info(
                    this.bot.isMobile,
                    'APP-REWARD',
                    `AppReward verified by SAAndroid | offerId=${offerId} | pointsGained=${this.gainedPoints} | currentBalance=${newBalance}`,
                    'green'
                )
            } else {
                this.bot.logger.warn(
                    this.bot.isMobile,
                    'APP-REWARD',
                    `AppReward submitted but SAAndroid still reports incomplete | offerId=${offerId} | pointsGained=${this.gainedPoints} | currentBalance=${newBalance}`
                )
            }

            this.bot.logger.info(
                this.bot.isMobile,
                'APP-REWARD',
                `Finished AppReward | offerId=${offerId} | currentBalance=${this.bot.userData.currentPoints}`
            )
        } catch (error) {
            this.bot.logger.error(
                this.bot.isMobile,
                'APP-REWARD',
                `Error in doAppReward | offerId=${offerId} | message=${error instanceof Error ? error.message : String(error)}`
            )
        }
    }
}
