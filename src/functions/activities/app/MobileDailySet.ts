import type { AppDashboardData, Promotion } from '../../../interface/AppDashBoardData'
import { BING_APP_BROWSER_PC, BING_APP_USER_AGENT } from '../../../constants/userAgents'
import { BaseActivity } from '../BaseActivity'
import { findMobileDailySet, progressOf, resolveAppDailySetDate } from './AppState'
import { isInteractiveDailySetDestination, isTomorrowLockedPromotion } from '../../../../promotion-classification.cjs'

import { probeDailySetEntry, trustedDailySetEntry } from '../../../util/DailySetEntryProbe'

type MobileDailySetKind = 'url' | 'quiz' | 'poll'

interface MobileDailySetDestination {
    url: string
    kind: MobileDailySetKind
}

export class MobileDailySet extends BaseActivity {
    private readonly quizOptionSelectors = [
        '.acf-button-standard__link',
        '[data-testid*="answer" i]',
        '[data-testid*="option" i]',
        '#b_pole [id^="btoption"]',
        '#b_pole .btOption',
        '.b_cards [id^="btoption"]',
        '.b_cards .btOption',
        '[id^="btoption"]',
        '.btOption',
        '.bt_card',
        '.bt_choice',
        '[role="radio"]',
        'div[role="button"][id^="choice"]'
    ]

    private readonly pollOptionSelectors = [
        '#b_pole [id^="btoption"]',
        '#b_pole .btOption',
        '.b_cards [id^="btoption"]',
        '.b_cards .btOption',
        '[id^="btoption"]',
        '.btOption',
        '.bt_card',
        '.bt_choice',
        '[role="radio"]',
        '[data-testid*="answer" i]',
        '[data-testid*="option" i]',
        '.acf-button-standard__link'
    ]

    private readonly advanceSelectors = [
        'button.acf-button-standard__btn',
        'a.acf-button-standard__link',
        'button:has-text("Next")',
        'button:has-text("Next question")',
        'a:has-text("Next")',
        'a:has-text("Next question")',
        'input[type="button"][value*="Next" i]',
        'input[type="submit"][value*="Next" i]',
        '[data-testid*="next" i]',
        '[data-testid*="result" i]',
        '.btq_viewRes a',
        '.bt_next',
        '.btNext',
        '#btNext',
        'button:has-text("Submit")',
        'input[type="button"][value*="Submit" i]',
        'input[type="submit"][value*="Submit" i]',
        'button:has-text("Check answer")',
        'button:has-text("Check")',
        'button:has-text("View result")',
        'button:has-text("Results")',
        'a:has-text("Results")',
        'button:has-text("下一")',
        'a:has-text("下一")',
        'button:has-text("提交")',
        'a:has-text("提交")',
        'button:has-text("查看结果")',
        'a:has-text("查看结果")'
    ]

    private appBrowserProfileApplied = false

    public async run(initialData: AppDashboardData): Promise<void> {
        const appDate = this.bot.dailySetDate
        if (!appDate) {
            this.bot.logger.warn(
                this.bot.isMobile,
                'MOBILE-DAILY-SET',
                '[PLAN] dailySet skip_state_unavailable officialCycle=unavailable'
            )
            return
        }
        const allItems = findMobileDailySet(initialData, appDate)

        if (!allItems.length) {
            this.bot.logger.warn(
                this.bot.isMobile,
                'MOBILE-DAILY-SET',
                `[PLAN] dailySet skip_state_unavailable appDate=${appDate}`
            )
            return
        }

        const pending = allItems.filter(item => {
            if (progressOf(item).complete) return false
            if (isTomorrowLockedPromotion(item)) {
                this.bot.logger.info(
                    this.bot.isMobile,
                    'MOBILE-DAILY-SET',
                    `[PLAN] dailySet skip_tomorrow_locked offerId=${item.attributes?.offerid || item.name} appDate=${appDate}`
                )
                return false
            }
            return true
        })
        if (!pending.length) {
            this.bot.logger.info(
                this.bot.isMobile,
                'MOBILE-DAILY-SET',
                `[PLAN] dailySet skip_complete progress=${allItems.length}/${allItems.length} appDate=${appDate}`
            )
            return
        }

        this.bot.logger.info(
            this.bot.isMobile,
            'MOBILE-DAILY-SET',
            `[PLAN] dailySet run_pending remaining=${pending.length} appDate=${appDate}`
        )

        for (const [index, item] of pending.entries()) {
            await this.submitAndVerify(item, appDate)
            if (index < pending.length - 1) {
                await this.bot.utils.wait(this.bot.utils.randomDelay(5000, 12000))
            }
        }
    }

    private async submitAndVerify(item: Promotion, appDate: string): Promise<void> {
        const offerId = item.attributes.offerid
        if (!offerId) {
            this.bot.logger.warn(this.bot.isMobile, 'MOBILE-DAILY-SET', 'Skipping Daily Set item without an offerId')
            return
        }

        try {
            const fresh = await this.bot.browser.func.getAppDashboardData()
            const latest = findMobileDailySet(fresh, appDate).find(
                promotion => promotion.attributes.offerid === offerId
            )
            if (!latest) {
                this.bot.logger.warn(
                    this.bot.isMobile,
                    'MOBILE-DAILY-SET',
                    `[PLAN] dailySet skip_state_unavailable offerId=${offerId} appDate=${appDate}`
                )
                return
            }

            if (progressOf(latest).complete) {
                this.bot.logger.info(
                    this.bot.isMobile,
                    'MOBILE-DAILY-SET',
                    `[PLAN] dailySet skip_complete offerId=${offerId} appDate=${appDate}`
                )
                return
            }

            if (isTomorrowLockedPromotion(latest)) {
                this.bot.logger.info(
                    this.bot.isMobile,
                    'MOBILE-DAILY-SET',
                    `[PLAN] dailySet skip_tomorrow_locked offerId=${offerId} appDate=${appDate}`
                )
                return
            }

            const destination = this.resolveDestination(latest, offerId)
            if (!destination) {
                if (isInteractiveDailySetDestination(latest)) {
                    this.bot.logger.info(this.bot.isMobile, 'MOBILE-DAILY-SET',
                        `[PLAN] dailySet entry_probe_unverified offerId=${offerId} appDate=${appDate}`)
                    return
                }
                const progress = progressOf(latest)
                this.bot.logger.warn(
                    this.bot.isMobile,
                    'MOBILE-DAILY-SET',
                    `[PLAN] dailySet skip_manual_required offerId=${offerId} appDate=${appDate} progress=${progress.earned}/${progress.max} reason=missing_or_untrusted_destination`
                )
                return
            }

            if (isInteractiveDailySetDestination(latest)) {
                if (resolveAppDailySetDate(fresh) !== appDate) {
                    this.bot.logger.info(this.bot.isMobile, 'MOBILE-DAILY-SET',
                        `[PLAN] dailySet entry_probe_unverified offerId=${offerId} appDate=${appDate}`)
                    return
                }
                await this.probeEntry(destination, offerId, appDate)
                return
            }

            const activityResponse = await this.bot.activities.doAppActivity(latest, fresh)
            this.bot.logger.info(
                this.bot.isMobile,
                'MOBILE-DAILY-SET',
                `Submitted verified App activity context | offerId=${offerId} | status=${activityResponse.status}`
            )
            await this.executeDestination(destination, offerId)
            let verified = await this.verifyOffer(offerId, appDate, destination.kind !== 'url')
            if (!verified && destination.kind === 'url') {
                await this.retryUrlDestination(destination, offerId)
                verified = await this.verifyOffer(offerId, appDate, true)
            }
        } catch (error) {
            if (isInteractiveDailySetDestination(item)) {
                this.bot.logger.info(this.bot.isMobile, 'MOBILE-DAILY-SET',
                    `[PLAN] dailySet entry_probe_unverified offerId=${offerId} appDate=${appDate}`)
                return
            }
            this.bot.logger.warn(
                this.bot.isMobile,
                'MOBILE-DAILY-SET',
                `Unable to execute App Daily Set offer | offerId=${offerId} | message=${error instanceof Error ? error.message : String(error)}`
            )
        }
    }

    private async probeEntry(destination: MobileDailySetDestination, offerId: string, appDate: string): Promise<void> {
        const log = (result: string) => this.bot.logger.info(this.bot.isMobile, 'MOBILE-DAILY-SET',
            `[PLAN] dailySet entry_probe_${result} offerId=${offerId} appDate=${appDate}`)
        log('pending')
        const result = await probeDailySetEntry(async () => {
            const page = this.bot.mainMobilePage
            if (!page || page.isClosed()) throw new Error('mobile_page_missing')
            await this.applyBingAppBrowserProfile()
            const response = await page.goto(this.buildBingAppNavigationUrl(destination.url), {
                waitUntil: 'domcontentloaded', timeout: 20000
            })
            if (response && response.status() >= 400) throw new Error('entry_navigation_failed')
            if (typeof page.url === 'function' && !trustedDailySetEntry(page.url(), offerId)) throw new Error('entry_redirect_untrusted')
        }, async () => {
            const fresh = await this.bot.browser.func.getAppDashboardData()
            if (resolveAppDailySetDate(fresh) !== appDate) return null
            const card = findMobileDailySet(fresh, appDate).find(p => p.attributes.offerid === offerId)
            return card ? progressOf(card).complete : null
        }, () => this.bot.utils.wait(3000))
        log(result)
    }

    private resolveDestination(item: Promotion, offerId: string): MobileDailySetDestination | null {
        const attrs = item.attributes ?? {}
        const raw = attrs.destination_url || attrs.destinationUrl || attrs.destination || attrs.url
        if (!raw || !trustedDailySetEntry(raw, offerId)) return null

        try {
            const outer = new URL(raw)
            if (!this.isTrustedBingUrl(outer)) return null

            const nested = outer.pathname.toLowerCase() === '/rewards/checkuser'
                ? outer.searchParams.get('ru')
                : null
            const taskUrl = nested ? new URL(nested, outer.origin) : outer
            if (!this.isTrustedBingUrl(taskUrl)) return null

            if (taskUrl.pathname.toLowerCase() !== '/search') {
                return { url: raw, kind: 'url' }
            }

            const filters = taskUrl.searchParams.get('filters') ?? ''
            const linkedOfferIds = Array.from(filters.matchAll(/(?:BTDSUOID|BTROID):"([^"]+)"/gi), match => match[1])
            if (linkedOfferIds.length > 0 && !linkedOfferIds.includes(offerId)) return null

            const kind: MobileDailySetKind = /PollScenarioId:/i.test(filters)
                ? 'poll'
                : taskUrl.searchParams.get('rqpiodemo') === '1'
                    ? 'quiz'
                    : 'url'
            return { url: raw, kind }
        } catch {
            return null
        }
    }

    private isTrustedBingUrl(url: URL): boolean {
        const hostname = url.hostname.toLowerCase()
        return url.protocol === 'https:' && (hostname === 'bing.com' || hostname.endsWith('.bing.com'))
    }

    private async executeDestination(destination: MobileDailySetDestination, offerId: string): Promise<void> {
        const page = this.bot.mainMobilePage
        if (!page || page.isClosed()) throw new Error('mobile_page_unavailable')

        await this.applyBingAppBrowserProfile()
        const navigationUrl = this.buildBingAppNavigationUrl(destination.url)

        this.bot.logger.info(
            this.bot.isMobile,
            'MOBILE-DAILY-SET',
            `Opening verified Bing App task | offerId=${offerId} | kind=${destination.kind}`
        )
        const response = await page.goto(navigationUrl, { waitUntil: 'domcontentloaded', timeout: 20000 })
        await this.bot.utils.wait(this.bot.utils.randomDelay(2500, 4500))

        const finalUrl = new URL(typeof page.url === 'function' ? page.url() : destination.url)
        const browserUserAgent = typeof page.evaluate === 'function'
            ? await page.evaluate(() => navigator.userAgent)
            : ''
        const requestUserAgent = response && typeof response.request().allHeaders === 'function'
            ? (await response.request().allHeaders())['user-agent'] ?? ''
            : ''
        const bingCookies = typeof page.context === 'function'
            ? await page.context().cookies(typeof page.url === 'function' ? page.url() : destination.url)
            : []
        const diagnosticFrames = typeof page.frames === 'function' ? page.frames() : []
        const surfaces = await Promise.all(diagnosticFrames.map(async frame => {
            try {
                return await frame.evaluate(() => {
                    const text = document.body?.innerText || ''
                    return {
                        poll: /Microsoft Rewards Poll/i.test(text),
                        quiz: /Microsoft Rewards Quiz/i.test(text),
                        rewardProgress: /\d+\s*\/\s*\d+\s*points/i.test(text),
                        options: document.querySelectorAll('.acf-button-standard__link, [id^="btoption"], .btOption').length
                    }
                })
            } catch {
                return { poll: false, quiz: false, rewardProgress: false, options: 0 }
            }
        }))
        const pageSurface = surfaces.reduce((summary, surface) => ({
            poll: summary.poll || surface.poll,
            quiz: summary.quiz || surface.quiz,
            rewardProgress: summary.rewardProgress || surface.rewardProgress,
            options: summary.options + surface.options
        }), { poll: false, quiz: false, rewardProgress: false, options: 0 })
        this.bot.logger.info(
            this.bot.isMobile,
            'MOBILE-DAILY-SET',
            `Bing task page ready | offerId=${offerId} | kind=${destination.kind} | status=${response?.status() ?? 0} | host=${finalUrl.hostname} | path=${finalUrl.pathname} | browserAppProfile=${/BingSapphire\//i.test(browserUserAgent)} | requestAppProfile=${/BingSapphire\//i.test(requestUserAgent)} | bingAuth=${bingCookies.some(cookie => cookie.name === '_U')} | rewardsPoll=${pageSurface.poll} | rewardsQuiz=${pageSurface.quiz} | rewardProgress=${pageSurface.rewardProgress} | optionCount=${pageSurface.options}`
        )

        if (destination.kind === 'url') {
            await this.interactWithUrlDestination(destination, offerId)
            return
        }

        if (destination.kind === 'poll' || pageSurface.poll) {
            const isClosed = await this.isPollClosed()
            if (isClosed) {
                this.bot.logger.info(
                    this.bot.isMobile,
                    'MOBILE-DAILY-SET',
                    `Daily poll is closed or not yet active on server | offerId=${offerId}`
                )
                return
            }
        }

        await this.tryDismissPopups()
        await this.tryClickStartControl()

        const maxActions = 15
        let clicks = 0
        let hasAnsweredCurrentQuestion = false
        const answeredSignatures = new Set<string>()
        let idleRetries = 0
        let settledRetries = 0

        while (clicks < maxActions) {
            if (page.isClosed()) break

            // 1. 如果当前题尚未作答，必须先寻找可用选项并作答（严禁在答题前去点 Next）
            if (!hasAnsweredCurrentQuestion) {
                const answer = await this.findVisibleOption(destination.kind, answeredSignatures)
                if (answer) {
                    try {
                        const isLink = (typeof answer.option.evaluate === 'function')
                            ? await answer.option.evaluate((el: HTMLElement) => el.tagName === 'A' || Boolean(el.getAttribute('href'))).catch(() => false)
                            : false
                        if (isLink && typeof page.waitForNavigation === 'function') {
                            await Promise.all([
                                page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 10000 }).catch(() => {}),
                                answer.option.click({ timeout: 5000 })
                            ])
                            await this.bot.utils.wait(3000)
                        } else {
                            await answer.option.click({ timeout: 5000 })
                        }
                        clicks++
                        hasAnsweredCurrentQuestion = true
                        if (answer.signature) answeredSignatures.add(answer.signature)
                        idleRetries = 0
                        settledRetries = 0
                        this.bot.logger.info(
                            this.bot.isMobile,
                            'MOBILE-DAILY-SET',
                            `Submitted option answer | offerId=${offerId} | actions=${clicks}`
                        )
                        await this.bot.utils.wait(this.bot.utils.randomDelay(2000, 3500))
                        continue
                    } catch {
                        break
                    }
                }

                // 未找到答题选项，重试若仍未找到则收敛
                idleRetries++
                if (idleRetries >= 2) {
                    this.bot.logger.info(
                        this.bot.isMobile,
                        'MOBILE-DAILY-SET',
                        `No further interactive elements found, terminating solve | offerId=${offerId} | actions=${clicks}`
                    )
                    break
                }
                await this.bot.utils.wait(1500)
                continue
            }

            // 2. 当前题已作答，优先寻找前进控制 (Next / Submit / View result)
            const advance = await this.findVisibleAdvanceControl()
            if (advance) {
                try {
                    await advance.control.click({ timeout: 5000 })
                    clicks++
                    idleRetries = 0
                    settledRetries = 0
                    this.bot.logger.info(
                        this.bot.isMobile,
                        'MOBILE-DAILY-SET',
                        `Advanced interactive step (${advance.label}) | offerId=${offerId} | totalActions=${clicks}`
                    )
                    await this.bot.utils.wait(this.bot.utils.randomDelay(1500, 3000))
                    if (advance.label === 'view result') {
                        await this.bot.utils.wait(2000)
                        break
                    }
                    if (advance.label === 'next') {
                        hasAnsweredCurrentQuestion = false // 点击 Next 后，重置当前题答题标记以迎接新题目
                    }
                    continue
                } catch {}
            }

            // 3. 当前题已作答且没有前进控制，检查页面是否自动切题（自动切题如 This or That 时，新题签名不在已答集合中）
            const currentOption = await this.findVisibleOption(destination.kind, new Set())
            if (currentOption && currentOption.signature && !answeredSignatures.has(currentOption.signature)) {
                hasAnsweredCurrentQuestion = false
                idleRetries = 0
                settledRetries = 0
                continue
            }

            // 4. 当前题已作答且未切题：仅在明确为多选题型（如 Supersonic Quiz 需选出多个答案：Pick 5、Which 3）时才允许继续点击未选选项
            if (currentOption && currentOption.option && typeof page.evaluate === 'function') {
                const isMultiChoiceQuestion = await page.evaluate(() => {
                    const text = document.body?.innerText || ''
                    return /(?:which|pick|select|choose)\s+\d+|选出\s*\d+|选择\s*\d+|\b\d+\s+of\s+\d+\s+correct/i.test(text)
                }).catch(() => false)

                if (isMultiChoiceQuestion) {
                    try {
                        await currentOption.option.click({ timeout: 5000 })
                        clicks++
                        idleRetries = 0
                        settledRetries = 0
                        this.bot.logger.info(
                            this.bot.isMobile,
                            'MOBILE-DAILY-SET',
                            `Submitted additional option (multi-choice quiz) | offerId=${offerId} | actions=${clicks}`
                        )
                        await this.bot.utils.wait(this.bot.utils.randomDelay(2000, 3500))
                        continue
                    } catch {}
                }
            }

            // 5. 当前题已作答，且无需继续选择、无前进按钮：防抖重试，防止页面动画或网络延迟导致误退出
            settledRetries++
            if (settledRetries < 2) {
                await this.bot.utils.wait(2000)
                continue
            }

            // 6. 复检后确认既无可用操作，确认为终态 (如单选投票 Poll 或单题测验已展示百分比/结果)
            this.bot.logger.info(
                this.bot.isMobile,
                'MOBILE-DAILY-SET',
                `Interactive activity completed in settled state (no subsequent questions) | offerId=${offerId} | actions=${clicks}`
            )
            await this.bot.utils.wait(this.bot.utils.randomDelay(3000, 5000))
            break
        }

        if (clicks === 0) throw new Error(`${destination.kind}_options_unavailable`)
        this.bot.logger.info(
            this.bot.isMobile,
            'MOBILE-DAILY-SET',
            `Completed Bing App page interaction | offerId=${offerId} | kind=${destination.kind} | selections=${clicks}`
        )
    }

    private getOptionSelectors(kind: MobileDailySetKind): string[] {
        return kind === 'poll' ? this.pollOptionSelectors : this.quizOptionSelectors
    }

    private async isPollClosed(): Promise<boolean> {
        const page = this.bot.mainMobilePage
        if (!page || page.isClosed()) return false
        try {
            if (typeof page.evaluate === 'function') {
                return await page.evaluate(() => {
                    const text = document.body?.innerText || ''
                    return /the poll is closed/i.test(text) || /poll.*closed/i.test(text) || /投票.*已关闭/i.test(text)
                })
            }
        } catch {
            return false
        }
        return false
    }

    private async interactWithUrlDestination(destination: MobileDailySetDestination, offerId: string): Promise<void> {
        const page = this.bot.mainMobilePage
        if (!page || page.isClosed()) return

        if (typeof page.evaluate === 'function') {
            try {
                await page.evaluate(() => window.scrollBy(0, Math.max(300, window.innerHeight / 2)))
            } catch {}
        }

        const actionSelectors = [
            'button:has-text("Copy link")',
            'button:has-text("Share")',
            'button:has-text("复制链接")',
            'button:has-text("分享")',
            '[data-testid*="copy" i]',
            '[data-testid*="share" i]'
        ]

        for (const selector of actionSelectors) {
            try {
                if (typeof page.locator === 'function') {
                    const locator = page.locator(selector).first()
                    if (typeof locator.isVisible === 'function' && await locator.isVisible()) {
                        await locator.click({ timeout: 3000 })
                        this.bot.logger.info(
                            this.bot.isMobile,
                            'MOBILE-DAILY-SET',
                            `Interacted with action button on URL task | offerId=${offerId} | selector=${selector}`
                        )
                        await this.bot.utils.wait(this.bot.utils.randomDelay(1500, 3000))
                        return
                    }
                }
            } catch {}
        }
    }

    private buildBingAppNavigationUrl(raw: string): string {
        const outer = new URL(raw)
        const nested = outer.pathname.toLowerCase() === '/rewards/checkuser'
            ? outer.searchParams.get('ru')
            : null
        const taskUrl = nested ? new URL(nested, outer.origin) : outer

        if (!taskUrl.searchParams.has('PC')) taskUrl.searchParams.set('PC', BING_APP_BROWSER_PC)
        if (!taskUrl.searchParams.has('ssp')) taskUrl.searchParams.set('ssp', '1')
        if (!taskUrl.searchParams.has('safesearch')) taskUrl.searchParams.set('safesearch', 'moderate')
        if (!taskUrl.searchParams.has('setlang')) {
            taskUrl.searchParams.set('setlang', this.bot.accountLocale?.language ?? this.bot.userData.langCode ?? 'en')
        }

        if (!nested) return taskUrl.toString()
        outer.searchParams.set('ru', `${taskUrl.pathname}${taskUrl.search}${taskUrl.hash}`)
        return outer.toString()
    }

    private async applyBingAppBrowserProfile(): Promise<void> {
        if (this.appBrowserProfileApplied) return
        const page = this.bot.mainMobilePage
        if (!page || page.isClosed()) return

        const context = typeof page.context === 'function' ? page.context() : null
        if (context && typeof context.newCDPSession === 'function') {
            const session = await context.newCDPSession(page)
            await session.send('Network.setUserAgentOverride', {
                userAgent: BING_APP_USER_AGENT,
                acceptLanguage: this.bot.accountLocale?.acceptLanguage ?? 'en',
                platform: 'Android'
            })
        } else if (typeof page.setExtraHTTPHeaders === 'function') {
            await page.setExtraHTTPHeaders({ 'User-Agent': BING_APP_USER_AGENT })
        }
        this.appBrowserProfileApplied = true
    }

    private async tryDismissPopups(): Promise<void> {
        const page = this.bot.mainMobilePage
        if (!page || page.isClosed() || typeof page.locator !== 'function') return
        const dismissSelectors = [
            '#bnp_btn_accept',
            '#bnp_close_link',
            'button[id*="accept" i]',
            'button[id*="consent" i]',
            'button[aria-label*="Close" i]',
            'button:has-text("Accept")',
            'button:has-text("接受")',
            'button:has-text("Maybe later")',
            'button:has-text("稍后再说")',
            'button:has-text("不用了")'
        ]
        for (const selector of dismissSelectors) {
            try {
                const btn = page.locator(selector).first()
                if (typeof btn.isVisible === 'function' && await btn.isVisible().catch(() => false)) {
                    await btn.click({ timeout: 2000 }).catch(() => {})
                }
            } catch {}
        }
    }

    private async tryClickStartControl(): Promise<void> {
        const page = this.bot.mainMobilePage
        if (!page || page.isClosed() || typeof page.locator !== 'function') return
        const startSelectors = [
            '#rqStartQuiz',
            'button:has-text("Start playing")',
            'a:has-text("Start playing")',
            'button:has-text("Get started")',
            'a:has-text("Get started")',
            'button:has-text("Take the quiz")',
            'a:has-text("Take the quiz")',
            'button:has-text("Start quiz")',
            'a:has-text("Start quiz")',
            'button:has-text("Play now")',
            'a:has-text("Play now")',
            'input[type="button"][value*="Start" i]',
            'input[type="button"][value*="Take" i]',
            'input[type="button"][value*="Play" i]',
            'input[type="submit"][value*="Start" i]',
            'input[type="submit"][value*="Take" i]',
            'input[type="submit"][value*="Play" i]',
            '[data-testid*="start" i]',
            'button:has-text("开始")',
            'a:has-text("开始")'
        ]
        const hosts = (typeof page.frames === 'function' && page.frames().length > 0) ? page.frames() : [page]
        for (const host of hosts) {
            if (typeof host.locator !== 'function') continue
            for (const selector of startSelectors) {
                try {
                    const btn = host.locator(selector).first()
                    if (typeof btn.isVisible === 'function' && await btn.isVisible().catch(() => false)) {
                        await btn.click({ timeout: 4000 }).catch(() => {})
                        await this.bot.utils.wait(2000)
                        return
                    }
                } catch {}
            }
        }
    }

    private async isOptionAlreadySelected(option: any): Promise<boolean> {
        if (!option || typeof option.evaluate !== 'function') return false
        try {
            return await option.evaluate((el: HTMLElement) => {
                const cls = el.className || ''
                if (typeof cls === 'string' && /b_selected|selected|cbt_ans|bt_correct|bt_wrong|bt_cardCorrect|bt_cardIncorrect|b_ans/i.test(cls)) {
                    return true
                }
                const checked = el.getAttribute('aria-checked')
                if (checked === 'true') return true
                const disabled = el.getAttribute('aria-disabled')
                if (disabled === 'true') return true
                if (el.hasAttribute('disabled')) return true
                if (el.querySelector('.bt_correct, .bt_wrong, .cbt_ans, .b_check, .bt_check')) {
                    return true
                }
                return false
            })
        } catch {
            return false
        }
    }

    private async isPaginationControl(control: any): Promise<boolean> {
        if (!control || typeof control.evaluate !== 'function') return false
        try {
            return await control.evaluate((el: HTMLElement) => {
                const nav = el.closest('.b_pag, .sb_pag, nav, footer, header')
                if (nav) return true
                const cls = el.className || ''
                if (typeof cls === 'string' && /sb_pag|b_pag|b_widePag|sb_bp/i.test(cls)) return true
                const aria = el.getAttribute('aria-label') || ''
                const title = el.getAttribute('title') || ''
                if (/page|下一页|上一页/i.test(aria) || /page|下一页|上一页/i.test(title)) return true
                const href = el.getAttribute('href') || ''
                if (/first=\d+|FORM=PORE/i.test(href)) return true
                return false
            })
        } catch {
            return false
        }
    }

    private async findVisibleAdvanceControl() {
        const page = this.bot.mainMobilePage
        if (!page || page.isClosed()) return null
        const hosts = typeof page.frames === 'function' && page.frames().length > 0
            ? page.frames()
            : [page]

        for (const host of hosts) {
            if (typeof host.locator !== 'function') continue
            for (const selector of this.advanceSelectors) {
                const controls = host.locator(selector)
                const count = typeof controls.count === 'function' ? await controls.count().catch(() => 0) : 0
                for (let index = 0; index < count; index++) {
                    const control = typeof controls.nth === 'function' ? controls.nth(index) : controls.first()
                    if (typeof control.isVisible === 'function' && !await control.isVisible().catch(() => false)) continue
                    if (typeof control.isEnabled === 'function' && !await control.isEnabled().catch(() => false)) continue
                    if (await this.isPaginationControl(control)) continue
                    const text = typeof control.textContent === 'function'
                        ? (String(await control.textContent().catch(() => '') ?? '') || String(await control.getAttribute('value').catch(() => '') ?? '')).trim().toLowerCase()
                        : ''
                    const isNext = text === 'next' || text.includes('next') || text.includes('下一')
                    const isSubmit = text === 'submit' || text.includes('submit') || text.includes('check') || text.includes('提交')
                    const isResult = text === 'view result' || text.includes('result') || text.includes('结果') || text.includes('score')
                    if (!isNext && !isSubmit && !isResult) continue
                    return { control, label: isResult ? 'view result' : isSubmit ? 'submit' : 'next' }
                }
            }
        }
        return null
    }

    private async findVisibleOption(kind: MobileDailySetKind, visitedOptionSets: Set<string>) {
        const page = this.bot.mainMobilePage
        if (!page || page.isClosed()) return null
        const hosts = typeof page.frames === 'function' && page.frames().length > 0
            ? page.frames()
            : [page]

        const selectors = this.getOptionSelectors(kind)

        for (const [hostIndex, host] of hosts.entries()) {
            if (typeof host.locator !== 'function') continue
            for (const selector of selectors) {
                const options = host.locator(selector)
                const count = typeof options.count === 'function' ? await options.count().catch(() => 0) : 0
                const labels: string[] = []
                for (let index = 0; index < count; index++) {
                    const candidate = typeof options.nth === 'function' ? options.nth(index) : options.first()
                    const text = String((await candidate.textContent?.().catch(() => '')) || (await candidate.getAttribute?.('value').catch(() => '')) || '').trim()
                    if (text) labels.push(text)
                }
                const signature = labels.some(Boolean)
                    ? `${hostIndex}:${selector}:${labels.join('|')}`
                    : ''
                if (signature && visitedOptionSets.has(signature)) continue
                for (let index = 0; index < count; index++) {
                    const option = typeof options.nth === 'function' ? options.nth(index) : options.first()
                    if (typeof option.isVisible === 'function' && !await option.isVisible().catch(() => false)) continue
                    if (typeof option.isEnabled === 'function' && !await option.isEnabled().catch(() => false)) continue
                    if (await this.isPaginationControl(option)) continue
                    if (await this.isOptionAlreadySelected(option)) continue
                    const text = (String((await option.textContent?.().catch(() => '')) || (await option.getAttribute?.('value').catch(() => '')) || '')).trim().toLowerCase()
                    if (text === 'next' || text.includes('next') || text.includes('下一') || text.includes('result') || text.includes('结果') || text.includes('event')) continue
                    return { option, signature }
                }
            }
        }
        return null
    }

    private async retryUrlDestination(destination: MobileDailySetDestination, offerId: string): Promise<void> {
        const page = this.bot.mainMobilePage
        if (!page || page.isClosed()) return
        this.bot.logger.info(
            this.bot.isMobile,
            'MOBILE-DAILY-SET',
            `Retrying URL task after official state remained pending | offerId=${offerId}`
        )
        if (typeof page.reload === 'function') {
            await page.reload({ waitUntil: 'domcontentloaded', timeout: 20000 })
        } else {
            await page.goto(destination.url, { waitUntil: 'domcontentloaded', timeout: 20000 })
        }
        await this.interactWithUrlDestination(destination, offerId)
        await this.bot.utils.wait(this.bot.utils.randomDelay(4000, 7000))
    }

    private async verifyOffer(offerId: string, appDate: string, logFailure = true): Promise<boolean> {
        await this.bot.utils.wait(this.bot.utils.randomDelay(2000, 4000))
        const fresh = await this.bot.browser.func.getAppDashboardData()
        const latest = findMobileDailySet(fresh, appDate).find(
            promotion => promotion.attributes.offerid === offerId
        )
        const progress = progressOf(latest ?? null)

        if (!latest || !progress.complete) {
            if (!logFailure) return false
            this.bot.logger.warn(
                this.bot.isMobile,
                'MOBILE-DAILY-SET',
                `Daily Set remains incomplete in SAAndroid | offerId=${offerId} | progress=${progress.earned}/${progress.max}`
            )
            return false
        }

        const newBalance = Number(fresh.response?.balance ?? this.bot.userData.currentPoints)
        const oldBalance = Number(this.bot.userData.currentPoints ?? 0)
        const gainedPoints = Math.max(0, newBalance - oldBalance)
        this.bot.userData.currentPoints = newBalance
        this.bot.userData.gainedPoints = (this.bot.userData.gainedPoints ?? 0) + gainedPoints
        this.bot.logger.info(
            this.bot.isMobile,
            'MOBILE-DAILY-SET',
            `Daily Set completion verified by SAAndroid | offerId=${offerId} | progress=${progress.earned}/${progress.max} | pointsGained=${gainedPoints}`,
            'green'
        )
        return true
    }
}
