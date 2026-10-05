import { MicrosoftRewardsBot, executionContext } from '../../../index'
import type { Account } from '../../../interface/Account'
import { URLs } from '../../../constants/urls'
import { SearchProgress, type SearchQuota } from './SearchProgress'
import type { AppDashboardData } from '../../../interface/AppDashBoardData'

interface SearchPlan {
    doMobile: boolean
    doDesktop: boolean
    mobileMissing: number
    desktopMissing: number
}

export class SearchManager {
    private readonly progress: SearchProgress

    constructor(private bot: MicrosoftRewardsBot) {
        this.progress = new SearchProgress(bot)
    }

    async getSearchPoints(appData?: AppDashboardData): Promise<SearchPlan> {
        const mobileEarnable = this.bot.browserEarnable?.mobileSearchPoints
        const skipMobileCheck = mobileEarnable === 0
        const mobileQuota = this.bot.config.workers.doMobileSearch && !skipMobileCheck
            ? await this.progress.getMobileQuota(appData).catch(() => ({ earned: 0, max: 0, remaining: 0 }))
            : { earned: 0, max: 0, remaining: 0 }
        const counters = this.bot.config.workers.doDesktopSearch ? await this.progress.getCounters() : null
        const quotas = counters ? this.progress.calculateQuotas(counters) : null
        const mobileMissing = mobileQuota.remaining
        const desktopQuota = quotas
            ? this.combineQuotas(quotas.desktop, quotas.edge)
            : { earned: 0, max: 0, remaining: 0 }
        const desktopMissing = desktopQuota.remaining

        const doMobile = this.bot.config.workers.doMobileSearch && mobileMissing > 0
        const doDesktop = this.bot.config.workers.doDesktopSearch && desktopMissing > 0

        this.bot.logger.info(
            'main',
            'SEARCH-MANAGER',
                `Mobile (SAAndroid): ${this.describeQuota(this.bot.config.workers.doMobileSearch, mobileQuota, skipMobileCheck)}` +
                ` | Desktop: ${this.describeQuota(this.bot.config.workers.doDesktopSearch, desktopQuota)}` +
                `${quotas && quotas.edge.max > 0 ? ` | Edge: ${quotas.edge.earned}/${quotas.edge.max}` : ''}`
        )

        return { doMobile, doDesktop, mobileMissing, desktopMissing }
    }

    private combineQuotas(...quotas: SearchQuota[]): SearchQuota {
        return quotas.reduce(
            (total, quota) => ({
                earned: total.earned + quota.earned,
                max: total.max + quota.max,
                remaining: total.remaining + quota.remaining
            }),
            { earned: 0, max: 0, remaining: 0 }
        )
    }

    private describeQuota(enabled: boolean, quota: SearchQuota, isAlreadySkipped = false): string {
        if (isAlreadySkipped) return 'skip (今日已满额跳过)'
        if (!enabled) return `skip (disabled, ${quota.earned}/${quota.max})`
        if (quota.max <= 0) return 'skip (state unavailable, 0/0)'
        if (quota.remaining <= 0) return `skip (complete, ${quota.earned}/${quota.max})`
        return `run (${quota.earned}/${quota.max}, missing ${quota.remaining})`
    }

    searchMobile(account: Account): Promise<number> {
        return this.search(account, true)
    }

    searchDesktop(account: Account): Promise<number> {
        return this.search(account, false)
    }

    private search(account: Account, isMobile: boolean): Promise<number> {
        const platform = isMobile ? 'Mobile' : 'Desktop'
        const page = isMobile ? this.bot.mainMobilePage : this.bot.mainDesktopPage

        return executionContext.run({ isMobile, account }, async () => {
            try {
                return await this.bot.activities.doSearch(page, isMobile)
            } catch (error) {
                this.bot.logger.error(
                    'main',
                    'SEARCH-MANAGER',
                    `${platform} search failed | ${error instanceof Error ? error.message : String(error)}`
                )
                return 0
            }
        })
    }

    async bonusMobile(account: Account): Promise<number> {
        this.bot.logger.info('main', 'SEARCH-MANAGER', 'Starting bonus search farming')

        const gained = await executionContext.run({ isMobile: true, account }, async () => {
            try {
                return await this.bot.activities.doBonusSearches(this.bot.mainMobilePage)
            } catch (error) {
                this.bot.logger.error(
                    'main',
                    'SEARCH-MANAGER',
                    `Bonus search failed | ${error instanceof Error ? error.message : String(error)}`
                )
                return 0
            } finally {
                if (!this.bot.mainMobilePage.isClosed()) {
                    await this.bot.mainMobilePage.goto(URLs.bing.origin).catch(() => {})
                }
            }
        })

        this.bot.logger.info(
            'main',
            'SEARCH-MANAGER',
            `Bonus search summary | pointsGained=${gained} | currentBalance=${this.bot.userData.currentPoints}`
        )
        return gained
    }
}
