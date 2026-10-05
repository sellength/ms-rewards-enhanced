import type { Page } from 'patchright'
import { BaseActivity } from '../BaseActivity'
import { activateSearchOnBing, findSearchOnBingOffer, getSearchOnBingQueries } from './SearchOnBingShared'
import { URLs } from '../../../constants/urls'
import { findAppPromotions, progressOf } from '../app/AppState'
import { findBingSearchInput } from './SearchPageAdapter'

import type { BasePromotion } from '../../../interface/DashboardData'

export class SearchOnBing extends BaseActivity {
    private gainedPoints = 0
    private success = false
    private oldBalance = 0

    public async doSearchOnBing(promotion: BasePromotion, page: Page): Promise<boolean> {
        const offerId = promotion.offerId
        this.oldBalance = Number(this.bot.userData.currentPoints ?? 0)
        this.gainedPoints = 0
        this.success = false

        this.bot.logger.info(
            this.bot.isMobile,
            'SEARCH-ON-BING',
            `Starting SearchOnBing | offerId=${offerId} | title="${promotion.title}" | currentBalance=${this.oldBalance}`
        )

        try {
            const activated = await activateSearchOnBing(this.bot, promotion, page)
            if (!activated) {
                this.bot.logger.info(
                    this.bot.isMobile,
                    'SEARCH-ON-BING',
                    `Search activity couldn't be activated (may be locked or quota exhausted) | offerId=${offerId}`
                )
                return false
            }

            const queries = await getSearchOnBingQueries(this.bot, promotion)
            await this.searchBing(page, queries, promotion)

            if (this.success || this.gainedPoints > 0) {
                this.bot.logger.info(
                    this.bot.isMobile,
                    'SEARCH-ON-BING',
                    `Completed SearchOnBing | offerId=${offerId} | pointsGained=${this.gainedPoints} | currentBalance=${this.bot.userData.currentPoints} | previousBalance=${this.oldBalance}`,
                    'green'
                )
                return true
            } else {
                this.bot.logger.info(
                    this.bot.isMobile,
                    'SEARCH-ON-BING',
                    `SearchOnBing concluded with 0 points gained (daily quota reached or cloud cooldown active) | offerId=${offerId} | currentBalance=${this.bot.userData.currentPoints}`
                )
                return false
            }
        } catch (error) {
            this.bot.logger.error(
                this.bot.isMobile,
                'SEARCH-ON-BING',
                `Error in doSearchOnBing | offerId=${offerId} | message=${error instanceof Error ? error.message : String(error)}`
            )
            return false
        } finally {
            await page.goto(URLs.rewards.earn).catch(() => {})
        }
    }

    private async searchBing(page: Page, queries: string[], promotion: BasePromotion) {
        queries = [...new Set(queries)]
        const offerId = promotion.offerId

        this.bot.logger.debug(
            this.bot.isMobile,
            'SEARCH-ON-BING-SEARCH',
            `Starting search loop | queriesCount=${queries.length} | targetPoints=${promotion.pointProgressMax} | currentBalance=${this.oldBalance}`
        )

        await this.bot.browser.func.synchronizeActiveBrowserCookies('SEARCH-ON-BING-COOKIE-SEED', true)
        await this.ensureSearchReady(page, promotion)

        let lastBalance = this.oldBalance

        for (const [index, query] of queries.entries()) {
            try {
                this.bot.logger.debug(this.bot.isMobile, 'SEARCH-ON-BING-SEARCH', `Processing query | query="${query}"`)

                await this.bot.browser.func.synchronizeActiveBrowserCookies('SEARCH-ON-BING-COOKIE-SEED', true)
                await this.typeSearch(page, query, promotion)

                await this.bot.utils.wait(this.bot.utils.randomDelay(5000, 7000))

                await this.bot.browser.func.synchronizeActiveBrowserCookies('SEARCH-ON-BING-COOKIE-CAPTURE')
                let offerComplete = false
                let offerProgress = 'unknown'
                let newBalance = lastBalance

                if (this.bot.isMobile) {
                    const appData = await this.bot.browser.func.getAppDashboardData().catch(() => null)
                    if (appData) {
                        if (appData.response?.balance !== undefined) {
                            newBalance = Number(appData.response.balance)
                        } else {
                            newBalance = Number(this.bot.userData.currentPoints ?? lastBalance)
                        }
                        const offer = findAppPromotions(appData).find(item => item.attributes.offerid === offerId)
                        if (offer) {
                            const p = progressOf(offer)
                            offerProgress = `${p.earned}/${p.max}`
                            offerComplete = p.complete
                        }
                    } else {
                        newBalance = Number(this.bot.userData.currentPoints ?? lastBalance)
                    }
                } else {
                    const dashboard = (await this.bot.browser.func.getDashboardData()).dashboard
                    newBalance = dashboard.userStatus.availablePoints
                    const offer = findSearchOnBingOffer(dashboard, offerId)
                    offerProgress = offer ? `${offer.pointProgress}/${offer.pointProgressMax}` : 'unknown'
                    offerComplete =
                        !!offer &&
                        (offer.complete || (offer.pointProgressMax > 0 && offer.pointProgress >= offer.pointProgressMax))
                }

                const delta = newBalance - lastBalance
                if (delta > 0) {
                    this.bot.userData.gainedPoints = (this.bot.userData.gainedPoints ?? 0) + delta
                    lastBalance = newBalance
                }
                this.bot.userData.currentPoints = newBalance
                this.gainedPoints = newBalance - this.oldBalance

                this.bot.logger.debug(
                    this.bot.isMobile,
                    'SEARCH-ON-BING-SEARCH',
                    `Progress check | query="${query}" | offerProgress=${offerProgress} | offerComplete=${offerComplete} | currentBalance=${newBalance}`
                )

                if (offerComplete) {
                    this.success = true
                    this.bot.logger.info(
                        this.bot.isMobile,
                        'SEARCH-ON-BING-SEARCH',
                        `SearchOnBing activity completed | pointsGained=${this.gainedPoints} | currentBalance=${newBalance} | query="${query}" | offerProgress=${offerProgress}`,
                        'green'
                    )
                    return
                }

                this.bot.logger.info(
                    this.bot.isMobile,
                    'SEARCH-ON-BING-SEARCH',
                    `[探索进度 ${index + 1}/${queries.length}] 搜索词: "${query}" | 云端状态: ${offerProgress}`,
                    'cyan'
                )
            } catch (error) {
                this.bot.logger.error(
                    this.bot.isMobile,
                    'SEARCH-ON-BING-SEARCH',
                    `Error during search loop | query="${query}" | message=${error instanceof Error ? error.message : String(error)}`
                )
            } finally {
                if (!this.success && index < queries.length - 1) {
                    await this.bot.utils.wait(this.bot.utils.randomDelay(5000, 15000))
                }
            }
        }

        this.bot.logger.info(
            this.bot.isMobile,
            'SEARCH-ON-BING-SEARCH',
            `[Explore on Bing] 本轮探索搜索完成 (${queries.length}/${queries.length}) | 微软云端处于跨天解锁冷却期 | offerId=${offerId}`,
            'yellow'
        )
    }

    private async ensureSearchReady(page: Page, promotion?: BasePromotion) {
        const dest = (promotion?.destinationUrl || (promotion?.attributes as Record<string, string>)?.destination_url || '').trim()
        const targetUrl = dest && dest.startsWith('http') ? dest : URLs.bing.origin

        const searchBox = page.locator('#sb_form_q')
        if (await searchBox.isVisible().catch(() => false)) {
            if (targetUrl !== URLs.bing.origin && !page.url().includes('rwAutoFlyout=')) {
                await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {})
                await this.bot.utils.wait(2000)
            }
            return
        }

        const adapted = await findBingSearchInput(page).catch(() => null)
        if (adapted?.input) return

        await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {})
        await page.waitForLoadState('domcontentloaded', { timeout: 8000 }).catch(() => {})
        await this.bot.browser.utils.tryDismissAllMessages(page)
    }

    private async typeSearch(page: Page, query: string, promotion?: BasePromotion) {
        await this.ensureSearchReady(page, promotion)

        const selector = '#sb_form_q'
        const searchBox = page.locator(selector)
        const isBoxVisible = await searchBox.isVisible().catch(() => false)

        if (isBoxVisible) {
            await this.bot.utils.wait(500)
            await this.bot.browser.utils.ghostClick(page, selector, { clickCount: 3 })
            await searchBox.fill('')
            await page.keyboard.type(query, { delay: this.bot.utils.randomDelay(45, 90) })
            await page.keyboard.press('Enter')
            await page.waitForLoadState('domcontentloaded', { timeout: 8000 }).catch(() => {})
            return
        }

        const adapted = await findBingSearchInput(page).catch(() => null)
        if (adapted?.input) {
            await this.bot.utils.wait(500)
            await adapted.input.click()
            await adapted.input.fill('')
            await page.keyboard.type(query, { delay: this.bot.utils.randomDelay(45, 90) })
            await page.keyboard.press('Enter')
            await page.waitForLoadState('domcontentloaded', { timeout: 8000 }).catch(() => {})
            return
        }

        await page.goto(`https://www.bing.com/search?q=${encodeURIComponent(query)}&form=ML2PCR&rwAutoFlyout=exb`, { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {})
    }
}
