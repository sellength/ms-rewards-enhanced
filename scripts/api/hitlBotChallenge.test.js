import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// =========================================================================
// 测试隔离前移：在模块使用前无条件预设独立临时隔离环境，绝不触碰真实 sessions 或外部目录
// =========================================================================
const origPreEnvSessionDir = process.env.MS_SESSION_DIR
const origPreEnvSessionDbPath = process.env.MS_SESSION_DB_PATH

const preImportTempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ms-rewards-hitl-test-'))
process.env.MS_SESSION_DIR = preImportTempDir
process.env.MS_SESSION_DB_PATH = path.join(preImportTempDir, 'sessions.db')

after(() => {
    if (origPreEnvSessionDir !== undefined) {
        process.env.MS_SESSION_DIR = origPreEnvSessionDir
    } else {
        delete process.env.MS_SESSION_DIR
    }

    if (origPreEnvSessionDbPath !== undefined) {
        process.env.MS_SESSION_DB_PATH = origPreEnvSessionDbPath
    } else {
        delete process.env.MS_SESSION_DB_PATH
    }

    try {
        fs.rmSync(preImportTempDir, { recursive: true, force: true })
    } catch {
        // ignore
    }
})

const {
    BOT_WARNING_KEY,
    evaluateBotChallengePolicy,
    formatHitlWebhookPayload
} = await import('./hitlBotChallenge.mjs')

test('BOT_WARNING_KEY constant is Fraud_UserWarning_BotScore_UX', () => {
    assert.equal(BOT_WARNING_KEY, 'Fraud_UserWarning_BotScore_UX')
})

test('evaluateBotChallengePolicy: normal flow when no warnings present', () => {
    // 1. Completely empty dashboard
    const res1 = evaluateBotChallengePolicy({}, {})
    assert.equal(res1.hasBotWarning, false)
    assert.equal(res1.action, 'normal')
    assert.equal(res1.shouldSkipAccount, false)
    assert.equal(res1.hitlNotification, null)
    assert.equal(res1.modifiedWorkers.doDesktopSearch, true)
    assert.equal(res1.modifiedWorkers.doMobileSearch, true)

    // 2. Dashboard with unrelated warnings
    const res2 = evaluateBotChallengePolicy({
        dashboard: {
            userWarnings: [{ name: 'SomeOtherWarning' }]
        }
    }, {
        workers: {
            doDesktopSearch: true,
            doMobileSearch: false,
            doDailyCheckIn: true
        }
    })
    assert.equal(res2.hasBotWarning, false)
    assert.equal(res2.action, 'normal')
    assert.equal(res2.modifiedWorkers.doDesktopSearch, true)
    assert.equal(res2.modifiedWorkers.doMobileSearch, false)
    assert.equal(res2.hitlNotification, null)
})

test('evaluateBotChallengePolicy: HITL safe fallback when BotScore warning is detected', () => {
    const dashboardData = {
        dashboard: {
            userWarnings: [
                { id: '123', name: 'Fraud_UserWarning_BotScore_UX' }
            ]
        }
    }

    const config = {
        workers: {
            doDesktopSearch: true,
            doMobileSearch: true,
            doDailyCheckIn: true,
            doReadToEarn: true,
            doDailySet: true,
            doMorePromotions: true,
            doPunchCards: true,
            doBonusSearches: false
        }
    }

    const res = evaluateBotChallengePolicy(dashboardData, config)

    // 验证核心策略
    assert.equal(res.hasBotWarning, true)
    assert.equal(res.action, 'hitl_safe_fallback')
    assert.equal(res.shouldSkipAccount, false, '不应跳过整个账号')

    // 验证易引发拼图人机验证的每日任务被主动剔除(由手机人工安全处理)
    assert.equal(res.modifiedWorkers.doDailySet, false, '每日任务必须剔除交由手机完成以防风控')

    // 验证繁重的搜索任务与常规轻量打卡由程序专职执行
    assert.equal(res.modifiedWorkers.doDesktopSearch, true, 'PC 搜索正常执行')
    assert.equal(res.modifiedWorkers.doMobileSearch, true, '移动搜索正常执行')
    assert.equal(res.modifiedWorkers.doDailyCheckIn, true, '签到保留')
    assert.equal(res.modifiedWorkers.doReadToEarn, true, '阅读资讯保留')
    assert.equal(res.modifiedWorkers.doMorePromotions, true, '推广任务保留')
    assert.equal(res.modifiedWorkers.doPunchCards, true, '打卡集点保留')

    // 验证跳过原因标记
    assert.equal(res.skippedReasons.dailySet, 'skip_bot_risk_guard_delegated_to_mobile')

    // 验证人机协同通知结构
    assert.ok(res.hitlNotification, '必须生成 HITL 协同通知')
    assert.equal(res.hitlNotification.type, 'bot_challenge_alert')
    assert.equal(res.hitlNotification.level, 'warn')
    assert.ok(res.hitlNotification.title.includes('人机安全质询'))
    assert.ok(res.hitlNotification.content.includes('Fraud_UserWarning_BotScore_UX'))
    assert.equal(res.hitlNotification.actionUrl, 'https://rewards.bing.com')
})

test('evaluateBotChallengePolicy: top-level userWarnings support (fallback payload)', () => {
    const dashboardData = {
        userWarnings: [
            { name: 'Fraud_UserWarning_BotScore_UX' }
        ]
    }
    const res = evaluateBotChallengePolicy(dashboardData)
    assert.equal(res.hasBotWarning, true)
    assert.equal(res.action, 'hitl_safe_fallback')
    assert.equal(res.modifiedWorkers.doDailySet, false)
})

test('evaluateBotChallengePolicy: continue_unsafe when contintueOnBotWarning is true', () => {
    const dashboardData = {
        dashboard: {
            userWarnings: [{ name: 'Fraud_UserWarning_BotScore_UX' }]
        }
    }
    const config = {
        contintueOnBotWarning: true,
        workers: {
            doDesktopSearch: true,
            doMobileSearch: true
        }
    }

    const res = evaluateBotChallengePolicy(dashboardData, config)
    assert.equal(res.hasBotWarning, true)
    assert.equal(res.action, 'continue_unsafe')
    assert.equal(res.shouldSkipAccount, false)
    assert.equal(res.modifiedWorkers.doDesktopSearch, true)
    assert.equal(res.modifiedWorkers.doMobileSearch, true)
    assert.ok(res.hitlNotification)
    assert.ok(res.hitlNotification.title.includes('强制继续运行'))
})

test('formatHitlWebhookPayload: null notification returns null', () => {
    assert.equal(formatHitlWebhookPayload({}, null), null)
    assert.equal(formatHitlWebhookPayload({}, undefined), null)
})

test('formatHitlWebhookPayload: Discord format', () => {
    const notification = {
        title: '⚠️ 微软 Rewards 人机质询提醒',
        content: '检测到风控，请打开页面破冰',
        actionUrl: 'https://rewards.bing.com'
    }
    const payload = formatHitlWebhookPayload({ type: 'discord' }, notification)
    assert.ok(payload.embeds && payload.embeds.length === 1)
    assert.equal(payload.embeds[0].title, notification.title)
    assert.ok(payload.embeds[0].description.includes('https://rewards.bing.com'))
    assert.equal(payload.embeds[0].color, 16753920)
})

test('formatHitlWebhookPayload: Telegram format', () => {
    const notification = {
        title: '⚠️ 微软 Rewards 人机质询提醒',
        content: '检测到风控，请打开页面破冰',
        actionUrl: 'https://rewards.bing.com'
    }
    const payload = formatHitlWebhookPayload({ type: 'telegram', chatId: '12345678' }, notification)
    assert.equal(payload.chat_id, '12345678')
    assert.equal(payload.parse_mode, 'Markdown')
    assert.ok(payload.text.includes('*⚠️ 微软 Rewards 人机质询提醒*'))
    assert.ok(payload.text.includes('https://rewards.bing.com'))
})

test('formatHitlWebhookPayload: generic HTTP (ServerChan / PushPlus / WeCom / DingTalk)', () => {
    const notification = {
        title: '⚠️ 微软 Rewards 人机质询提醒',
        content: '检测到风控，请打开页面破冰',
        actionUrl: 'https://rewards.bing.com'
    }
    const payload = formatHitlWebhookPayload({ type: 'custom' }, notification)
    assert.equal(payload.title, notification.title)
    assert.ok(payload.desp.includes('https://rewards.bing.com'))
    assert.ok(payload.text.includes('https://rewards.bing.com'))
    assert.equal(payload.msgtype, 'text')
    assert.ok(payload.content.text.includes('https://rewards.bing.com'))
})

test('evaluateBotChallengePolicy: skipOnBotWarning configuration skips account', () => {
    const dashboardData = {
        dashboard: {
            userWarnings: [{ name: 'Fraud_UserWarning_BotScore_UX' }]
        }
    }
    const config = {
        skipOnBotWarning: true,
        workers: { doDesktopSearch: true }
    }
    const res = evaluateBotChallengePolicy(dashboardData, config)
    assert.equal(res.hasBotWarning, true)
    assert.equal(res.action, 'skip_account')
    assert.equal(res.shouldSkipAccount, true)
})

test('public/index.html source verifies HITL banner markup and sanitizeUrl call', () => {
    const htmlPath = path.join(process.cwd(), 'public/index.html')
    const html = fs.readFileSync(htmlPath, 'utf-8')

    assert.ok(html.includes('id="unifiedBotChallengeBanner"'), 'Must have unifiedBotChallengeBanner')
    assert.ok(html.includes('id="desktopBotChallengeBanner"'), 'Must have desktopBotChallengeBanner')
    assert.ok(html.includes('function showBotChallengeBanner'), 'Must define showBotChallengeBanner')
    assert.ok(html.includes('sanitizeUrl(data.actionUrl)'), 'Must call sanitizeUrl for actionUrl link')
})

test('web.mjs computeTasks tags dailySet as SKIPPED with riskBadge when hasBotWarning is true', () => {
    const webPath = path.join(process.cwd(), 'web.mjs')
    const webSource = fs.readFileSync(webPath, 'utf-8')
    const fnStart = webSource.indexOf('function computeTasks(state)')
    const fnEnd = webSource.indexOf('function saveState(newState)')
    const fnSource = webSource.slice(fnStart, fnEnd)

    const parseQuota = (q) => {
        const parts = String(q || '0/0').split('/')
        return { earned: Number(parts[0]) || 0, max: Number(parts[1]) || 0, complete: Number(parts[0]) >= Number(parts[1]) && Number(parts[1]) > 0 }
    }
    const pointValue = (v) => Number(v) || 0

    const computeTasks = new Function('parseQuota', 'pointValue', `${fnSource}; return computeTasks;`)(parseQuota, pointValue)

    // Case 1: hasBotWarning is true and Daily Set is pending (1/3 done)
    const stateUnderRisk = {
        hasBotWarning: true,
        dailySetCards: [
            { offerId: 'card1', complete: true, points: 10 },
            { offerId: 'card2', complete: false, points: 10 },
            { offerId: 'card3', complete: false, points: 10 }
        ]
    }
    const tasks1 = computeTasks(stateUnderRisk)
    assert.equal(tasks1.dailySet.status, 'HIGH_RISK')
    assert.equal(tasks1.dailySet.riskLevel, 'HIGH_RISK')
    assert.equal(tasks1.dailySet.requiresManual, true)
    assert.equal(tasks1.dailySet.hasRiskWarning, true)
    assert.equal(tasks1.dailySet.riskBadge, '⚠️ 高风险 (需手工)')
    assert.ok(tasks1.dailySet.info.includes('高风险'))

    // Case 2: hasBotWarning is true but Daily Set is fully completed (3/3 done, e.g. on mobile)
    const stateCompleted = {
        hasBotWarning: true,
        dailySetCards: [
            { offerId: 'card1', complete: true, points: 10 },
            { offerId: 'card2', complete: true, points: 10 },
            { offerId: 'card3', complete: true, points: 10 }
        ]
    }
    const tasks2 = computeTasks(stateCompleted)
    assert.equal(tasks2.dailySet.status, 'DONE')
    assert.equal(tasks2.dailySet.hasRiskWarning, false)
    assert.equal(tasks2.dailySet.info, '今日已全部完成 (已达标)')

    // Case 3: hasBotWarning is false and Daily Set is pending
    const stateNormal = {
        hasBotWarning: false,
        dailySetCards: [
            { offerId: 'card1', complete: true, points: 10 },
            { offerId: 'card2', complete: false, points: 10 }
        ]
    }
    const tasks3 = computeTasks(stateNormal)
    assert.equal(tasks3.dailySet.status, 'PENDING')
    assert.equal(tasks3.dailySet.hasRiskWarning, false)
})

test('public/index.html UI elements for SKIPPED, HIGH_RISK and risk badges', () => {
    const htmlPath = path.join(process.cwd(), 'public/index.html')
    const html = fs.readFileSync(htmlPath, 'utf-8')

    assert.ok(html.includes("HIGH_RISK: ['⚠️', '高风险 (需手工)']"), 'Must define HIGH_RISK status in TASK_STATUS_META')
    assert.ok(html.includes('.card-type-badge.badge-warning'), 'Must have CSS class for badge-warning')
    assert.ok(html.includes('[data-task-status="HIGH_RISK"]'), 'Must have CSS style for HIGH_RISK task status')
    assert.ok(html.includes('isRiskSkipped'), 'renderDynamicCards must check isRiskSkipped')
    assert.ok(html.includes('⚠️ 高风险 (需手工)'), 'renderDynamicCards must show ⚠️ 高风险 (需手工) text for risk-skipped items')
})


