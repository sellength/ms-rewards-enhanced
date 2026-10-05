/**
 * Human-in-the-Loop (HITL) Bot Challenge Policy & Safe Fallback Module
 *
 * 核心设计：
 * 当检测到微软官方下发 Fraud_UserWarning_BotScore_UX 时，避免极端“直接退出”或“盲目硬跑”，
 * 实施自适应风控隔离：主动熔断高危批量搜索，保留轻量安全项目，并生成人机协同通知。
 */

export const BOT_WARNING_KEY = 'Fraud_UserWarning_BotScore_UX'

/**
 * 评估人机风控质询策略与任务计划裁剪
 * @param {object} dashboardData 微软官方仪表盘返回数据
 * @param {object} config 当前运行配置
 * @returns {object} 策略决策、裁剪后的 workers 计划及 HITL 协同通知内容
 */
export function evaluateBotChallengePolicy(dashboardData = {}, config = {}) {
    const userWarnings = dashboardData?.dashboard?.userWarnings || dashboardData?.userWarnings || []
    const hasBotWarning = Array.isArray(userWarnings) && userWarnings.some(w => w?.name === BOT_WARNING_KEY)

    const workers = config?.workers || {
        doDesktopSearch: true,
        doMobileSearch: true,
        doDailyCheckIn: true,
        doReadToEarn: true,
        doDailySet: false, // 每日任务(问答/投票)极易触发翻转拼图，交由用户手机端安全完成
        doMorePromotions: true,
        doPunchCards: true,
        doBonusSearches: false
    }

    if (!hasBotWarning) {
        return {
            hasBotWarning: false,
            action: 'normal',
            shouldSkipAccount: false,
            modifiedWorkers: { ...workers },
            skippedReasons: {},
            hitlNotification: null
        }
    }

    // 若用户显式要求跳过账号 (skipOnBotWarning: true)
    if (config?.skipOnBotWarning === true) {
        return {
            hasBotWarning: true,
            action: 'skip_account',
            shouldSkipAccount: true,
            modifiedWorkers: { ...workers },
            skippedReasons: { all: 'skip_bot_score_guard' },
            hitlNotification: {
                type: 'bot_challenge_alert',
                level: 'warn',
                title: '⚠️ 微软 BotScore 风控中 (账号已跳过)',
                content: `微软已标记 ${BOT_WARNING_KEY}，系统已按配置跳过此账号。`,
                actionUrl: 'https://rewards.bing.com',
                actionLabel: '打开官方页面',
                timestamp: Date.now()
            }
        }
    }

    // 若用户显式开启强制硬跑 (contintueOnBotWarning: true)，记录高危行为
    if (config?.contintueOnBotWarning === true) {
        return {
            hasBotWarning: true,
            action: 'continue_unsafe',
            shouldSkipAccount: false,
            modifiedWorkers: { ...workers },
            skippedReasons: {},
            hitlNotification: {
                type: 'bot_challenge_alert',
                level: 'warn',
                title: '⚠️ 微软 BotScore 风控中 (强制继续运行)',
                content: '微软已标记 Fraud_UserWarning_BotScore_UX，但系统配置了强制继续。',
                actionUrl: 'https://rewards.bing.com',
                actionLabel: '打开官方页面'
            }
        }
    }

    // HITL 人机协同防风控降级模式 (默认推荐模式)：
    // 每日任务(问答、投票等)模拟交互极易触发翻转图片/旋转动物拼图，自动规避并交由手机端人工完成；
    // 自动化程序专职安全执行大量搜索与阅读打卡任务。
    const modifiedWorkers = {
        ...workers,
        doDailySet: false,
        doDesktopSearch: workers.doDesktopSearch,
        doMobileSearch: workers.doMobileSearch
    }

    const skippedReasons = {
        dailySet: 'skip_bot_risk_guard_delegated_to_mobile'
    }

    const hitlNotification = {
        type: 'bot_challenge_alert',
        level: 'warn',
        title: '⚠️ 触发微软人机安全质询 (已自动规避每日任务)',
        content: '检测到微软官方风控标记 (Fraud_UserWarning_BotScore_UX)。每日任务（问答/投票）极易触发翻转拼图验证，已主动交由用户在手机端安全完成；自动化程序专职安全执行日常搜索与轻量任务。',
        actionUrl: 'https://rewards.bing.com',
        actionLabel: '手机端打卡/完成验证',
        timestamp: Date.now()
    }

    return {
        hasBotWarning: true,
        action: 'hitl_safe_fallback',
        shouldSkipAccount: false,
        modifiedWorkers,
        skippedReasons,
        hitlNotification
    }
}

/**
 * 格式化 Webhook 推送数据 (适配 PushPlus / Server酱 / Telegram / Discord 等)
 */
export function formatHitlWebhookPayload(conf = {}, notification) {
    if (!notification) return null

    const title = notification.title || '⚠️ 微软 Rewards 人机质询提醒'
    const content = `${notification.content}\n\n👉 快捷入口: ${notification.actionUrl}`

    // 1. Discord
    if (conf.type === 'discord') {
        return {
            username: 'Microsoft Rewards Safety Bot',
            avatar_url: 'https://img-prod-cms-rt-microsoft-com.akamaized.net/cms/api/am/imageFileData/RE1Mu3b?ver=5c31',
            embeds: [{
                title,
                description: content,
                color: 16753920, // 橙黄色警告
                timestamp: new Date().toISOString()
            }]
        }
    }

    // 2. Telegram
    if (conf.type === 'telegram') {
        return {
            chat_id: conf.chatId,
            text: `*${title}*\n\n${content}`,
            parse_mode: 'Markdown'
        }
    }

    // 3. 通用 HTTP Webhook (ServerChan / PushPlus / 企业微信 / 钉钉)
    return {
        title,
        desp: content,
        text: content,
        msgtype: 'text',
        content: { text: content }
    }
}
