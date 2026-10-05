import type { Page } from 'patchright'
import { resolveOfficialDailySetDate } from '../../../util/DailySetCycle'
import { BaseActivity } from '../BaseActivity'
import type { DashboardData } from '../../../interface/DashboardData'
import { isInteractiveDailySetDestination, isTomorrowLockedPromotion } from '../../../../promotion-classification.cjs'
import { probeDailySetEntry, trustedDailySetEntry } from '../../../util/DailySetEntryProbe'
import { PromotionActivityRunner } from './PromotionActivityRunner'

export class DailySet extends BaseActivity {
    public async run(data: DashboardData): Promise<void> {
        const today = this.bot.dailySetDate
        const dailySetMap = data.dashboard.dailySetPromotions ?? {}
        const allItems = today ? (dailySetMap[today] ?? []) : []

        if (!allItems.length) {
            this.bot.logger.warn(
                this.bot.isMobile,
                'DAILY-SET',
                `Microsoft returned no Daily Set for the official cycle (${today ?? 'unavailable'}); refusing to execute a different date`
            )
            return
        }
        this.bot.logger.info(
            this.bot.isMobile,
            'DAILY-SET-DUMP',
            JSON.stringify(
                allItems.map(p => ({
                    title: p.title || p.name,
                    points: `${p.pointProgress || 0}/${p.pointProgressMax || 0}`,
                    complete: Boolean(p.complete || (p.pointProgressMax > 0 && p.pointProgress >= p.pointProgressMax)),
                    offerId: p.offerId
                }))
            )
        )

        const pending =
            allItems.filter(item => {
                if (item.complete) return false
                const max = item.pointProgressMax || 0
                const cur = item.pointProgress || 0
                if (max > 0 && cur >= max) return false
                if (isTomorrowLockedPromotion(item) || item.exclusiveLockedFeatureStatus === 'locked') {
                    this.bot.logger.info(
                        this.bot.isMobile,
                        'DAILY-SET',
                        `[PLAN] dailySet skip_tomorrow_locked offerId=${item.offerId}`
                    )
                    return false
                }
                return true
            }) ?? []

        if (!pending.length) {
            this.bot.logger.info(this.bot.isMobile, 'DAILY-SET', 'All "Daily Set" items have already been completed')
            return
        }

        this.bot.logger.info(
            this.bot.isMobile,
            'DAILY-SET',
            `Started solving "Daily Set" items | remaining=${pending.length}`
        )
        const runner = new PromotionActivityRunner(this.bot)
        for (const [index, item] of pending.entries()) {
            if (index > 0) await this.bot.utils.wait(this.bot.utils.randomDelay(5000, 15000))
            if (!isInteractiveDailySetDestination(item)) {
                await runner.run([item])
                continue
            }
            const offerId = item.offerId
            const log = (result: string) => this.bot.logger.info(this.bot.isMobile, 'DAILY-SET',
                `[PLAN] dailySet entry_probe_${result} offerId=${offerId} appDate=${today}`)
            log('pending')
            try {
                const fresh = await this.bot.browser.func.getDashboardData()
                const card = fresh.dashboard.dailySetPromotions?.[today!]?.find(p => p.offerId === offerId)
                if (!card || resolveOfficialDailySetDate(Object.keys(fresh.dashboard.dailySetPromotions || {}),
                    ((await this.bot.browser.func.refreshEarnSnapshot())?.offers || []).map(p => p.offerId)) !== today) { log('unverified'); continue }
                if (card.complete || (card.pointProgressMax > 0 && card.pointProgress >= card.pointProgressMax)) {
                    log('complete'); continue
                }
                if (!trustedDailySetEntry(card.destinationUrl || '', offerId)) { log('unverified'); continue }
                const result = await probeDailySetEntry(async () => {
                    const page = this.bot.mainDesktopPage
                    if (!page || page.isClosed()) throw new Error('desktop_page_missing')
                    const response = await page.goto(card.destinationUrl, {
                        waitUntil: 'domcontentloaded',
                        timeout: 20000,
                        referer: 'https://rewards.bing.com/dashboard'
                    })
                    if (response && response.status() >= 400) throw new Error('entry_navigation_failed')
                    if (typeof page.url === 'function' && !trustedDailySetEntry(page.url(), offerId)) throw new Error('entry_redirect_untrusted')
                }, async () => {
                    await this.bot.browser.func.synchronizeActiveBrowserCookies('DAILY-SET-PROBE')
                    const data = await this.bot.browser.func.getDashboardData()
                    if (resolveOfficialDailySetDate(Object.keys(data.dashboard.dailySetPromotions || {}),
                        ((await this.bot.browser.func.refreshEarnSnapshot())?.offers || []).map(p => p.offerId)) !== today) return null
                    const current = data.dashboard.dailySetPromotions?.[today!]?.find(p => p.offerId === offerId)
                    return current ? Boolean(current.complete ||
                        (current.pointProgressMax > 0 && current.pointProgress >= current.pointProgressMax)) : null
                }, () => this.bot.utils.wait(3000))
                log(result)
                if (result === 'interaction_required') {
                    const page = this.bot.mainDesktopPage
                    if (page && !page.isClosed()) {
                        const actions = await this.solveAdaptiveInteractiveDailySet(page, offerId)
                        if (actions > 0) {
                            await this.bot.utils.wait(3000)
                            await this.bot.browser.func.synchronizeActiveBrowserCookies('DAILY-SET-SOLVED')
                            let checkData = await this.bot.browser.func.getDashboardData()
                            let checkCard = checkData.dashboard.dailySetPromotions?.[today!]?.find(p => p.offerId === offerId)
                            if (!checkCard || (!checkCard.complete && (!checkCard.pointProgressMax || checkCard.pointProgress < checkCard.pointProgressMax))) {
                                await this.bot.utils.wait(2500)
                                await this.bot.browser.func.synchronizeActiveBrowserCookies('DAILY-SET-SOLVED-RETRY')
                                checkData = await this.bot.browser.func.getDashboardData()
                                checkCard = checkData.dashboard.dailySetPromotions?.[today!]?.find(p => p.offerId === offerId)
                            }
                            if (checkCard && (checkCard.complete || (checkCard.pointProgressMax > 0 && checkCard.pointProgress >= checkCard.pointProgressMax))) {
                                log('complete')
                            } else {
                                await runner.run([card])
                                await this.bot.utils.wait(2000)
                                await this.bot.browser.func.synchronizeActiveBrowserCookies('DAILY-SET-FALLBACK')
                                const fallbackData = await this.bot.browser.func.getDashboardData()
                                const fallbackCard = fallbackData.dashboard.dailySetPromotions?.[today!]?.find(p => p.offerId === offerId)
                                if (fallbackCard && (fallbackCard.complete || (fallbackCard.pointProgressMax > 0 && fallbackCard.pointProgress >= fallbackCard.pointProgressMax))) {
                                    log('complete')
                                }
                            }
                        } else {
                            await runner.run([card])
                            await this.bot.utils.wait(2000)
                            await this.bot.browser.func.synchronizeActiveBrowserCookies('DAILY-SET-FALLBACK')
                            const checkData = await this.bot.browser.func.getDashboardData()
                            const checkCard = checkData.dashboard.dailySetPromotions?.[today!]?.find(p => p.offerId === offerId)
                            if (checkCard && (checkCard.complete || (checkCard.pointProgressMax > 0 && checkCard.pointProgress >= checkCard.pointProgressMax))) {
                                log('complete')
                            }
                        }
                    }
                }
            } catch { log('unverified') }
        }
        await this.verifyCloudState(today!)
    }

    private async verifyCloudState(today: string): Promise<void> {
        try {
            await this.bot.utils.wait(1500)
            await this.bot.browser.func.synchronizeActiveBrowserCookies('DAILY-SET-VERIFY')
            const fresh = await this.bot.browser.func.getDashboardData()
            const latest = fresh.dashboard.dailySetPromotions?.[today] ?? []
            const remaining = latest.filter(
                item =>
                    !item.complete &&
                    ((item.pointProgressMax || 0) > (item.pointProgress || 0) || !item.pointProgressMax)
            )
            const earned = latest.reduce(
                (sum, item) => sum + Math.min(item.pointProgress || 0, item.pointProgressMax || 0),
                0
            )
            const maximum = latest.reduce((sum, item) => sum + (item.pointProgressMax || 0), 0)

            if (latest.length > 0 && remaining.length === 0) {
                this.bot.logger.info(
                    this.bot.isMobile,
                    'DAILY-SET',
                    `Daily Set completion verified by Microsoft | progress=${earned}/${maximum} | completed=${latest.length}/${latest.length}`,
                    'green'
                )
                return
            }

            this.bot.logger.warn(
                this.bot.isMobile,
                'DAILY-SET',
                `Daily Set remains incomplete according to Microsoft | progress=${earned}/${maximum} | remaining=${remaining.map(item => item.offerId).join(', ') || 'unknown'}`
            )
        } catch (error) {
            this.bot.logger.warn(
                this.bot.isMobile,
                'DAILY-SET',
                `Unable to verify Daily Set cloud state | message=${error instanceof Error ? error.message : String(error)}`
            )
        }
    }

    private readonly desktopQuizOptionSelectors = [
        '.btp_choice_wrapper .acf-button-standard__link',
        'acf-button-standard.btp_choice',
        '.acf-button-standard__link',
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
        'div[role="button"][id^="choice"]'
    ]

    private readonly desktopAdvanceSelectors = [
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

    private async tryDismissPopups(page: Page): Promise<void> {
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

    private async isPollClosed(page: Page): Promise<boolean> {
        if (!page || page.isClosed() || typeof page.evaluate !== 'function') return false
        try {
            return await page.evaluate(() => {
                const text = document.body?.innerText || ''
                return /the poll is closed/i.test(text) || /poll.*closed/i.test(text) || /投票.*已关闭/i.test(text)
            })
        } catch {
            return false
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

    private async tryClickStartControl(page: Page): Promise<void> {
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

    private async findDesktopAdvanceControl(page: Page) {
        if (!page || page.isClosed() || typeof page.locator !== 'function') return null
        const hosts = (typeof page.frames === 'function' && page.frames().length > 0) ? page.frames() : [page]

        for (const host of hosts) {
            if (typeof host.locator !== 'function') continue
            for (const selector of this.desktopAdvanceSelectors) {
                try {
                    const controls = host.locator(selector)
                    const count = typeof controls.count === 'function' ? await controls.count().catch(() => 0) : 0
                    for (let index = 0; index < count; index++) {
                        const control = typeof controls.nth === 'function' ? controls.nth(index) : controls.first()
                        if (typeof control.isVisible === 'function' && !(await control.isVisible().catch(() => false))) continue
                        if (typeof control.isEnabled === 'function' && !(await control.isEnabled().catch(() => false))) continue
                        if (await this.isPaginationControl(control)) continue
                        const text = typeof control.textContent === 'function'
                            ? (String((await control.textContent().catch(() => '')) ?? '') || String((await control.getAttribute('value').catch(() => '')) ?? '')).trim().toLowerCase()
                            : ''
                        const isNext = text === 'next' || text.includes('next') || text.includes('下一')
                        const isSubmit = text === 'submit' || text.includes('submit') || text.includes('check') || text.includes('提交')
                        const isResult = text === 'view result' || text.includes('result') || text.includes('结果') || text.includes('score')
                        if (!isNext && !isSubmit && !isResult) continue
                        return { control, label: isResult ? 'view result' : isSubmit ? 'submit' : 'next' }
                    }
                } catch {}
            }
        }
        return null
    }

    private async tryInteractWithUrlTask(page: Page, offerId: string): Promise<boolean> {
        if (!page || page.isClosed() || typeof page.locator !== 'function') return false
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
                const btn = page.locator(selector).first()
                if (typeof btn.isVisible === 'function' && await btn.isVisible().catch(() => false)) {
                    await btn.click({ timeout: 4000 }).catch(() => {})
                    this.bot.logger.info(
                        this.bot.isMobile,
                        'DAILY-SET',
                        `Interacted with action button on URL task | offerId=${offerId} | selector=${selector}`
                    )
                    await this.bot.utils.wait(2000)
                    return true
                }
            } catch {}
        }
        return false
    }

    private async findDesktopOption(page: Page, visitedSignatures: Set<string>) {
        if (!page || page.isClosed() || typeof page.locator !== 'function') return null
        const hosts = (typeof page.frames === 'function' && page.frames().length > 0) ? page.frames() : [page]

        for (const [hostIndex, host] of hosts.entries()) {
            if (typeof host.locator !== 'function') continue
            for (const selector of this.desktopQuizOptionSelectors) {
                try {
                    const options = host.locator(selector)
                    const count = typeof options.count === 'function' ? await options.count().catch(() => 0) : 0
                    if (count === 0) continue

                    const labels: string[] = []
                    for (let index = 0; index < count; index++) {
                        const candidate = typeof options.nth === 'function' ? options.nth(index) : options.first()
                        const text = String((await candidate.textContent?.().catch(() => '')) || (await candidate.getAttribute?.('value').catch(() => '')) || '').trim()
                        if (text) labels.push(text)
                    }
                    const signature = labels.length > 0 ? `${hostIndex}:${labels.join('|')}` : ''
                    if (signature && visitedSignatures.has(signature)) continue

                    for (let index = 0; index < count; index++) {
                        const option = typeof options.nth === 'function' ? options.nth(index) : options.first()
                        if (typeof option.isVisible === 'function' && !(await option.isVisible().catch(() => false))) continue
                        if (typeof option.isEnabled === 'function' && !(await option.isEnabled().catch(() => false))) continue
                        if (await this.isPaginationControl(option)) continue
                        if (await this.isOptionAlreadySelected(option)) continue
                        const text = (String((await option.textContent?.().catch(() => '')) || (await option.getAttribute?.('value').catch(() => '')) || '')).trim().toLowerCase()
                        if (text === 'next' || text.includes('next') || text.includes('下一') || text.includes('result') || text.includes('结果') || text.includes('event')) continue
                        return { option, signature }
                    }
                } catch {}
            }
        }
        return null
    }

    public async solveAdaptiveInteractiveDailySet(page: Page, offerId: string): Promise<number> {
        if (!page || page.isClosed() || typeof page.locator !== 'function') return 0
        this.bot.logger.info(
            this.bot.isMobile,
            'DAILY-SET',
            `Starting adaptive interactive solve | offerId=${offerId}`
        )

        try {
            // 1. 关闭可能遮挡页面的提示或 Cookie 弹窗
            await this.tryDismissPopups(page)

            // 1.1 检查投票是否因时区未开放或已关闭 (仅限 Poll 任务)
            const isPoll = /poll/i.test(offerId) || (typeof page.url === 'function' && /poll/i.test(page.url()))
            if (isPoll && await this.isPollClosed(page)) {
                this.bot.logger.info(
                    this.bot.isMobile,
                    'DAILY-SET',
                    `Daily poll is closed or not yet active on server | offerId=${offerId}`
                )
                return 0
            }

            // 2. URL 任务特定操作 (如分享/复制按钮)
            const urlInteracted = await this.tryInteractWithUrlTask(page, offerId)
            if (urlInteracted) return 1

            // 3. 尝试点击开始按钮 (Start playing / Get started / Take the quiz)
            await this.tryClickStartControl(page)

            const maxActions = 15
            let actions = 0
            let hasAnsweredCurrentQuestion = false
            const answeredSignatures = new Set<string>()
            let idleRetries = 0
            let settledRetries = 0

            while (actions < maxActions) {
                if (page.isClosed()) break

                // 1. 如果当前题尚未作答，必须先寻找可用选项并作答（严禁在答题前去点 Next）
                if (!hasAnsweredCurrentQuestion) {
                    const answer = await this.findDesktopOption(page, answeredSignatures)
                    if (answer) {
                        try {
                            // 拟人化阅读与思考延时 (2500ms ~ 4500ms)，避免机器秒答特征
                            this.bot.logger.info(
                                this.bot.isMobile,
                                'DAILY-SET',
                                `[HUMAN-SIM] Reading question and evaluating option | offerId=${offerId} | actions=${actions}`
                            )
                            await this.bot.utils.wait(this.bot.utils.randomDelay(2500, 4500))

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
                                // 优先使用拟人化鼠标移动与随机偏移点击
                                const box = typeof answer.option.boundingBox === 'function' ? await answer.option.boundingBox().catch(() => null) : null
                                if (box && page.mouse) {
                                    const targetX = box.x + box.width * (0.3 + Math.random() * 0.4)
                                    const targetY = box.y + box.height * (0.3 + Math.random() * 0.4)
                                    await page.mouse.move(targetX, targetY, { steps: 15 }).catch(() => {})
                                    await this.bot.utils.wait(this.bot.utils.randomDelay(150, 300))
                                    await page.mouse.down().catch(() => {})
                                    await this.bot.utils.wait(this.bot.utils.randomDelay(80, 160))
                                    await page.mouse.up().catch(() => {})
                                } else {
                                    await answer.option.click({ timeout: 5000 })
                                }
                            }
                            actions++
                            hasAnsweredCurrentQuestion = true
                            if (answer.signature) answeredSignatures.add(answer.signature)
                            idleRetries = 0
                            settledRetries = 0
                            this.bot.logger.info(
                                this.bot.isMobile,
                                'DAILY-SET',
                                `Submitted option answer | offerId=${offerId} | actions=${actions}`
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
                            'DAILY-SET',
                            `No further interactive elements found, terminating solve | offerId=${offerId} | actions=${actions}`
                        )
                        break
                    }
                    await this.bot.utils.wait(1500)
                    continue
                }

                // 2. 当前题已作答，优先寻找前进控制 (Next / Submit / View result)
                const advance = await this.findDesktopAdvanceControl(page)
                if (advance) {
                    try {
                        await this.bot.utils.wait(this.bot.utils.randomDelay(1500, 2500))
                        const box = typeof advance.control.boundingBox === 'function' ? await advance.control.boundingBox().catch(() => null) : null
                        if (box && page.mouse) {
                            const targetX = box.x + box.width * (0.3 + Math.random() * 0.4)
                            const targetY = box.y + box.height * (0.3 + Math.random() * 0.4)
                            await page.mouse.move(targetX, targetY, { steps: 12 }).catch(() => {})
                            await this.bot.utils.wait(this.bot.utils.randomDelay(120, 250))
                            await page.mouse.down().catch(() => {})
                            await this.bot.utils.wait(this.bot.utils.randomDelay(80, 150))
                            await page.mouse.up().catch(() => {})
                        } else {
                            await advance.control.click({ timeout: 5000 })
                        }
                        actions++
                        idleRetries = 0
                        settledRetries = 0
                        this.bot.logger.info(
                            this.bot.isMobile,
                            'DAILY-SET',
                            `Advanced interactive step (${advance.label}) | offerId=${offerId} | totalActions=${actions}`
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
                const currentOption = await this.findDesktopOption(page, new Set())
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
                            actions++
                            idleRetries = 0
                            settledRetries = 0
                            this.bot.logger.info(
                                this.bot.isMobile,
                                'DAILY-SET',
                                `Submitted additional option (multi-choice quiz) | offerId=${offerId} | actions=${actions}`
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
                    'DAILY-SET',
                    `Interactive activity completed in settled state (no subsequent questions) | offerId=${offerId} | actions=${actions}`
                )
                await this.bot.utils.wait(this.bot.utils.randomDelay(3000, 5000))
                break
            }

            this.bot.logger.info(
                this.bot.isMobile,
                'DAILY-SET',
                `Finished adaptive interactive solve | offerId=${offerId} | actions=${actions}`
            )
            return actions
        } catch (err) {
            this.bot.logger.warn(
                this.bot.isMobile,
                'DAILY-SET',
                `Adaptive interactive solve encountered error | offerId=${offerId} | error=${err instanceof Error ? err.message : String(err)}`
            )
            return 0
        }
    }

    public async solveInteractiveDailySet(page: Page, offerId: string, _isPoll?: boolean): Promise<number> {
        return this.solveAdaptiveInteractiveDailySet(page, offerId)
    }
}
