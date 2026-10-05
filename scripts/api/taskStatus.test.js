import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'
import { MorePromotions } from '../../dist/functions/activities/rewards/MorePromotions.js'
import { EdgeBrowsing } from '../../dist/functions/activities/experimental/EdgeBrowsing.js'
import ReactFuncModule from '../../dist/browser/ReactFunc.js'
import { selectPcKeepEarningPromotions, isInteractiveDailySetDestination } from '../../promotion-classification.mjs'

const webSource = fs.readFileSync(new URL('../../web.mjs', import.meta.url), 'utf8')
const pageSource = fs.readFileSync(new URL('../../public/index.html', import.meta.url), 'utf8')
const config = JSON.parse(fs.readFileSync(new URL('../../config.json', import.meta.url), 'utf8'))
const indexSource = fs.readFileSync(new URL('../../src/index.ts', import.meta.url), 'utf8')
const browserFuncSource = fs.readFileSync(new URL('../../src/browser/BrowserFunc.ts', import.meta.url), 'utf8')
const browserSource = fs.readFileSync(new URL('../../src/browser/Browser.ts', import.meta.url), 'utf8')
const morePromotionsSource = fs.readFileSync(
    new URL('../../src/functions/activities/rewards/MorePromotions.ts', import.meta.url),
    'utf8'
)
const ReactFunc = ReactFuncModule.default ?? ReactFuncModule

test('PC App streak badge and drawer share official progress without PC runtime inheritance', () => {
    const source = pageSource.slice(pageSource.indexOf('function desktopAppCheckInStatus('), pageSource.indexOf('function taskBadgeHost('))
    const label = { textContent: '' }
    const tile = {}
    const painted = []
    const { classify, render } = new Function('document', 'paintTaskElement', `${source}; return { classify: desktopAppCheckInStatus, render: renderDesktopAppCheckIn };`)(
        { getElementById: id => id === 'desktopAppCheckIn' ? label : tile },
        (element, status) => { assert.equal(element, tile); painted.push(status) }
    )
    for (const [appCheckIn, expected] of [
        ['Check-in: 1/1', 'DONE'], ['1 / 1', 'DONE'], ['Check-in: 0/1', 'PENDING'],
        ['Check-in: 1/10', 'PENDING'], ['11/10', 'DONE'], ['0/0', 'UNAVAILABLE'],
        [undefined, 'UNAVAILABLE'], ['未知', 'UNAVAILABLE'], ['-1/1', 'UNAVAILABLE'], ['prefix 1/1', 'UNAVAILABLE']
    ]) {
        const state = { appCheckIn, tasks: { bingAppStreak: { status: 'RUNNING' } } }
        assert.equal(classify(state), expected)
        render(state)
        assert.equal(painted.at(-1), expected)
        assert.equal(label.textContent, expected === 'UNAVAILABLE' ? 'Check-in: 未知' : appCheckIn)
    }
    const opening = pageSource.match(/<div[^>]*id="desktopBingAppStreakTile"[^>]*>/)[0]
    assert.doesNotMatch(opening, /data-task-(platform|group)/)
    assert.match(pageSource, /value: drawerStatus\(desktopAppCheckInStatus\(state\)\)/)
    assert.match(pageSource, /renderDesktopAppCheckIn\(s\)/)
})

test('Explore cards retain two states independently of group runtime and stay scoped to mobile promotions', () => {
    const classifySource = pageSource.slice(pageSource.indexOf('function isInteractivePromotion('), pageSource.indexOf('function openTaskDetailDrawer('))
    const classify = new Function(`${classifySource}; return isInteractivePromotion;`)()
    for (const item of [{ requiresAppInteraction: true }, { requiresManualInteraction: true }]) {
        assert.equal(classify(item, 'mobile', 'appPromotions'), true)
        assert.equal(classify(item, 'mobile', 'dailySet'), item.requiresAppInteraction === true)
        assert.equal(classify(item, 'desktop', 'promotions'), false)
    }
    assert.equal(classify({}, 'mobile', 'appPromotions'), false)
    const painterSource = pageSource.slice(pageSource.indexOf('function paintTaskElement('), pageSource.indexOf('function paintTaskGroup('))
    let removed = 0
    const host = { querySelector: () => ({ remove: () => removed++ }) }
    const paint = new Function('taskBadgeHost', `${painterSource}; return paintTaskElement;`)(() => host)
    for (const done of [false, true]) {
        for (const incoming of ['RUNNING', 'ERROR', 'PENDING', 'DONE']) {
            const element = { dataset: { taskInteractive: 'true', taskItemDone: String(done) } }
            paint(element, incoming)
            assert.equal(element.dataset.taskStatus, done ? 'DONE' : 'PENDING')
        }
    }
    assert.equal(removed, 8)
    assert.match(pageSource, /isInteractiveTask \? '已完成' : 'Completed ↗'/)
    assert.match(pageSource, /manualTaskBadgeHtml = pendingManualTask && !isInteractiveTask/)
})

test('Daily Set classification does not equate offer association parameters with manual interaction', () => {
    const classify = destination_url => isInteractiveDailySetDestination({ attributes: { destination_url } })
    assert.equal(classify('https://rewards.bing.com/refer?form=example'), true)
    assert.equal(classify('https://www.bing.com/search?filters=PollScenarioId:test'), true)
    assert.equal(classify('https://www.bing.com/rewards/checkuser?ru=' + encodeURIComponent('/search?filters=BTROID:"dynamic-id"')), false)
    assert.equal(classify('https://www.bing.com/search?filters=BTEPOKey:REWARDSQUIZ_DailySet_UrlOffer'), false)
    assert.equal(classify('https://www.bing.com/search?rqpiodemo=1'), true)
    assert.equal(isInteractiveDailySetDestination({ attributes: { requiresManualInteraction: 'true' } }), true)
    assert.equal(classify('https://www.bing.com/search?q=nature'), false)
    assert.equal(classify('https://example.com/search?filters=BTROID:test'), false)
    assert.equal(classify('https://www.bing.com/rewards/checkuser?ru=https://example.com/search?filters=BTROID:test'), false)
    assert.equal(classify(''), false)
    assert.match(webSource, /interactionCandidate: isInteractiveDailySetDestination\(p\)/)
})

function routeBlock(pathname, nextPathname) {
    const start = webSource.indexOf(`if (pathname === '${pathname}'`)
    const end = nextPathname ? webSource.indexOf(`if (pathname === '${nextPathname}'`, start + 1) : webSource.length
    assert.ok(start >= 0 && end > start, `route ${pathname} must exist before ${nextPathname}`)
    return webSource.slice(start, end)
}

test('both platforms accept official DONE during a run without completing unrelated groups', () => {
    const source = pageSource.slice(pageSource.indexOf('function applyOfficialTaskStatuses('), pageSource.indexOf('function cardPointTotals('))
    for (const platform of ['desktop', 'mobile']) {
        for (const status of ['RUNNING', 'ERROR']) {
            const states = { desktop: {}, mobile: {} }
            states[platform] = { dailySet: { status, items: { old: { status } } }, search: { status: 'RUNNING' } }
            const applied = []
            const apply = new Function('taskStatusState', 'setTaskStatus', 'paintStoredTaskState',
                `const isDesktopRunning=true,isMobileRunning=true; ${source}; return applyOfficialTaskStatuses;`)(
                states, (p, id, s) => applied.push([p, id, s]), () => {})
            apply(platform, { dailySet: { status: 'DONE' }, search: { status: 'PENDING' } })
            assert.deepEqual(applied, [[platform, 'dailySet', 'DONE']])
            assert.deepEqual(states[platform].dailySet.items, {})
        }
    }
})

test('runtime replay cannot repaint official completed groups or cards as running', () => {
    const source = pageSource.slice(pageSource.indexOf('function paintStoredTaskState('), pageSource.indexOf('function setTaskStatus('))
    for (const platform of ['desktop', 'mobile']) {
        const group = { dataset: {} }, card = { dataset: { taskItemId: 'a' } }
        const painted = []
        const state = { desktop: {}, mobile: {} }
        state[platform].dailySet = { status: 'RUNNING', items: { a: { status: 'ERROR' } } }
        const official = { tasks: { dailySet: { status: 'DONE' } } }
        const paint = new Function('taskStatusState', 'latestDesktopState', 'latestMobileState', 'document',
            'aggregateItemTaskStatus', 'paintTaskElement', `${source}; return paintStoredTaskState;`)(
            state, official, official, { querySelectorAll: () => [group, card] }, () => 'ERROR',
            (_element, status) => painted.push(status))
        paint(platform, 'dailySet')
        assert.deepEqual(painted, ['DONE', 'DONE'])
    }
})

test('desktop execution and account authorization use different run modes', () => {
    const desktopRun = routeBlock('/api/run', '/api/stop')
    assert.match(desktopRun, /runBotProcess\('desktop', state\)/)
    assert.doesNotMatch(desktopRun, /runBotProcess\('login'\)/)

    const accountLogin = routeBlock('/api/account/login', '')
    assert.match(accountLogin, /runBotProcess\('login'\)/)
})

test('background cloud sync uses a five-minute cadence with bounded failure backoff', () => {
    assert.match(webSource, /const BACKGROUND_SYNC_INTERVAL_MS = 5 \* 60 \* 1000/)
    assert.match(webSource, /const BACKGROUND_SYNC_FAILURE_DELAYS_MS = \[60, 120, 300, 600\]/)
    assert.match(webSource, /function nextBackgroundSyncDelay\(result\)/)
    assert.match(webSource, /if \(result\?\.skipped\) return BACKGROUND_SYNC_BUSY_RETRY_MS/)
    assert.match(webSource, /scheduleBackgroundSync\(nextBackgroundSyncDelay\(result\)\)/)
    assert.match(webSource, /scheduleBackgroundSync\(\)/)
    assert.doesNotMatch(webSource, /setInterval\(\(\) => void runScheduledSync\(\), 30000\)/)
})

test('manual PC and mobile syncs have independent fifteen-second client and server cooldowns', () => {
    assert.match(webSource, /const MANUAL_SYNC_COOLDOWN_MS = 15 \* 1000/)
    assert.match(webSource, /const lastManualSyncAt = \{ desktop: 0, mobile: 0 \}/)
    assert.match(webSource, /claimManualSync\('desktop', silentSync\)/)
    assert.match(webSource, /claimManualSync\('mobile', silentSync\)/)
    assert.match(webSource, /res\.writeHead\(429, \{ 'Content-Type': 'application\/json', 'Retry-After'/)
    assert.match(pageSource, /const MANUAL_SYNC_COOLDOWN_MS = 15000/)
    assert.match(pageSource, /manualSyncRetrySeconds\('desktop'\)/)
    assert.match(pageSource, /manualSyncRetrySeconds\('mobile'\)/)
    assert.match(pageSource, /请在 \$\{retrySeconds\} 秒后再次手动同步/)
})

test('run preflight and post-run verification remain live after background sync throttling', () => {
    assert.match(
        webSource,
        /refreshed = mode === 'mobile' \? await fetchLiveMobileState\(\) : await fetchLiveMicrosoftState\(\)/
    )
    assert.match(webSource, /const live = await fetchLiveMobileState\(\)\.catch\(\(\) => null\)/)
    assert.match(webSource, /const live = await fetchLiveMicrosoftState\(\)\.catch\(\(\) => null\)/)
})

test('PC live sync builds known offer IDs from the current classified promotion cards', () => {
    const start = webSource.indexOf('async function fetchLiveMicrosoftState()')
    const end = webSource.indexOf('\nfunction normalizeDate(', start)
    const liveSync = webSource.slice(start, end)

    assert.match(liveSync, /\.\.\.promoCards\.map\(item => item\.offerId\)\.filter\(Boolean\)/)
    assert.doesNotMatch(liveSync, /uniquePromos/)
})

test('local PC configuration enables Edge browsing execution', () => {
    assert.equal(config.experimental.edgeBrowsing, true)
})

test('execution mode is a hard terminal boundary for PC and mobile workers', () => {
    assert.match(indexSource, /const allowDesktopTasks = !mobileMode && !loginMode/)
    assert.match(indexSource, /const allowMobileTasks = !desktopMode && !loginMode/)
    assert.match(indexSource, /allowDesktopTasks && this\.config\.experimental\.edgeBrowsing/)
    assert.match(indexSource, /const doMobileSearch = allowMobileTasks && plan\.doMobile/)
    assert.match(indexSource, /const doDesktopSearch = allowDesktopTasks && plan\.doDesktop/)
    assert.match(indexSource, /allowDesktopTasks && this\.config\.workers\.doMorePromotions/)
    assert.match(indexSource, /allowMobileTasks && appAvailable && this\.config\.workers\.doReadToEarn/)
    assert.match(indexSource, /allowDesktopTasks && this\.config\.workers\.doClaimBonusPoints/)
})

test('desktop-owned workers run inside a desktop execution context', () => {
    assert.match(indexSource, /const runDesktopTask = async/)
    for (const [context, worker] of [
        ['STREAK-PROTECTION', 'doEnsureStreakProtection'],
        ['ACTIVATE-SEARCH-PERK', 'doActivateSearchPerk'],
        ['DAILY-SET', 'doDailySet'],
        ['MORE-PROMOTIONS', 'doMorePromotions'],
        ['CLAIM-BONUS-POINTS', 'doClaimBonusPoints']
    ]) {
        assert.match(
            indexSource,
            new RegExp(`runDesktopActivity\\('${context}'[\\s\\S]{0,160}this\\.activities\\.${worker}`)
        )
    }
    assert.match(indexSource, /\.run\(\{ isMobile: false, account \}, async \(\) =>\s*this\.activities\.doEdgeBrowsing/)
    assert.doesNotMatch(indexSource, /this\.activities\.doPunchCardsMobile\(/)
})

test('independent PC and mobile activities are isolated so one failure does not abort later work', () => {
    assert.match(indexSource, /runIsolatedTask\(task, error =>/)
    assert.match(indexSource, /Task failed; continuing with the next independent activity/)

    for (const [context, worker] of [
        ['MOBILE-DAILY-SET', 'doMobileDailySet'],
        ['DAILY-CHECK-IN', 'doDailyCheckIn'],
        ['APP-PROMOTIONS', 'doAppPromotions'],
        ['READ-TO-EARN', 'doReadToEarn']
    ]) {
        assert.match(
            indexSource,
            new RegExp(`runMobileActivity\\('${context}'[\\s\\S]{0,160}this\\.activities\\.${worker}`)
        )
    }
    assert.match(indexSource, /runIsolatedActivity\(false, 'PUNCH-CARDS'/)
    assert.match(indexSource, /runIsolatedActivity\(false, 'VISUAL-SEARCH'/)
})

test('backend publishes structured and terminal-isolated task status events', () => {
    assert.match(webSource, /type:\s*'taskStatus'/)
    assert.match(webSource, /platform,\s*taskId,\s*status/)
    assert.match(webSource, /plannedTaskIds\[platform\]/)
    assert.match(webSource, /mode === 'mobile' \? 'mobile' : 'desktop'/)
})

test('a run keeps planned tasks pending until the matching worker actually starts', () => {
    const runStart = webSource.indexOf('function runBotProcess')
    const runEnd = webSource.indexOf('\nfunction stopBotProcess', runStart)
    const runSource = webSource.slice(runStart, runEnd)

    assert.doesNotMatch(
        runSource,
        /for \(const taskId of activeRunTaskIds\) broadcastTaskStatus\(activeRunPlatform, taskId, 'RUNNING'\)/
    )
    assert.match(webSource, /function recordTaskLifecycle\(platform, line\)/)
    assert.match(webSource, /recordTaskLifecycle\(mode, line\)/)
    assert.match(webSource, /isDone \? 'DONE' : \(isFinishedPending \? 'PENDING' : 'RUNNING'\)/)
})

test('Daily Set task status events and cards are scoped by offer ID', () => {
    assert.match(webSource, /function broadcastTaskStatus\(platform, taskId, status, detail = '', itemId = ''\)/)
    assert.match(webSource, /itemId/)
    assert.match(webSource, /extractOfferIdFromLog\(line\)/)
    assert.match(pageSource, /card\.dataset\.taskItemId = String\(item\.offerId/)
    assert.match(pageSource, /msg\.itemId \|\| ''/)
    assert.match(pageSource, /groupState\?\.items\?\.\[taskItemId\]/)
})

test('unscoped warnings do not mark every planned task as failed', () => {
    const start = webSource.indexOf('function recordTaskFailure')
    const end = webSource.indexOf('function broadcastExecutionPlan', start)
    const recordFailure = webSource.slice(start, end)
    assert.match(recordFailure, /if \(!inferred\.length\) return/)
    assert.doesNotMatch(recordFailure, /:\s*\[\.\.\.activeRunTaskIds\]/)
})

test('zero-valued failed counters are healthy progress rather than task failures', () => {
    const functionStart = webSource.indexOf('function isTaskFailureLog')
    const functionEnd = webSource.indexOf('function recordTaskFailure', functionStart)
    assert.ok(functionStart >= 0 && functionEnd > functionStart)
    const isTaskFailureLog = new Function(`${webSource.slice(functionStart, functionEnd)}; return isTaskFailureLog`)()

    assert.equal(isTaskFailureLog('DESKTOP [EDGE-BROWSING] report=2/6 | status=200 | accepted=2 | failed=0'), false)
    assert.equal(isTaskFailureLog('DESKTOP [EDGE-BROWSING] report=2/6 | status=500 | accepted=1 | failed=1'), true)
    assert.equal(isTaskFailureLog('DESKTOP [EDGE-BROWSING] Unable to submit Edge browsing report'), true)
})

test('normal browser cleanup is debug output rather than a warning', () => {
    assert.match(browserSource, /context\.on\('close', \(\) => this\.bot\.logger\.debug\(/)
    assert.doesNotMatch(browserSource, /context\.on\('close', \(\) => this\.bot\.logger\.warn\(/)
})

test('successful runs keep manual or otherwise pending official tasks pending', () => {
    const functionStart = webSource.indexOf('function resolveFinalTaskStatus')
    const functionEnd = webSource.indexOf('function runBotProcess', functionStart)
    assert.ok(functionStart >= 0 && functionEnd > functionStart)
    const resolveFinalTaskStatus = new Function(
        `${webSource.slice(functionStart, functionEnd)}; return resolveFinalTaskStatus`
    )()

    assert.equal(resolveFinalTaskStatus('PENDING', false, false, 0), 'PENDING')
    assert.equal(resolveFinalTaskStatus('PENDING', false, true, 0), 'ERROR')
    assert.equal(resolveFinalTaskStatus('PENDING', false, false, 1), 'ERROR')
    assert.equal(resolveFinalTaskStatus('PENDING', true, true, 1), 'PENDING')
    assert.equal(resolveFinalTaskStatus('DONE', false, true, 1), 'DONE')
    assert.equal(resolveFinalTaskStatus('UNAVAILABLE', false, false, 0), 'UNAVAILABLE')
    assert.match(
        webSource,
        /resolveFinalTaskStatus\(\s*officialStatus,\s*activeRunStopped,\s*activeRunErrors\.has\(taskId\),\s*code\s*\)/
    )
    assert.doesNotMatch(indexSource, /allTasksDone:\s*true/)
})

test('dashboard contains status bindings for PC and mobile task groups', () => {
    const desktopTasks = ['desktopSearch', 'dailySet', 'promotions', 'edgeBrowsing']
    const mobileTasks = ['appSearch', 'readToEarn', 'sapphireCheckIn', 'dailySet', 'appPromotions']
    for (const taskId of desktopTasks) {
        assert.match(pageSource, new RegExp(`data-task-platform="desktop" data-task-group="${taskId}"`))
    }
    for (const taskId of mobileTasks) {
        assert.match(pageSource, new RegExp(`data-task-platform="mobile" data-task-group="${taskId}"`))
    }
    for (const label of ['已完成', '执行中', '异常', '待完成', '状态不可用', '已关闭']) {
        assert.match(pageSource, new RegExp(label))
    }
})

test('points drawers are scoped by terminal and card instead of sharing the PC today value', () => {
    const requiredBindings = [
        "openDrawer('desktop', 'balance')",
        "openDrawer('desktop', 'today')",
        "openDrawer('desktop', 'desktopSearch')",
        "openDrawer('mobile', 'balance')",
        "openDrawer('mobile', 'today')",
        "openDrawer('mobile', 'sapphireCheckIn')",
        "openDrawer('mobile', 'bingCheckIn')",
        "openDrawer('mobile', 'appSearch')",
        "openDrawer('mobile', 'readToEarn')"
    ]
    for (const binding of requiredBindings) assert.ok(pageSource.includes(binding), `missing ${binding}`)

    assert.doesNotMatch(pageSource, /onclick="openDrawer\(\)"/)
    assert.match(pageSource, /latestDesktopState = s/)
    assert.match(pageSource, /latestMobileState = s/)
    assert.match(pageSource, /function renderPointsDrawer/)
    assert.match(pageSource, /rowsHost\.replaceChildren\(\)/)
    assert.match(pageSource, /label\.textContent = row\.label/)
    assert.match(pageSource, /rowValue\.textContent = row\.value/)
})

test('task refresh display shows only the next refresh in the system time zone', () => {
    for (const id of ['desktopTaskRefreshInfo', 'desktopTaskEstimate', 'mobileTaskRefreshInfo', 'mobileTaskEstimate'])
        assert.match(pageSource, new RegExp(`id="${id}"`))

    for (const removedId of [
        'desktopTaskCycle',
        'desktopTaskSync',
        'desktopTaskTimezone',
        'mobileTaskCycle',
        'mobileTaskSync',
        'mobileTaskTimezone',
        'cfgDisplayTimeZone',
        'cfgDisplayTimeZoneHelp'
    ])
        assert.doesNotMatch(pageSource, new RegExp(`id="${removedId}"`))

    assert.match(pageSource, /renderTaskRefreshInfo\('desktop'\)/)
    assert.match(pageSource, /renderTaskRefreshInfo\('mobile'\)/)
    assert.match(pageSource, /function officialTaskRefreshText\(/)
    assert.doesNotMatch(pageSource, /nextCycleEstimate\(/)
    assert.equal((pageSource.match(/任务刷新时间（系统时区）/g) || []).length, 2)
    assert.match(pageSource, /下次刷新待官方确认/)
    assert.match(pageSource, /getSystemTimeZone\(\)/)
    assert.doesNotMatch(pageSource, /function populateTimeZoneOptions\(/)
    assert.doesNotMatch(pageSource, /function previewDisplayTimeZone\(/)
    assert.doesNotMatch(pageSource, /activeConfig\.display\?\.timeZone/)
    assert.doesNotMatch(pageSource, /document\.getElementById\('cfgDisplayTimeZone'\)/)
    assert.match(pageSource, /await loadConfigForm\(\);\s*if \(authorization\.desktop\) await fetchState\(\)/)
    assert.match(webSource, /isValidTimeZonePreference\(newConf\.display\.timeZone\)/)
    assert.doesNotMatch(webSource, /REWARDS_DAILY_SET_DATE:\s*getSavedConfig\(\).*timeZone/s)

    const functionStart = pageSource.indexOf('function officialTaskRefreshText')
    const functionEnd = pageSource.indexOf('function renderTaskRefreshInfo', functionStart)
    assert.ok(functionStart >= 0 && functionEnd > functionStart)
    const refreshText = new Function(
        `${pageSource.slice(functionStart, functionEnd)}; return officialTaskRefreshText`
    )()
    const now = Date.parse('2026-09-10T01:00:00Z')
    const pc = { taskRefresh: { source: 'rewards-web', accountDate: '09/09/2026', nextResetAt: null } }
    const mobile = { taskRefresh: { source: 'saandroid', accountDate: '09/10/2026', nextResetAt: null } }
    assert.equal(refreshText(pc, 'desktop', now, 'Asia/Shanghai'), '当前任务日：2026/09/09 · 下次刷新待官方确认')
    assert.equal(refreshText(mobile, 'mobile', now, 'Asia/Shanghai'), '当前任务日：2026/09/10 · 下次刷新待官方确认')
    assert.equal(refreshText(pc, 'mobile', now, 'Asia/Shanghai'), '下次刷新待官方确认')
    pc.taskRefresh.nextResetAt = '2026-09-10T07:00:00Z'
    assert.match(refreshText(pc, 'desktop', now, 'Asia/Shanghai'), /15:00/)
    assert.match(refreshText(pc, 'desktop', now, 'UTC'), /07:00/)
    for (const resetAt of ['2026-09-10T00:00:00Z', '2026-09-11T00:00:00', 'invalid', null]) {
        pc.taskRefresh.nextResetAt = resetAt
        assert.match(refreshText(pc, 'desktop', now, 'Asia/Shanghai'), /待官方确认/)
    }
    assert.equal(refreshText({ currentDate: '2026-09-10' }, 'desktop', now, 'Asia/Shanghai'), '下次刷新待官方确认')
})

test('dynamic task cards open their own point details and retain an optional official action', () => {
    assert.match(pageSource, /openTaskDetailDrawer\(taskBinding\[0\], taskBinding\[1\], item\)/)
    assert.match(pageSource, /actionUrl: item\?\.destinationUrl \|\| ''/)
    assert.match(pageSource, /activeDrawerUrl = \/\^https\?:\\\/\\\//)
    assert.match(pageSource, /id="drawerActionLink"/)
    assert.match(pageSource, /id="drawerFoot"/)
    assert.match(pageSource, /btn-drawer-action btn-drawer-close" onclick="closeDrawer\(\)">关闭<\/button>/)
    assert.match(pageSource, /#drawerActionLink \{ flex: 2 1 0; \}/)
    assert.match(pageSource, /\.btn-drawer-close \{\s*flex: 1 1 0;/)
    assert.match(pageSource, /#drawerActionLink\[hidden\] \+ \.btn-drawer-close \{ flex-basis: 100%; \}/)
})

test('completed child cards remain complete while their group changes runtime status', () => {
    assert.match(pageSource, /taskItemDone === 'true' \? 'DONE' : status/)
    assert.match(pageSource, /mobileDailyCardsGrid:\s*\['mobile', 'dailySet'\]/)
    assert.match(pageSource, /keepEarningCardsGrid:\s*\['desktop', 'promotions'\]/)
})

test('non-runnable information and manual cards do not inherit a group running state', () => {
    assert.match(
        pageSource,
        /card\.dataset\.taskRuntimeExcluded = isPromoLink \|\| pendingManualTask \? 'true' : 'false'/
    )
    assert.match(
        pageSource,
        /if \(element\.dataset\.taskRuntimeExcluded === 'true' && element\.dataset\.taskItemDone !== 'true'\)/
    )
    assert.match(pageSource, /badge\?\.remove\(\)/)
})

test('completed Rewards Web Edge streak skips the background reporter', async () => {
    let httpCalls = 0
    const logs = []
    const edgeStreak = {
        partner: 'edge',
        activitiesCompleted: 30,
        activitiesTotal: 30,
        completedDays: 1,
        currentDay: 1,
        totalDays: 7,
        isCurrentDayCompleted: true,
        isEnabled: true,
        dailyPoints: [5, 10, 15, 20, 25, 30, 120],
        activationOfferId: null,
        activationHash: null,
        activationActivityType: null,
        destinationUrl: null
    }
    const snapshot = { offers: [], reportable: [], streaks: [edgeStreak], streakProtection: null, account: {} }
    const bot = {
        isMobile: false,
        accessToken: 'token',
        reactSnapshot: snapshot,
        reactSnapshots: { desktop: snapshot, mobile: null },
        logger: {
            debug() {},
            info(_mobile, _tag, message) {
                logs.push(message)
            },
            warn() {},
            error() {}
        },
        http: {
            async request() {
                httpCalls += 1
                throw new Error('completed Edge streak must not call the App profile')
            }
        }
    }

    await new EdgeBrowsing(bot).run({})

    assert.equal(httpCalls, 0)
    assert.ok(logs.some(message => message.includes('skip_complete')))
})

test('Bing App Today points use Daily Set, active Search and Read totals', () => {
    assert.match(webSource, /const mobileTaskEarned = dailySetEarned \+ searchProgress \+ readProgress/)
    assert.match(webSource, /const mobileTaskMax = dailySetMax \+ searchMax \+ readMax/)
    assert.match(webSource, /const todayEarned = mobileTaskEarned/)
    assert.match(webSource, /const todayMax = mobileTaskMax/)
    assert.match(webSource, /officialAppTodayEarned: mobileTaskEarned/)
    assert.doesNotMatch(webSource, /const todayEarned = accountTodayPoints \?\? mobileTaskEarned/)
})

test('PC Daily Set cards use the exact current collection without streak or adjacent-date fallback', () => {
    const start = webSource.indexOf('async function fetchLiveMicrosoftState()')
    const end = webSource.indexOf('function normalizeDate', start)
    const desktopSync = webSource.slice(start, end)

    assert.match(desktopSync, /dailySetPromotions\?\.\[officialDailySetDate\] \|\| \[\]/)
    assert.match(desktopSync, /fetchOfficialDailySetDate\(dashboardCookieHeader\)/)
    assert.match(desktopSync, /sessionCookieHeader\(storage\.cookies, authUrl\)/)
    assert.match(desktopSync, /sessionCookieHeader\(storage\.cookies, 'https:\/\/rewards\.bing\.com\/earn'\)/)
    assert.match(desktopSync, /sessionCookieHeader\(storage\.cookies, 'https:\/\/rewards\.bing\.com\/api\/getuserinfo'\)/)
    assert.match(desktopSync, /complete: Boolean\(item\.complete\)/)
    assert.doesNotMatch(desktopSync, /Object\.values\(infoData\?\.dashboard\?\.dailySetPromotions/)
    assert.doesNotMatch(desktopSync, /complete: isDsComplete \|\| Boolean\(item\.complete\)/)
})

test('mobile More activities dynamically discovers eligible SAAndroid urlreward and Sapphire offers without Daily Set', () => {
    const start = webSource.indexOf('async function fetchLiveMobileState()')
    const end = webSource.indexOf('function getSavedMobileState()', start)
    const mobileSync = webSource.slice(start, end)

    assert.match(webSource, /function isAppMoreActivityPromotion/)
    assert.match(webSource, /type === 'urlreward' \|\| type === 'sapphire'/)
    assert.match(webSource, /const isDailySet = Boolean\(attrs\.daily_set_date\)/)
    assert.match(mobileSync, /isAppMoreActivityPromotion\(p\)/)
    assert.match(mobileSync, /isCurrentAppDailySetPromotion\(p, appDate\)/)
    assert.match(mobileSync, /const appDate = resolveAppDailySetDate\(promos\)/)
    assert.match(webSource, /BingFlyout_Layout_DailyCheckIn/)
    assert.match(mobileSync, /const bonusPromoCards = promoCards\.map/)
    assert.match(mobileSync, /card\.requiresAppInteraction\s*\? 0/)
    assert.match(webSource, /function isAppPromotionComplete\(attrs = \{\}\)/)
    assert.match(webSource, /isAppInteractivePromotion as isAppInteractiveTask/)
    assert.match(mobileSync, /requiresAppInteraction: isAppInteractiveTask\(p\)/)
    assert.doesNotMatch(mobileSync, /attrs\.State === 'Complete'/)
    assert.match(pageSource, /s\.moreActivitiesMax \?\? s\.promoCards\.reduce/)
    assert.match(pageSource, /s\.moreActivitiesEarned \?\? s\.promoCards\.reduce/)
    assert.match(pageSource, /class="card-type-badge">人工任务/)
    assert.match(pageSource, /人工任务 · 需要用户手动操作/)
    assert.doesNotMatch(mobileSync, /rewards\.bing\.com\/api\/getuserinfo/)
    assert.doesNotMatch(mobileSync, /dashboardMorePromotions/)
})

test('PC Keep earning filters mobile APP interaction tasks while mobile keeps them', () => {
    const start = webSource.indexOf('async function fetchLiveMicrosoftState()')
    const end = webSource.indexOf('function normalizeDate', start)
    const desktopSync = webSource.slice(start, end)

    assert.match(desktopSync, /selectPcKeepEarningPromotions\(rawPromos, dailySetItems, visibleOfferIds\)/)
    assert.doesNotMatch(desktopSync, /requiresAppInteraction: isAppInteractiveTask\(item\)/)
    assert.match(pageSource, /return !id\.includes\('_exploreonbing_activation_'\)/)
    assert.match(webSource, /requiresAppInteraction: isAppInteractiveTask\(p\)/)
})

test('PC Keep earning classification follows current official collections instead of historical ID names', () => {
    const currentDaily = { offerId: 'Gamification_DailySet_20260901_Child2', title: 'Current daily quiz' }
    const repurposedHistorical = { offerId: 'Gamification_DailySet_20260827_Child2', title: 'Warpspeed quiz' }
    const exploreAppTask = { offerId: 'ENUS_exploreonbing_activation_offer', title: 'Talk, text, save' }
    const rewardsAppOnly = {
        offerId: 'WW_Moreactivities_RewardsApp_offer_20260902_1',
        title: 'Example task (Rewards App only)'
    }
    const ordinary = { offerId: 'ordinary_more_offer', title: 'Ordinary More task' }
    const duplicateOrdinary = { ...ordinary, title: 'Ordinary More task (latest)' }

    const selected = selectPcKeepEarningPromotions(
        [currentDaily, repurposedHistorical, exploreAppTask, rewardsAppOnly, ordinary, duplicateOrdinary],
        [currentDaily],
        [currentDaily.offerId, repurposedHistorical.offerId, exploreAppTask.offerId, rewardsAppOnly.offerId, ordinary.offerId]
    )

    assert.deepEqual(
        selected.map(item => item.offerId),
        [repurposedHistorical.offerId, ordinary.offerId]
    )
    assert.equal(selected.find(item => item.offerId === ordinary.offerId)?.title, duplicateOrdinary.title)
})

test('all PC Keep earning production paths reuse the shared official collection classifier', () => {
    assert.match(indexSource, /selectPcKeepEarningPromotions\(promoItems, dailySetItems,/)
    assert.match(browserFuncSource, /selectPcKeepEarningPromotions\(/)
    assert.match(morePromotionsSource, /selectPcKeepEarningPromotions\(/)
    assert.doesNotMatch(indexSource, /new Map\(promoItems\.map/)
    assert.doesNotMatch(browserFuncSource, /promotionType === 'urlreward'/)
})

test('quest parsing accepts current structured ids without relying on pcparent or pcchild names', () => {
    const logs = []
    const react = new ReactFunc({
        isMobile: false,
        logger: {
            info(_mobile, _tag, message) {
                logs.push(message)
            },
            debug() {},
            warn() {},
            error() {}
        }
    })
    const flight = payload => `self.__next_f.push([1,${JSON.stringify(payload)}])`
    const parents = react.snapshotQuestList(
        flight(
            '<a href="/earn/quest/OpaqueQuest2026"></a>{"title":"Opaque quest","pointProgressMax":10}' +
                '{"offerId":"UnlinkedArbitraryOffer","title":"Not a quest"}'
        )
    )
    const children = react.snapshotQuestPage(
        flight(
            '{"offerId":"OpaqueChild2026","hash":"abc123","isCompleted":false,"isLocked":false,"isDisabled":false,"points":10}' +
                '{"offerId":"ArbitraryNoEvidence","points":10}'
        )
    )

    assert.deepEqual(
        parents.map(parent => parent.offerId),
        ['OpaqueQuest2026']
    )
    assert.deepEqual(
        children.map(child => child.offerId),
        ['OpaqueChild2026']
    )
    assert.equal(children[0].reportable, true)
})

test('new official task categories expand into isolated read-only sections on both terminals', () => {
    assert.match(webSource, /function discoverAdditionalWebTaskSections/)
    assert.match(webSource, /function discoverAdditionalAppTaskSections/)
    assert.match(webSource, /additionalTaskSections = discoverAdditionalWebTaskSections/)
    assert.match(webSource, /additionalTaskSections = discoverAdditionalAppTaskSections/)
    assert.match(pageSource, /id="desktopAdditionalTaskSections"/)
    assert.match(pageSource, /id="mobileAdditionalTaskSections"/)
    assert.match(pageSource, /function renderAdditionalTaskSections/)
    assert.match(pageSource, /完成 · 只读发现/)
    assert.match(pageSource, /with-bottom-bar\.console-open \{ padding-bottom: 340px; \}/)
})

test('PC and mobile execution receive their independently resolved official Daily Set cycle', () => {
    assert.match(webSource, /function extractOfficialDailySetDate\(dashboardHtml\)/)
    assert.match(webSource, /return dates\.size === 1 \? \[\.\.\.dates\]\[0\] : null/)
    assert.match(webSource, /REWARDS_DAILY_SET_DATE: preflightState\?\.dailySetDate \|\| ''/)
    assert.match(routeBlock('/api/mobile/run', '/api/run'), /runBotProcess\('mobile', state\)/)
    assert.match(routeBlock('/api/run', '/api/stop'), /runBotProcess\('desktop', state\)/)
})

test('desktop final task status is computed from the normalized saved snapshot', () => {
    const start = webSource.indexOf("activeBotProcess.on('close'")
    const end = webSource.indexOf('async function runScheduledSync()', start)
    const closeHandler = webSource.slice(start, end)

    assert.match(
        closeHandler,
        /normalized = mode === 'mobile' \? saveMobileState\(refreshed\) : saveState\(refreshed\)/
    )
    assert.match(closeHandler, /snapshotTaskStatus\(normalized, taskId\)/)
    assert.doesNotMatch(closeHandler, /snapshotTaskStatus\(refreshed, taskId\)/)
})

test('desktop compatibility counters are recomputed from the same live task snapshot', () => {
    const start = webSource.indexOf('function saveState(newState)')
    const end = webSource.indexOf('async function fetchLiveMobileState()', start)
    const saveState = webSource.slice(start, end)

    assert.match(saveState, /merged\.dailySetPending = dailySetCards\.filter\(card => !card\.complete\)\.length/)
    assert.match(saveState, /merged\.promoPending = promoCards\.filter\(card => !card\.complete\)\.length/)
    assert.match(saveState, /merged\.dailySetQuota = `\$\{dailySetDoneCount\}\/\$\{dailySetCards\.length\}`/)
    assert.match(saveState, /merged\.promotionsQuota = `\$\{promoDoneCount\}\/\$\{promoCards\.length\}`/)
    assert.match(saveState, /availableTasks\.every\(task => task\.status === 'DONE'\)/)
    assert.match(saveState, /merged\.isNewDay = dailySetCards\.length <= 0 \|\| merged\.dailySetPending > 0/)
})

test('worker diagnostics do not overwrite authoritative preflight state while a run is active', () => {
    const stdoutStart = webSource.indexOf("activeBotProcess.stdout.on('data'")
    const stderrStart = webSource.indexOf("activeBotProcess.stderr.on('data'", stdoutStart)
    const stdoutHandler = webSource.slice(stdoutStart, stderrStart)
    const breakdownStart = stdoutHandler.indexOf('const breakdownMatch')
    const discoveryStart = stdoutHandler.indexOf('const discMatch', breakdownStart)
    const flowStart = stdoutHandler.indexOf('const flowMatch', discoveryStart)

    assert.ok(breakdownStart >= 0 && discoveryStart > breakdownStart && flowStart > discoveryStart)
    assert.doesNotMatch(stdoutHandler.slice(breakdownStart, discoveryStart), /saveState\(/)
    assert.doesNotMatch(stdoutHandler.slice(discoveryStart, flowStart), /saveState\(/)
    assert.match(indexSource, /points: Math\.max\(0, Number\(item\.pointProgressMax\) \|\| 0\)/)
})

test('mobile runs do not publish PC points discovery or disabled Edge warnings', () => {
    assert.match(indexSource, /if \(!mobileMode\) \{\s*this\.logger\.info\([\s\S]*?'POINTS-BREAKDOWN'/)
    assert.match(indexSource, /if \(!mobileMode\) \{\s*this\.logger\.info\([\s\S]*?'TASK-DISCOVERY'/)
    assert.match(indexSource, /if \(exp\.edgeBrowsing && process\.env\.REWARDS_MODE !== 'mobile'\)/)
})

test('PC Keep earning refreshes the complete collection and picks up newly added offers once', async () => {
    const promotion = offerId => ({
        offerId,
        name: offerId,
        title: offerId,
        promotionType: 'urlreward',
        pointProgress: 0,
        pointProgressMax: 10,
        complete: false
    })
    const complete = offerId => ({ ...promotion(offerId), pointProgress: 10, complete: true })
    const dashboard = promotions => ({
        dashboard: { morePromotions: promotions, morePromotionsWithoutPromotionalItems: [] }
    })
    const snapshots = [
        dashboard([complete('first'), promotion('new')]),
        dashboard([complete('first'), complete('new')])
    ]
    const submitted = []
    const warnings = []
    const bot = {
        isMobile: false,
        config: { activities: { searchOnBing: true, urlReward: true } },
        browser: { func: { getDashboardData: async () => snapshots.shift(), getKeepEarningOfferIds: async () => ['first', 'new'] } },
        activities: {
            doUrlReward: async item => submitted.push(item.offerId),
            doSearchOnBing: async item => submitted.push(item.offerId)
        },
        logger: {
            debug() {},
            info() {},
            error() {},
            warn(_mobile, _tag, message) {
                warnings.push(message)
            }
        },
        utils: { wait: async () => {}, randomDelay: () => 0 }
    }

    await new MorePromotions(bot).run(dashboard([promotion('first')]))

    assert.deepEqual(submitted, ['first', 'new'])
    assert.equal(warnings.length, 0)
})

test('PC Keep earning executor excludes the current Daily Set, duplicates and APP interactions', async () => {
    const promotion = offerId => ({
        offerId,
        name: offerId,
        title: offerId,
        promotionType: 'urlreward',
        pointProgress: 0,
        pointProgressMax: 10,
        complete: false
    })
    const complete = offerId => ({ ...promotion(offerId), pointProgress: 10, complete: true })
    const date = '09/01/2026'
    const daily = promotion('Gamification_DailySet_20260901_Child1')
    const explore = promotion('ENUS_exploreonbing_activation_offer')
    const ordinary = promotion('ordinary-more-offer')
    const dashboard = (ordinaryItem, duplicate = false) => ({
        dashboard: {
            dailySetPromotions: { [date]: [daily] },
            morePromotions: [daily, explore, ordinaryItem],
            morePromotionsWithoutPromotionalItems: duplicate ? [{ ...ordinaryItem, title: 'latest duplicate' }] : []
        }
    })
    const submitted = []
    const bot = {
        isMobile: false,
        dailySetDate: date,
        config: { activities: { searchOnBing: true, urlReward: true } },
        browser: { func: { getDashboardData: async () => dashboard(complete(ordinary.offerId), true),
            getKeepEarningOfferIds: async () => [daily.offerId, explore.offerId, ordinary.offerId] } },
        activities: {
            doUrlReward: async item => submitted.push(item.offerId),
            doSearchOnBing: async item => submitted.push(item.offerId)
        },
        logger: { debug() {}, info() {}, error() {}, warn() {} },
        utils: { wait: async () => {}, randomDelay: () => 0 }
    }

    await new MorePromotions(bot).run(dashboard(ordinary, true))

    assert.deepEqual(submitted, [ordinary.offerId])
})

test('PC Keep earning executor does not attempt zero-point informational cards', async () => {
    const zeroPoint = {
        offerId: 'zero-point-info',
        name: 'zero-point-info',
        title: 'Informational card',
        promotionType: 'urlreward',
        pointProgress: 0,
        pointProgressMax: 0,
        complete: false
    }
    const dashboard = {
        dashboard: { morePromotions: [zeroPoint], morePromotionsWithoutPromotionalItems: [] }
    }
    const submitted = []
    const bot = {
        isMobile: false,
        dailySetDate: null,
        config: { activities: { searchOnBing: true, urlReward: true } },
        browser: { func: { getDashboardData: async () => dashboard, getKeepEarningOfferIds: async () => [zeroPoint.offerId] } },
        activities: {
            doUrlReward: async item => submitted.push(item.offerId),
            doSearchOnBing: async item => submitted.push(item.offerId)
        },
        logger: { debug() {}, info() {}, error() {}, warn() {} },
        utils: { wait: async () => {}, randomDelay: () => 0 }
    }

    await new MorePromotions(bot).run(dashboard)
    assert.deepEqual(submitted, [])
})

test('Keep earning manual tasks are marked and skipped without leaking into Daily Set', async () => {
    const manualGoal = {
        offerId: 'future-goal-offer',
        name: 'future-goal-offer',
        title: 'Set a goal',
        promotionType: '',
        destinationUrl: 'https://rewards.bing.com/goal/all',
        pointProgress: 0,
        pointProgressMax: 5,
        complete: false
    }
    const dashboard = {
        dashboard: { morePromotions: [manualGoal], morePromotionsWithoutPromotionalItems: [] }
    }
    const submitted = []
    const logs = []
    const bot = {
        isMobile: false,
        dailySetDate: null,
        config: { activities: { searchOnBing: true, urlReward: true } },
        browser: { func: { getDashboardData: async () => dashboard, getKeepEarningOfferIds: async () => [manualGoal.offerId] } },
        activities: {
            doUrlReward: async item => submitted.push(item.offerId),
            doSearchOnBing: async item => submitted.push(item.offerId)
        },
        logger: {
            debug() {},
            info(_mobile, _tag, message) {
                logs.push(message)
            },
            error() {},
            warn() {}
        },
        utils: { wait: async () => {}, randomDelay: () => 0 }
    }

    await new MorePromotions(bot).run(dashboard)

    assert.deepEqual(submitted, [])
    assert.ok(logs.some(message => message.includes('skip_manual_required')))
    assert.match(webSource, /requiresManualInteraction: isManualKeepEarningTask\(item\)/)
    assert.match(webSource, /requiresManualInteraction: isManualKeepEarningTask\(p\)/)
    assert.match(pageSource, /class="card-type-badge">人工任务/)
    assert.match(pageSource, /人工任务 · 需要用户手动操作/)
    assert.match(pageSource, /function isPendingManualTask\(item, scope\)/)
    assert.match(pageSource, /\['promotions', 'appPromotions'\]\.includes\(scope\)/)
    assert.match(pageSource, /Boolean\(item\?\.requiresManualInteraction\) && !Boolean\(item\?\.complete\)/)
    assert.match(pageSource, /const pendingManualTask = isPendingManualTask\(item, scope\)/)
    assert.match(pageSource, /const pendingManualTask = isPendingManualTask\(item, taskBinding\?\.\[1\]\)/)
    assert.match(pageSource, /pendingManualTask \|\| \(isInteractive && !item.complete\)/)
    assert.match(pageSource, /const manualTaskBadgeHtml = pendingManualTask/)

    const desktopSyncStart = webSource.indexOf('async function fetchLiveMicrosoftState()')
    const desktopSyncEnd = webSource.indexOf('function normalizeDate', desktopSyncStart)
    const desktopSync = webSource.slice(desktopSyncStart, desktopSyncEnd)
    const mobileSyncStart = webSource.indexOf('async function fetchLiveMobileState()')
    const mobileSyncEnd = webSource.indexOf('function getSavedMobileState()', mobileSyncStart)
    const mobileSync = webSource.slice(mobileSyncStart, mobileSyncEnd)
    const desktopDailyMap = desktopSync.slice(
        desktopSync.indexOf('const dailySetCards'),
        desktopSync.indexOf('const rawPromos')
    )
    const mobileDailyBranch = mobileSync.slice(
        mobileSync.indexOf('if (isCurrentAppDailySetPromotion'),
        mobileSync.indexOf('} else if (isAppMoreActivityPromotion')
    )
    assert.doesNotMatch(desktopDailyMap, /requiresManualInteraction/)
    assert.doesNotMatch(mobileDailyBranch, /requiresManualInteraction/)
})

test('weakly verified PC tasks have explicit post-action Microsoft checks', () => {
    const punchCards = fs.readFileSync(
        new URL('../../src/functions/activities/rewards/PunchCards.ts', import.meta.url),
        'utf8'
    )
    const searchPerk = fs.readFileSync(
        new URL('../../src/functions/activities/api/ActivateSearchPerk.ts', import.meta.url),
        'utf8'
    )

    assert.match(punchCards, /await this\.verifyParentQuests/)
    assert.match(punchCards, /Punch Card completion verified by Microsoft/)
    assert.match(searchPerk, /const refreshed = await this\.bot\.browser\.func\.getDashboardData\(\)/)
    assert.match(searchPerk, /Search perk activation verified by Microsoft/)
})

test('region badge is exposed in both PC and mobile panels with timezone refresh tooltip', () => {
    assert.match(pageSource, /id="userRegion"/)
    assert.match(pageSource, /id="mobileUserRegion"/)
    assert.match(pageSource, /\.region-chip\s*\{/)
    assert.match(pageSource, /formatRegionBadge/)
    assert.match(pageSource, /getRegionRefreshTip/)
    assert.match(webSource, /getResolvedAccountRegion/)
    assert.match(webSource, /region:\s*currentRegion/)
    assert.match(webSource, /region:\s*appCountry/)
})

test('PC Keep earning executor skips tomorrow locked promotions without submitting them', async () => {
    const lockedCard = {
        offerId: 'tomorrow-locked-offer',
        name: 'tomorrow-locked-offer',
        title: '明日解锁活动',
        promotionType: 'urlreward',
        destinationUrl: 'https://rewards.bing.com/earn',
        pointProgress: 0,
        pointProgressMax: 10,
        complete: false,
        attributes: { status: 'locked' }
    }
    const dashboard = {
        dashboard: { morePromotions: [lockedCard], morePromotionsWithoutPromotionalItems: [] }
    }
    const submitted = []
    const logs = []
    const bot = {
        isMobile: false,
        dailySetDate: null,
        config: { activities: { searchOnBing: true, urlReward: true } },
        browser: { func: { getDashboardData: async () => dashboard, getKeepEarningOfferIds: async () => [lockedCard.offerId] } },
        activities: {
            doUrlReward: async item => submitted.push(item.offerId),
            doSearchOnBing: async item => submitted.push(item.offerId)
        },
        logger: {
            debug() {},
            info(_mobile, _tag, message) {
                logs.push(message)
            },
            error() {},
            warn() {}
        },
        utils: { wait: async () => {}, randomDelay: () => 0 }
    }

    await new MorePromotions(bot).run(dashboard)

    assert.deepEqual(submitted, [])
    assert.ok(logs.some(message => message.includes('skip_tomorrow_locked offerId=tomorrow-locked-offer')))
})


