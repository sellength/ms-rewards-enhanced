import type { MicrosoftRewardsBot } from '../../../index'
import type { Counters, DashboardImpression } from '../../../interface/DashboardData'
import type { MissingSearchPoints } from '../../../interface/Points'
import type { AppDashboardData } from '../../../interface/AppDashBoardData'
import { findAppSearch } from '../app/AppState'

export interface SearchQuota {
    earned: number
    max: number
    remaining: number
}

export interface SearchQuotas {
    mobile: SearchQuota
    desktop: SearchQuota
    edge: SearchQuota
}

export class SearchProgress {
    constructor(private readonly bot: MicrosoftRewardsBot) {}

    public async getCounters(): Promise<Counters> {
        const dashboard = await this.bot.browser.func.getDashboardData()
        return dashboard.dashboard.userStatus.counters
    }

    public async getMissing(isMobile: boolean): Promise<MissingSearchPoints> {
        if (isMobile) {
            const quota = findAppSearch(await this.bot.browser.func.getAppDashboardData())
            return {
                mobilePoints: quota.remaining,
                desktopPoints: 0,
                edgePoints: 0,
                totalPoints: quota.remaining
            }
        }
        return this.calculateMissing(await this.getCounters(), false)
    }

    public async getMobileQuota(data?: AppDashboardData): Promise<SearchQuota> {
        const progress = findAppSearch(data ?? (await this.bot.browser.func.getAppDashboardData()))
        return { earned: progress.earned, max: progress.max, remaining: progress.remaining }
    }

    public calculateMissing(counters: Counters, isMobile: boolean): MissingSearchPoints {
        const quotas = this.calculateQuotas(counters)
        const mobilePoints = quotas.mobile.remaining
        const desktopPoints = quotas.desktop.remaining
        const edgePoints = quotas.edge.remaining

        return {
            mobilePoints,
            desktopPoints,
            edgePoints,
            totalPoints: isMobile ? mobilePoints : desktopPoints + edgePoints
        }
    }

    public calculateQuotas(counters: Counters): SearchQuotas {
        const pcCounters = counters.pcSearch ?? []
        const explicitEdgeCounters = pcCounters.filter(counter => this.isEdgeCounter(counter))
        const desktopCounters = explicitEdgeCounters.length
            ? pcCounters.filter(counter => !this.isEdgeCounter(counter))
            : pcCounters

        const mobileQuota = this.summarize(counters.mobileSearch ?? [])

        return {
            mobile: mobileQuota,
            desktop: this.summarize(desktopCounters),
            edge: this.summarize(explicitEdgeCounters)
        }
    }

    private summarize(counters: DashboardImpression[]): SearchQuota {
        return counters.reduce<SearchQuota>(
            (quota, counter) => {
                const max = Math.max(0, Number(counter.pointProgressMax) || 0)
                const earned = Math.min(max, Math.max(0, Number(counter.pointProgress) || 0))
                quota.earned += earned
                quota.max += max
                quota.remaining += max - earned
                return quota
            },
            { earned: 0, max: 0, remaining: 0 }
        )
    }

    private isEdgeCounter(counter: DashboardImpression): boolean {
        return [counter.offerId, counter.name, counter.title, counter.promotionSubtype].some(
            value => typeof value === 'string' && /(^|[_\s-])edge([_\s-]|$)/i.test(value)
        )
    }
}
