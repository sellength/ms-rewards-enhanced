import test from 'node:test'
import assert from 'node:assert/strict'
import { probeDailySetEntry, trustedDailySetEntry } from '../../dist/util/DailySetEntryProbe.js'
import { MobileDailySet } from '../../dist/functions/activities/app/MobileDailySet.js'
import { DailySet } from '../../dist/functions/activities/rewards/DailySet.js'
import { createDailySetProbeState } from './dailySetProbeState.mjs'
import { shouldRefreshRun } from './liveRunSync.mjs'
import { readFileSync } from 'node:fs'

test('entry probe opens once, accepts delayed completion and bounds pending reads', async () => {
    for (const sequence of [[true], [false, true], [false, false, false], [null], [false, null]]) {
        let opened = 0, reads = 0
        const result = await probeDailySetEntry(async () => { opened++ }, async () => sequence[reads++], async () => {})
        assert.equal(opened, 1)
        assert.equal(reads, sequence.length)
        assert.equal(result, sequence.includes(true) ? 'complete' : sequence.includes(null) ? 'unverified' : 'interaction_required')
    }
    assert.equal(await probeDailySetEntry(async () => { throw Error() }, async () => assert.fail(), async () => {}), 'unverified')
    assert.equal(await probeDailySetEntry(async () => {}, async () => { throw Error() }, async () => {}), 'unverified')
})

test('only trustworthy same-offer navigation is allowed, including nested URLs', () => {
    assert.equal(trustedDailySetEntry('https://www.bing.com/search?filters=BTROID:%22task%22', 'task'), true)
    for (const url of ['http://www.bing.com/search', 'https://bing.com.evil.test/', 'https://user:pass@bing.com/',
        'https://www.bing.com/rewards/checkuser?ru=https://evil.test/',
        'https://www.bing.com/rewards/checkuser?ru=/search?filters=BTROID:%22other%22',
        'https://www.bing.com/search?filters=BTROID:%22task%22+BTDSUOID:%22other%22']) {
        assert.equal(trustedDailySetEntry(url, 'task'), false)
    }
})

for (const platform of ['mobile', 'desktop']) {
    for (const outcome of ['complete', 'pending', 'missing', 'rollover', 'read_error', 'navigation_error', 'http_error', 'redirect', 'already_complete']) {
        test(`${platform} entry-only workflow: ${outcome}`, async () => {
            const date = '09/14/2026', next = '09/15/2026', id = 'Gamification_DailySet_20260914_Child3'
            let opened = 0, reads = 0
            const logs = []
            const card = { offerId: id, destinationUrl: `https://www.bing.com/search?filters=PollScenarioId:test+BTROID:%22${id}%22`,
                complete: false, pointProgress: 0, pointProgressMax: 10 }
            const read = async () => {
                reads++
                if (opened && outcome === 'read_error') throw Error('offline')
                const complete = outcome === 'already_complete' || (opened && outcome === 'complete')
                const currentDate = opened && outcome === 'rollover' ? next : date
                const present = !(opened && outcome === 'missing')
                if (platform === 'mobile') return { response: { promotions: [
                    { name: 'BingFlyout_Layout_DailyCheckIn', attributes: { markettime: currentDate === date ? '20260914T12:00:00' : '20260915T00:00:01' } },
                    ...(present ? [{ name: id, attributes: { offerid: id, daily_set_date: currentDate, type: 'urlreward',
                        destination: card.destinationUrl, max: '10', complete: String(Boolean(complete)) } }] : [])
                ] } }
                bot.reactSnapshot = { offers: [{ offerId: currentDate === date ? id : 'Gamification_DailySet_20260915_Child3' }] }
                return { dashboard: { dailySetPromotions: { [currentDate]: present ? [{ ...card, complete: Boolean(complete) }] : [] } } }
            }
            const page = { isClosed: () => false,
                url: () => outcome === 'redirect' ? 'https://login.live.com/' : card.destinationUrl,
                goto: async () => {
                opened++
                if (outcome === 'navigation_error') throw Error('navigation')
                return { status: () => outcome === 'http_error' ? 503 : 200 }
            } }
            const bot = { isMobile: platform === 'mobile', dailySetDate: date, userData: { langCode: 'en' },
                mainMobilePage: page, mainDesktopPage: page,
                browser: { func: { getAppDashboardData: read, getDashboardData: read, refreshEarnSnapshot: async () => bot.reactSnapshot, synchronizeActiveBrowserCookies: async () => {} } },
                activities: { doAppActivity: async () => assert.fail('must not POST'), doUrlReward: async () => assert.fail('must not submit') },
                logger: { info: (...a) => logs.push(a.join(' ')), warn: (...a) => logs.push(a.join(' ')) },
                utils: { wait: async () => {}, randomDelay: () => 0 } }
            const worker = platform === 'mobile' ? new MobileDailySet(bot) : new DailySet(bot)
            if (platform === 'mobile') worker.applyBingAppBrowserProfile = async () => {}
            // Preflight knows the card; current same-source response may have since changed.
            const initial = await read()
            if (outcome === 'already_complete') {
                if (platform === 'mobile') initial.response.promotions[1].attributes.complete = 'False'
                else initial.dashboard.dailySetPromotions[date][0].complete = false
            }
            await worker.run(initial)
            assert.equal(opened, outcome === 'already_complete' ? 0 : 1)
            assert.ok(reads <= 6)
            const expected = outcome === 'already_complete' ? /skip_complete|entry_probe_complete/ :
                outcome === 'complete' ? /entry_probe_complete/ :
                outcome === 'pending' ? /entry_probe_interaction_required/ : /entry_probe_unverified/
            assert.ok(logs.some(l => expected.test(l)), logs.join('\n'))
        })
    }
}

test('interaction advice is scoped and never fabricates official completion', () => {
    const memory = createDailySetProbeState()
    const line = '[PLAN] dailySet entry_probe_interaction_required offerId=offer appDate=09/14/2026'
    memory.record('account-a', 'mobile', line)
    const state = (date = '09/14/2026', complete = false) => ({ dailySetDate: date, dailySetCards: [{ offerId: 'offer', complete }] })
    assert.equal(memory.apply('account-a', 'mobile', state()).dailySetCards[0].requiresAppInteraction, true)
    for (const [account, platform, date] of [['account-b', 'mobile', '09/14/2026'], ['account-a', 'desktop', '09/14/2026'], ['account-a', 'mobile', '09/15/2026']]) {
        assert.equal(memory.apply(account, platform, state(date)).dailySetCards[0].requiresAppInteraction, false)
    }
    assert.equal(memory.apply('account-a', 'mobile', state('09/14/2026', true)).dailySetCards[0].requiresAppInteraction, false)
    memory.record('account-a', 'mobile', line.replace('interaction_required', 'unverified'))
    const card = memory.apply('account-a', 'mobile', state()).dailySetCards[0]
    assert.equal(card.requiresAppInteraction, false)
    assert.equal(card.entryProbeResult, 'unverified')
    assert.equal(card.complete, false)
    assert.equal(createDailySetProbeState().apply('account-a', 'mobile', state()).dailySetCards[0].requiresAppInteraction, false)
})

test('probe lifecycle drives per-item state and only terminal probes request a throttled official refresh', () => {
    const web = readFileSync(new URL('../../web.mjs', import.meta.url), 'utf8')
    const source = web.slice(web.indexOf('function recordTaskLifecycle('), web.indexOf('function isTaskFailureLog('))
    const calls = [], memory = createDailySetProbeState()
    const record = new Function('dailySetProbeState', 'broadcastTaskStatus', `
        const activeRunPlatform='mobile', activeProbeAccount='account-a', activeRunTaskIds=new Set(['dailySet']);
        ${source}; return recordTaskLifecycle;
    `)(memory, (...args) => calls.push(args))
    for (const result of ['pending', 'interaction_required', 'unverified', 'complete']) {
        const line = `[PLAN] dailySet entry_probe_${result} offerId=offer appDate=09/14/2026`
        record('desktop', line)
        record('mobile', line)
        assert.equal(shouldRefreshRun(line), result !== 'pending')
    }
    assert.deepEqual(calls.map(a => [a[0], a[2], a[3], a[4]]), [
        ['mobile', 'RUNNING', 'entry_probe_pending', 'offer'],
        ['mobile', 'PENDING', 'entry_probe_interaction_required', 'offer'],
        ['mobile', 'PENDING', 'entry_probe_unverified', 'offer'],
        ['mobile', 'DONE', 'entry_probe_complete', 'offer']
    ])
})

test('runtime probe badges distinguish required interaction, uncertainty and official completion', () => {
    const html = readFileSync(new URL('../../public/index.html', import.meta.url), 'utf8')
    const source = html.slice(html.indexOf('function paintTaskElement('), html.indexOf('function paintTaskGroup('))
    for (const [done, detail, expected] of [
        [false, 'entry_probe_interaction_required', '需要交互'],
        [false, 'entry_probe_unverified', '待核实'],
        [true, 'entry_probe_interaction_required', '已完成']
    ]) {
        const badge = { dataset: {} }
        const paint = new Function('taskBadgeHost', 'TASK_STATUS_META', `${source}; return paintTaskElement;`)(
            () => ({ querySelector: () => badge }), { DONE: ['✓', '已完成'], PENDING: ['', '待完成'] })
        paint({ dataset: { taskItemDone: String(done) } }, 'PENDING', detail)
    }
})

test('adaptive interactive solve: poll-like activity completes in exactly 1 click without loops', async () => {
    let clicks = 0
    const mockOption = {
        textContent: async () => 'Choice A',
        isVisible: async () => true,
        isEnabled: async () => true,
        click: async () => { clicks++ }
    }
    const page = {
        isClosed: () => false,
        frames: () => [],
        locator: (sel) => {
            if (sel.includes('btoption') || sel.includes('btOption') || sel.includes('choice') || sel.includes('acf-button-standard')) {
                return {
                    first: () => mockOption,
                    count: async () => 2,
                    nth: () => mockOption
                }
            }
            return {
                first: () => ({ isVisible: async () => false, isEnabled: async () => false }),
                count: async () => 0
            }
        },
        url: () => 'https://www.bing.com/search?q=test'
    }
    const bot = {
        isMobile: false,
        logger: { info: () => {}, warn: () => {}, debug: () => {} },
        utils: { wait: async () => {}, randomDelay: () => 0 }
    }
    const dailySet = new DailySet(bot)
    const actions = await dailySet.solveAdaptiveInteractiveDailySet(page, 'poll_adaptive_test')
    assert.equal(clicks, 1, 'Poll must click exactly one option')
    assert.equal(actions, 1, 'Adaptive solve must finish with 1 action and terminate')
})

test('adaptive interactive solve: multi-question quiz advances with next and view result controls', async () => {
    let questionIndex = 1
    let optionClicks = 0
    let nextClicks = 0
    let viewResultClicks = 0

    const mockOption = {
        textContent: async () => `Question ${questionIndex} Option`,
        isVisible: async () => true,
        isEnabled: async () => true,
        click: async () => { optionClicks++ }
    }

    const mockNext = {
        textContent: async () => 'Next question',
        isVisible: async () => true,
        isEnabled: async () => true,
        click: async () => {
            nextClicks++
            questionIndex = 2 // Advance to question 2
        }
    }

    const mockViewResult = {
        textContent: async () => 'View result',
        isVisible: async () => true,
        isEnabled: async () => true,
        click: async () => {
            viewResultClicks++
        }
    }

    const page = {
        isClosed: () => false,
        frames: () => [],
        locator: (sel) => {
            // Check advance selectors
            if (sel.includes('Next') && questionIndex === 1 && optionClicks > 0) {
                return { first: () => mockNext, count: async () => 1, nth: () => mockNext }
            }
            if (sel.includes('result') && questionIndex === 2 && optionClicks > 1) {
                return { first: () => mockViewResult, count: async () => 1, nth: () => mockViewResult }
            }
            if (sel.includes('btoption') || sel.includes('btOption') || sel.includes('choice') || sel.includes('acf-button-standard__link')) {
                return {
                    first: () => mockOption,
                    count: async () => 2,
                    nth: () => mockOption
                }
            }
            return {
                first: () => ({ isVisible: async () => false, isEnabled: async () => false }),
                count: async () => 0
            }
        },
        url: () => 'https://www.bing.com/search?q=quiz'
    }

    const bot = {
        isMobile: false,
        logger: { info: () => {}, warn: () => {}, debug: () => {} },
        utils: { wait: async () => {}, randomDelay: () => 0 }
    }
    const dailySet = new DailySet(bot)
    const actions = await dailySet.solveAdaptiveInteractiveDailySet(page, 'quiz_adaptive_test')

    assert.equal(optionClicks, 2, 'Should answer both questions')
    assert.equal(nextClicks, 1, 'Should click Next after question 1')
    assert.equal(viewResultClicks, 1, 'Should click View result after question 2')
    assert.equal(actions, 4, 'Total actions should be 2 options + 1 Next + 1 View result')
})

test('adaptive interactive solve: clicks start control when present before answering', async () => {
    let startClicks = 0
    let optionClicks = 0

    const mockStart = {
        isVisible: async () => true,
        click: async () => { startClicks++ }
    }
    const mockOption = {
        textContent: async () => 'Answer',
        isVisible: async () => true,
        isEnabled: async () => true,
        click: async () => { optionClicks++ }
    }

    const page = {
        isClosed: () => false,
        frames: () => [],
        locator: (sel) => {
            if (sel.includes('Start playing') || sel.includes('rqStartQuiz')) {
                return { first: () => mockStart, count: async () => 1 }
            }
            if (sel.includes('btoption') || sel.includes('btOption') || sel.includes('choice') || sel.includes('acf-button-standard')) {
                return {
                    first: () => mockOption,
                    count: async () => 2,
                    nth: () => mockOption
                }
            }
            return {
                first: () => ({ isVisible: async () => false, isEnabled: async () => false }),
                count: async () => 0
            }
        },
        url: () => 'https://www.bing.com/search?q=test'
    }

    const bot = {
        isMobile: false,
        logger: { info: () => {}, warn: () => {}, debug: () => {} },
        utils: { wait: async () => {}, randomDelay: () => 0 }
    }
    const dailySet = new DailySet(bot)
    await dailySet.solveAdaptiveInteractiveDailySet(page, 'start_adaptive_test')

    assert.equal(startClicks, 1, 'Must click Start control')
    assert.equal(optionClicks, 1, 'Must answer question after starting')
})

test('adaptive interactive solve: Bing search pagination Next page link is strictly ignored and answers option first', async () => {
    let paginationClicks = 0
    let optionClicks = 0

    const mockPaginationLink = {
        textContent: async () => 'Next',
        isVisible: async () => true,
        isEnabled: async () => true,
        evaluate: async (fn) => {
            // Emulate element with class sb_pagN and aria-label Next page
            const el = {
                closest: (selector) => selector.includes('.b_pag') || selector.includes('.sb_pag') ? {} : null,
                className: 'sb_pagN sb_pagN_bp b_widePag sb_bp',
                getAttribute: (attr) => attr === 'aria-label' ? 'Next page' : (attr === 'title' ? 'Next page' : '')
            }
            return fn(el)
        },
        click: async () => { paginationClicks++ }
    }

    const mockOption = {
        textContent: async () => 'Correct Choice',
        isVisible: async () => true,
        isEnabled: async () => true,
        evaluate: async () => false,
        click: async () => { optionClicks++ }
    }

    const page = {
        isClosed: () => false,
        frames: () => [],
        locator: (sel) => {
            if (sel.includes('Next')) {
                return {
                    first: () => mockPaginationLink,
                    count: async () => 1,
                    nth: () => mockPaginationLink
                }
            }
            if (sel.includes('btoption') || sel.includes('btOption') || sel.includes('choice') || sel.includes('acf-button-standard')) {
                return {
                    first: () => mockOption,
                    count: async () => 2,
                    nth: () => mockOption
                }
            }
            return {
                first: () => ({ isVisible: async () => false, isEnabled: async () => false }),
                count: async () => 0
            }
        },
        url: () => 'https://www.bing.com/search?q=test'
    }

    const bot = {
        isMobile: false,
        logger: { info: () => {}, warn: () => {}, debug: () => {} },
        utils: { wait: async () => {}, randomDelay: () => 0 }
    }
    const dailySet = new DailySet(bot)
    const actions = await dailySet.solveAdaptiveInteractiveDailySet(page, 'pagination_ignore_test')

    assert.equal(paginationClicks, 0, 'Must NEVER click Bing search pagination Next page link')
    assert.equal(optionClicks, 1, 'Must answer option instead of navigating search pagination')
    assert.equal(actions, 1, 'Poll or single question should cleanly finish in 1 action')
})

test('adaptive interactive solve: multi-choice quiz (e.g. Supersonic quiz) selects multiple options until advance control appears', async () => {
    let clickedOptions = []
    let nextClicks = 0
    let quizFinished = false
    const availableOptions = ['Card 1', 'Card 2', 'Card 3']

    const mockNext = {
        textContent: async () => 'Next question',
        isVisible: async () => clickedOptions.length >= 2 && !quizFinished,
        isEnabled: async () => clickedOptions.length >= 2 && !quizFinished,
        click: async () => {
            nextClicks++
            quizFinished = true
        }
    }

    const page = {
        isClosed: () => false,
        frames: () => [],
        evaluate: async (fn) => {
            // Emulate Supersonic Quiz instruction "Pick 3 correct answers"
            return fn()
        },
        locator: (sel) => {
            if (quizFinished) {
                return {
                    first: () => ({ isVisible: async () => false, isEnabled: async () => false }),
                    count: async () => 0
                }
            }
            if (sel.includes('Next')) {
                return {
                    first: () => mockNext,
                    count: async () => clickedOptions.length >= 2 && !quizFinished ? 1 : 0,
                    nth: () => mockNext
                }
            }
            if (sel.includes('bt_card') || sel.includes('btoption') || sel.includes('choice')) {
                const unselected = availableOptions.filter(opt => !clickedOptions.includes(opt))
                return {
                    first: () => {
                        const target = unselected[0]
                        return {
                            textContent: async () => target,
                            isVisible: async () => Boolean(target),
                            isEnabled: async () => Boolean(target),
                            click: async () => { if (target) clickedOptions.push(target) }
                        }
                    },
                    count: async () => unselected.length,
                    nth: (idx) => {
                        const target = unselected[idx]
                        return {
                            textContent: async () => target,
                            isVisible: async () => Boolean(target),
                            isEnabled: async () => Boolean(target),
                            click: async () => { if (target) clickedOptions.push(target) }
                        }
                    }
                }
            }
            return {
                first: () => ({ isVisible: async () => false, isEnabled: async () => false }),
                count: async () => 0
            }
        },
        url: () => 'https://www.bing.com/search?q=test'
    }

    // Set evaluate to return true for multi-choice
    page.evaluate = async () => true

    const bot = {
        isMobile: false,
        logger: { info: () => {}, warn: () => {}, debug: () => {} },
        utils: { wait: async () => {}, randomDelay: () => 0 }
    }
    const dailySet = new DailySet(bot)
    const actions = await dailySet.solveAdaptiveInteractiveDailySet(page, 'supersonic_test')

    assert.ok(clickedOptions.length >= 2, 'Must click multiple cards for multi-choice quiz')
    assert.equal(nextClicks, 1, 'Must click Next after picking required cards')
})


