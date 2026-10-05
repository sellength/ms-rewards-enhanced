import type { Page } from 'patchright'

import { URLs } from '../../../constants/urls'
import { SearchQueryQueue } from '../../SearchQueryQueue'
import { BaseActivity } from '../BaseActivity'
import { BonusTracker } from './BonusTracker'
import { SearchProgress } from './SearchProgress'
import { findBingSearchInput } from './SearchPageAdapter'
import type { SearchTracker } from '../../../interface/Search'
import type { MissingSearchPoints } from '../../../interface/Points'
import type { MicrosoftRewardsBot } from '../../../index'

const REFRESH_EVERY = 10
const MAX_QUERY_ATTEMPTS = 3 // Initial attempt plus at most two page recoveries.
const LANDING_DIAGNOSTIC_ATTEMPTS = 3

const POINTS_MAX_SEARCHES = 100
const POINTS_STAGNANT_LIMIT = 10

const SEARCH_BOX = '#sb_form_q'
const RESULT_LINK = '#b_results .b_algo h2'

interface SessionStats {
    totalGained: number
    performed: number
    stagnant: number
}

export class Search extends BaseActivity {
    private searchCount = 0

    public async doSearch(page: Page, isMobile: boolean): Promise<number> {
        const startBalance = Number(this.bot.userData.currentPoints ?? 0)
        this.bot.logger.info(isMobile, 'SEARCH-BING', `Starting Bing searches | currentBalance=${startBalance}`)

        const tracker = new PointsTracker(this.bot, isMobile)
        try {
            const stats = await this.runSearchSession(page, isMobile, tracker)

            if (stats.stagnant >= tracker.stagnantLimit && !tracker.done()) {
                this.bot.logger.error(
                    isMobile,
                    tracker.context,
                    `Bing searches interrupted | reason=10_consecutive_zero_points | ${tracker.progress()} | pointsGained=${stats.totalGained}`
                )
                throw new Error(`搜索中断失败：连续 ${tracker.stagnantLimit} 次搜索未获得积分 (0分)，疑似触发微软15分钟风控冷却`)
            }

            if (stats.performed >= tracker.maxSearches && !tracker.done()) {
                this.bot.logger.warn(
                    isMobile,
                    tracker.context,
                    `Hit the ${tracker.maxSearches}-search ceiling with points still missing | ${tracker.progress()}`
                )
            }

            this.bot.logger.info(
                isMobile,
                tracker.context,
                `Completed Bing searches | pointsGained=${stats.totalGained} | currentBalance=${this.bot.userData.currentPoints} | previousBalance=${startBalance} | searches=${stats.performed} | ${tracker.progress()}`
            )
            return stats.totalGained
        } finally {
            await page.goto(URLs.bing.origin).catch(() => {})
        }
    }

    public async doBonusSearches(page: Page): Promise<number> {
        const isMobile = this.bot.isMobile
        const tracker = new BonusTracker(this.bot, isMobile)

        const stats = await this.runSearchSession(page, isMobile, tracker)

        if (!tracker.started) return 0

        const done = tracker.done() && !tracker.offerLost
        const reason = done
            ? 'offer complete'
            : tracker.offerLost
              ? 'offer no longer present'
              : stats.performed >= tracker.maxSearches
                ? 'reached maxBonusSearches'
                : stats.stagnant >= tracker.stagnantLimit
                  ? `${tracker.stagnantLimit} idle searches`
                  : 'query pool exhausted'

        if (stats.stagnant >= tracker.stagnantLimit && !done) {
            this.bot.logger.error(
                isMobile,
                tracker.context,
                `Bonus searches interrupted | reason=10_consecutive_zero_points | ${tracker.progress()}`
            )
            throw new Error(`Bonus搜索中断失败：连续 ${tracker.stagnantLimit} 次搜索未获得积分 (0分)`)
        }

        this.bot.logger.info(
            isMobile,
            tracker.context,
            `Bonus farming ${done ? 'complete' : 'stopped'} (${reason}) | pointsGained=${stats.totalGained} | currentBalance=${this.bot.userData.currentPoints} | ${tracker.progress()} | searches=${stats.performed}`,
            done || stats.totalGained > 0 ? 'green' : undefined
        )
        return stats.totalGained
    }

    private async runSearchSession(page: Page, isMobile: boolean, tracker: SearchTracker): Promise<SessionStats> {
        const stats: SessionStats = { totalGained: 0, performed: 0, stagnant: 0 }

        try {
            const ready = await tracker.prepare()
            if (!ready) return stats

            const queryQueue = new SearchQueryQueue(this.bot)
            const topicCount = await queryQueue.prepare()
            if (!topicCount) {
                this.bot.logger.warn(isMobile, tracker.context, 'No main search topics available, skipping')
                return stats
            }
            this.bot.logger.info(
                isMobile,
                tracker.context,
                `Query queue ready | mainTopics=${topicCount} | clusterSearch=${this.bot.config.searchSettings.clusterSearch}`
            )

            await this.bot.browser.func.synchronizeActiveBrowserCookies('SEARCH-COOKIE-SEED', true)
            await page.goto(URLs.rewards.earn, { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {})
            await this.bot.utils.wait(1500)
            await page.goto(URLs.bing.origin)
            await page.waitForLoadState('domcontentloaded', { timeout: 8000 }).catch(() => {})
            await this.bot.browser.utils.tryDismissAllMessages(page)
            await this.ensureBingAuthenticated(page, isMobile)

            while (!tracker.done() && stats.performed < tracker.maxSearches && stats.stagnant < tracker.stagnantLimit) {
                const query = await queryQueue.next()
                if (!query) {
                    this.bot.logger.warn(isMobile, tracker.context, 'Query queue exhausted, stopping')
                    break
                }

                await this.bot.browser.func.synchronizeActiveBrowserCookies('SEARCH-COOKIE-SEED', true)
                await this.bingSearch(page, query, isMobile)
                stats.performed++

                await this.bot.browser.func.synchronizeActiveBrowserCookies('SEARCH-COOKIE-CAPTURE')
                const gained = await tracker.measure()
                if (gained > 0) {
                    stats.stagnant = 0
                    stats.totalGained += gained
                    this.bot.logger.info(
                        isMobile,
                        tracker.context,
                        `pointsGained=${gained} | currentBalance=${this.bot.userData.currentPoints} | query="${query}" | ${tracker.progress()}`,
                        'green'
                    )
                } else {
                    stats.stagnant++
                    this.bot.logger.info(
                        isMobile,
                        tracker.context,
                        `no points ${stats.stagnant}/${tracker.stagnantLimit} | query="${query}" | ${tracker.progress()}`
                    )
                }
            }

            if (stats.stagnant >= tracker.stagnantLimit && !tracker.done()) {
                this.bot.logger.error(
                    isMobile,
                    tracker.context,
                    `搜索已中断：连续 ${tracker.stagnantLimit} 次搜索未获得积分 (0分)，疑似触发微软搜索冷却风控(15分钟)或单日限制 | ${tracker.progress()} | 已执行=${stats.performed}次`
                )
            }

            return stats
        } catch (error) {
            this.bot.logger.error(
                isMobile,
                tracker.context,
                `Search session error | ${error instanceof Error ? error.message : String(error)}`
            )
            return stats
        }
    }

    private async ensureBingAuthenticated(page: Page, isMobile: boolean): Promise<void> {
        try {
            if (typeof page.evaluate !== 'function') return
            const status = await page.evaluate(() => {
                const doc = typeof document !== 'undefined' ? document : null
                if (!doc) return { isSignInVisible: false, hasUser: true }
                const signInBtn = doc.querySelector('#id_s, .b_idProviders, a[href*="signin"]')
                const isSignInVisible = signInBtn
                    ? !signInBtn.classList.contains('b_hide') && Boolean(signInBtn.textContent?.match(/sign\s*in|登录/i))
                    : false
                const avatar = doc.querySelector('#id_a, .id_avatar, #id_rh, .sw_me, #id_n')
                const hasUser = Boolean(avatar && (avatar.textContent?.trim().length || (avatar as HTMLElement).offsetWidth > 0))
                return { isSignInVisible, hasUser }
            }).catch(() => null)

            if (status && (status.isSignInVisible || !status.hasUser)) {
                this.bot.logger.info(isMobile, 'SEARCH-AUTH', 'Bing search session not authenticated; executing SSO handshake')
                await page.goto(URLs.auth.bingSignIn, { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {})
                await this.bot.utils.wait(2000)
                await this.bot.browser.func.synchronizeActiveBrowserCookies('SEARCH-AUTH-SSO', true)
                this.bot.logger.info(isMobile, 'SEARCH-AUTH', 'Bing SSO handshake completed')
            }
        } catch {
            // Non-fatal session bootstrap catch
        }
    }

    private async bingSearch(page: Page, query: string, isMobile: boolean): Promise<void> {
        this.searchCount++

        if (!isMobile && this.searchCount % REFRESH_EVERY === 0) {
            await page.goto(URLs.bing.origin)
            if (typeof page.waitForLoadState === 'function') {
                await page.waitForLoadState('domcontentloaded', { timeout: 8000 }).catch(() => {})
            }
            await this.bot.browser.utils.tryDismissAllMessages(page)
            await this.ensureBingAuthenticated(page, isMobile)
        }

        for (let attempt = 1; attempt <= MAX_QUERY_ATTEMPTS; attempt++) {
            let submissionAttempted = false
            try {
                const before = await this.searchPageDiagnostic(page)
                if (before.blocked) throw new Error(`search_manual_required:${before.kind}`)
                if (isMobile) {
                    // Keep the existing mobile session; a result page need not expose an input.
                    const target = new URL('/search', URLs.bing.origin)
                    target.searchParams.set('q', query)
                    this.bot.logger.info(isMobile, 'SEARCH-BING', 'Submitting Bing search | strategy=mobile-navigation')
                    submissionAttempted = true
                    const response = await page.goto(target.href, { waitUntil: 'domcontentloaded', timeout: 15000 })
                    const landed = await this.confirmMobileSearchLanding(page)
                    if (landed.blocked) throw new Error(`search_manual_required:${landed.kind}`)
                    if (landed.kind !== 'bing-search' || (response && response.status() >= 400)) {
                        throw new Error('search_navigation_unconfirmed')
                    }
                } else {
                    await page.evaluate(() => window.scrollTo({ left: 0, top: 0, behavior: 'auto' })).catch(() => {})
                    await page.keyboard.press('Home').catch(() => {})
                    const entry = await findBingSearchInput(page)
                    if (!entry) throw new Error('search_input_missing')
                    const searchBox = entry.input
                    this.bot.logger.info(isMobile, 'SEARCH-BING', `Search input ready | strategy=${entry.strategy}`)

                    await this.bot.utils.wait(1000)
                    await searchBox.fill('', { timeout: 5000 })
                    await searchBox.focus({ timeout: 5000 })

                    await page.keyboard.type(query, { delay: this.bot.utils.randomDelay(45, 90) })
                    submissionAttempted = true

                    // Check for autocomplete suggestions dropdown (li.sa_sg, [role="option"])
                    await this.bot.utils.wait(500)
                    const suggestion = page.locator('li.sa_sg, [role="option"]').first()
                    const hasSuggestion = await suggestion.isVisible().catch(() => false)
                    if (hasSuggestion) {
                        this.bot.logger.info(isMobile, 'SEARCH-BING', 'Selecting autocomplete suggestion for authentic search token')
                        await page.keyboard.press('ArrowDown').catch(() => {})
                        await this.bot.utils.wait(100)
                    }

                    await page.keyboard.press('Enter')

                    if (typeof page.waitForURL === 'function') {
                        await page.waitForURL(url => url.pathname === '/search', { timeout: 8000 }).catch(() => {})
                    }
                    if (typeof page.waitForLoadState === 'function') {
                        await page.waitForLoadState('domcontentloaded', { timeout: 5000 }).catch(() => {})
                    }
                }
                await this.bot.utils.wait(3000)
                if (page.mouse?.wheel) {
                    await page.mouse.wheel(0, Math.floor(Math.random() * 200) + 150).catch(() => {})
                    await this.bot.utils.wait(1500)
                }

                if (this.bot.config.searchSettings.scrollRandomResults) {
                    await this.bot.utils.wait(2000)
                    await this.randomScroll(page, isMobile)
                }
                if (this.bot.config.searchSettings.clickRandomResults) {
                    await this.bot.utils.wait(2000)
                    await this.clickRandomLink(page, isMobile)
                }

                await this.bot.utils.wait(
                    this.bot.utils.randomDelay(
                        this.bot.config.searchSettings.searchDelay.min,
                        this.bot.config.searchSettings.searchDelay.max
                    )
                )

                return
            } catch (error) {
                const diagnostic = await this.searchPageDiagnostic(page)
                const missing = error instanceof Error && error.message === 'search_input_missing'
                const report = missing && attempt < MAX_QUERY_ATTEMPTS ? 'info' : 'warn'
                this.bot.logger[report](
                    isMobile,
                    'SEARCH-BING',
                    `${report === 'info' ? 'Search input absent; using homepage fallback' : `Search attempt ${attempt}/${MAX_QUERY_ATTEMPTS} failed`} | page=${diagnostic.kind} | searchBoxes=${diagnostic.count} | searchBoxVisible=${diagnostic.visible} | submissionAttempted=${submissionAttempted}`
                )
                if (error instanceof Error && error.message === 'search_input_ambiguous') {
                    throw new Error('search_input_ambiguous; 多个可用搜索入口，停止猜测点击')
                }
                if (diagnostic.blocked || (error instanceof Error && error.message.startsWith('search_manual_required:'))) {
                    throw new Error(`search_manual_required:${diagnostic.kind}; 请检查浏览器登录或验证页面`)
                }
                if (submissionAttempted) throw new Error('search_submission_uncertain; 已尝试提交，不自动重复搜索，请同步官方进度')
                if (attempt === MAX_QUERY_ATTEMPTS) throw new Error('search_page_recovery_exhausted; 搜索框仍不可用，已停止有限恢复')
                await this.bot.utils.wait(2000)
                this.bot.logger.info(isMobile, 'SEARCH-BING', `Recovering Bing search page | recovery=${attempt}/2`)
                await page.goto(URLs.bing.origin, { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {})
                const recovered = await this.searchPageDiagnostic(page)
                if (recovered.blocked) throw new Error(`search_manual_required:${recovered.kind}; 请检查浏览器登录或验证页面`)
                await this.bot.browser.utils.tryDismissAllMessages(page)
            }
        }
    }

    private async confirmMobileSearchLanding(page: Page): Promise<{ kind: string; count: number; visible: boolean; blocked: boolean }> {
        let diagnostic = await this.searchPageDiagnostic(page)
        for (let attempt = 1; attempt < LANDING_DIAGNOSTIC_ATTEMPTS; attempt++) {
            if (!diagnostic.blocked && diagnostic.kind === 'bing-search') return diagnostic
            if (diagnostic.kind === 'login' || diagnostic.kind === 'closed') return diagnostic
            await this.bot.utils.wait(300)
            diagnostic = await this.searchPageDiagnostic(page)
        }
        return diagnostic
    }

    private async searchPageDiagnostic(page: Page): Promise<{ kind: string; count: number; visible: boolean; blocked: boolean }> {
        if (page.isClosed()) return { kind: 'closed', count: 0, visible: false, blocked: true }
        let kind = 'other'
        try {
            const url = new URL(page.url())
            if (['login.live.com', 'login.microsoftonline.com', 'account.live.com'].includes(url.hostname)) kind = 'login'
            else if (url.hostname === 'bing.com' || url.hostname.endsWith('.bing.com')) {
                kind = /captcha|challenge|turing/i.test(url.pathname) ? 'verification' : url.pathname === '/search' ? 'bing-search' : 'bing-other'
            }
        } catch { /* Do not log raw URLs. */ }
        try {
            if (await page.locator('iframe[src*="captcha"], #b_captcha, #captcha, input[name="cf-turnstile-response"]').first().isVisible()) kind = 'verification'
            else if (await page.locator('input[type="password"], input[name="loginfmt"]').first().isVisible()) kind = 'login'
            const box = page.locator(SEARCH_BOX)
            return { kind, count: await box.count(), visible: await box.first().isVisible(), blocked: kind === 'login' || kind === 'verification' }
        } catch {
            return { kind: 'unavailable', count: 0, visible: false, blocked: true }
        }
    }

    private async randomScroll(page: Page, isMobile: boolean) {
        try {
            await page.evaluate(() => {
                const maxScroll = Math.max(1, document.body.scrollHeight - window.innerHeight)
                window.scrollTo({ left: 0, top: Math.floor(Math.random() * maxScroll), behavior: 'auto' })
            })
        } catch (error) {
            this.bot.logger.error(
                isMobile,
                'SEARCH-RANDOM-SCROLL',
                `Failed during random scroll | ${error instanceof Error ? error.message : String(error)}`
            )
        }
    }

    private async clickRandomLink(page: Page, isMobile: boolean) {
        try {
            const searchPageUrl = page.url()
            await this.bot.browser.utils.ghostClick(page, RESULT_LINK)
            await this.bot.utils.wait(this.bot.config.searchSettings.searchResultVisitTime)

            if (isMobile) {
                await page.goto(searchPageUrl)
            } else {
                const newTab = await this.bot.browser.utils.getLatestTab(page)
                await this.bot.browser.utils.closeTabs(newTab)
            }
        } catch (error) {
            this.bot.logger.error(
                isMobile,
                'SEARCH-RANDOM-CLICK',
                `Failed during random click | ${error instanceof Error ? error.message : String(error)}`
            )
        }
    }
}

class PointsTracker implements SearchTracker {
    public readonly context = 'SEARCH-BING'
    public readonly maxSearches = POINTS_MAX_SEARCHES
    public readonly stagnantLimit = POINTS_STAGNANT_LIMIT

    private missing: MissingSearchPoints = { mobilePoints: 0, desktopPoints: 0, edgePoints: 0, totalPoints: 0 }
    private readonly runOnZeroPoints: boolean
    private readonly searchProgress: SearchProgress

    constructor(
        private bot: MicrosoftRewardsBot,
        private isMobile: boolean
    ) {
        this.runOnZeroPoints = this.bot.config.searchSettings.runOnZeroPoints ?? false
        this.searchProgress = new SearchProgress(this.bot)
    }

    async prepare(): Promise<boolean> {
        this.missing = await this.searchProgress.getMissing(this.isMobile)
        this.bot.logger.info(
            this.isMobile,
            this.context,
            `Search points remaining | edge=${this.missing.edgePoints} | desktop=${this.missing.desktopPoints} | mobile=${this.missing.mobilePoints}`
        )

        if (this.missing.totalPoints <= 0) {
            if (!this.runOnZeroPoints) {
                this.bot.logger.info(
                    this.isMobile,
                    this.context,
                    'No search points to earn, skipping (runOnZeroPoints is disabled)'
                )
                return false
            }
            this.bot.logger.info(
                this.isMobile,
                this.context,
                'No search points reported, but runOnZeroPoints is enabled, searching anyway'
            )
        }
        return true
    }

    async measure(): Promise<number> {
        const updated = await this.searchProgress.getMissing(this.isMobile)
        const gained = Math.max(0, this.missing.totalPoints - updated.totalPoints)
        this.missing = updated

        if (gained > 0) {
            this.bot.userData.currentPoints = Number(this.bot.userData.currentPoints ?? 0) + gained
            this.bot.userData.gainedPoints = (this.bot.userData.gainedPoints ?? 0) + gained
        }
        return gained
    }

    done(): boolean {
        return !this.runOnZeroPoints && this.missing.totalPoints <= 0
    }

    progress(): string {
        return `remaining=${this.missing.totalPoints}`
    }
}
