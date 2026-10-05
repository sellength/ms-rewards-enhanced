import { URLs } from '../../../constants/urls'
import type { HttpRequestConfig } from '../../../util/Http'
import { randomBytes } from 'crypto'
import { BaseActivity } from '../BaseActivity'
import { buildAppHeaders } from './AppRequest'
import { findPromotionByOfferId, findReadToEarn } from './AppState'

export class ReadToEarn extends BaseActivity {
    public async doReadToEarn() {
        if (!this.bot.accessToken) {
            this.bot.logger.warn(
                this.bot.isMobile,
                'READ-TO-EARN',
                'Skipping: App access token not available, this activity requires it!'
            )
            return
        }

        let remainingPoints: number
        let offerId: string
        try {
            const preflight = findReadToEarn(await this.bot.browser.func.getAppDashboardData())
            remainingPoints = preflight.remaining
            offerId = preflight.promotion?.attributes.offerid ?? ''
            if (!offerId) {
                this.bot.logger.warn(
                    this.bot.isMobile,
                    'READ-TO-EARN',
                    '[PLAN] readToEarn skip_state_unavailable reason=current_offer_id_missing'
                )
                return
            }
            if (remainingPoints <= 0) {
                this.bot.logger.info(
                    this.bot.isMobile,
                    'READ-TO-EARN',
                    '[PLAN] readToEarn skip_complete remaining=0'
                )
                return
            }
            this.bot.logger.info(
                this.bot.isMobile,
                'READ-TO-EARN',
                `[PLAN] readToEarn run_pending remaining=${remainingPoints}`
            )
        } catch (error) {
            this.bot.logger.warn(
                this.bot.isMobile,
                'READ-TO-EARN',
                `[PLAN] readToEarn skip_state_unavailable | message=${error instanceof Error ? error.message : String(error)}`
            )
            return
        }

        const delayMin = this.bot.config.searchSettings.readDelay.min
        const delayMax = this.bot.config.searchSettings.readDelay.max
        const startBalance = Number(this.bot.userData.currentPoints ?? 0)

        this.bot.logger.info(
            this.bot.isMobile,
            'READ-TO-EARN',
            `Starting Read to Earn | geo=${this.bot.userData.geoLocale} | delayRange=${delayMin}-${delayMax} | currentBalance=${startBalance}`
        )

        try {
            const jsonData = {
                amount: 1,
                id: '1',
                type: 101,
                attributes: {
                    offerid: offerId
                },
                country: this.bot.userData.geoLocale
            }

            const articleCount = Math.min(10, Math.ceil(remainingPoints / 3))
            let totalGained = 0
            let articlesRead = 0
            let oldBalance = startBalance
            let previousRemaining = remainingPoints

            for (let i = 0; i < articleCount; ++i) {
                jsonData.id = randomBytes(64).toString('hex')

                this.bot.logger.debug(
                    this.bot.isMobile,
                    'READ-TO-EARN',
                    `Submitting Read to Earn activity | article=${i + 1}/${articleCount} | id=${jsonData.id} | country=${jsonData.country}`
                )

                const request: HttpRequestConfig = {
                    url: URLs.platform.activities,
                    method: 'POST',
                    headers: buildAppHeaders(this.bot, true),
                    data: JSON.stringify(jsonData)
                }

                const response = await this.bot.http.request<{ response?: { balance?: number } }>(request)

                this.bot.logger.debug(
                    this.bot.isMobile,
                    'READ-TO-EARN',
                    `Received Read to Earn response | article=${i + 1}/${articleCount} | status=${response?.status ?? 'unknown'}`
                )

                const newBalance = Number(response?.data?.response?.balance ?? oldBalance)
                const gainedPoints = newBalance - oldBalance
                await this.bot.utils.wait(750)
                const updatedRemaining = await this.getRemainingPoints(offerId)
                const progressed = Math.max(0, previousRemaining - updatedRemaining)

                this.bot.logger.debug(
                    this.bot.isMobile,
                    'READ-TO-EARN',
                    `Balance delta after article | article=${i + 1}/${articleCount} | previousBalance=${oldBalance} | currentBalance=${newBalance} | pointsGained=${gainedPoints}`
                )

                if (progressed <= 0) {
                    this.bot.logger.info(
                        this.bot.isMobile,
                        'READ-TO-EARN',
                        `SAAndroid Read progress did not change, stopping | article=${i + 1}/${articleCount} | status=${response.status} | remaining=${updatedRemaining}`
                    )
                    break
                }

                this.bot.userData.currentPoints = newBalance
                this.bot.userData.gainedPoints = (this.bot.userData.gainedPoints ?? 0) + gainedPoints
                totalGained += gainedPoints
                articlesRead = i + 1
                oldBalance = newBalance
                previousRemaining = updatedRemaining

                this.bot.logger.info(
                    this.bot.isMobile,
                    'READ-TO-EARN',
                    `Read article verified by SAAndroid | article=${i + 1}/${articleCount} | progressGained=${progressed} | pointsGained=${gainedPoints} | remaining=${updatedRemaining} | currentBalance=${newBalance}`,
                    'green'
                )

                if (updatedRemaining <= 0) break

                this.bot.logger.debug(
                    this.bot.isMobile,
                    'READ-TO-EARN',
                    `Waiting between articles | article=${i + 1}/${articleCount} | delayRange=${delayMin}-${delayMax}`
                )

                if (i < articleCount - 1) {
                    await this.bot.utils.wait(this.bot.utils.randomDelay(delayMin, delayMax))
                }
            }

            const finalBalance = Number(this.bot.userData.currentPoints ?? startBalance)

            this.bot.logger.info(
                this.bot.isMobile,
                'READ-TO-EARN',
                `Completed Read to Earn | articlesRead=${articlesRead} | pointsGained=${totalGained} | previousBalance=${startBalance} | currentBalance=${finalBalance}`
            )
        } catch (error) {
            this.bot.logger.error(
                this.bot.isMobile,
                'READ-TO-EARN',
                `Error during Read to Earn | message=${error instanceof Error ? error.message : String(error)}`
            )
        }
    }

    private async getRemainingPoints(offerId: string): Promise<number> {
        const progress = findPromotionByOfferId(await this.bot.browser.func.getAppDashboardData(), offerId)
        if (!progress.promotion) throw new Error(`Current Read offer disappeared during verification: ${offerId}`)
        return progress.remaining
    }
}
