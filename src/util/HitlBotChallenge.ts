import { Config, ConfigWorkers } from '../interface/Config'

export const BOT_WARNING_KEY = 'Fraud_UserWarning_BotScore_UX'

export interface HitlNotification {
    type: string
    level: string
    title: string
    content: string
    actionUrl: string
    actionLabel: string
    timestamp: number
}

export interface BotChallengePolicyResult {
    hasBotWarning: boolean
    action: 'normal' | 'hitl_safe_fallback' | 'continue_unsafe'
    shouldSkipAccount: boolean
    modifiedWorkers: ConfigWorkers
    skippedReasons: Record<string, string>
    hitlNotification: HitlNotification | null
}

const DEFAULT_WORKERS: ConfigWorkers = {
    doDailySet: false, // 每日任务(问答/投票)极易触发翻转拼图，交由用户手机端安全完成
    doMorePromotions: true,
    doClaimBonusPoints: false,
    doPunchCards: true,
    doAppPromotions: true,
    doDesktopSearch: true,
    doMobileSearch: true,
    doBonusSearches: false,
    doDailyCheckIn: true,
    doReadToEarn: true,
    doActivateSearchPerk: false,
    doVisualSearch: false
}

/**
 * 评估人机风控质询策略与任务计划裁剪
 */
export function evaluateBotChallengePolicy(
    dashboardData: any = {},
    config?: Partial<Config>
): BotChallengePolicyResult {
    const userWarnings = dashboardData?.dashboard?.userWarnings || dashboardData?.userWarnings || []
    const hasBotWarning = Array.isArray(userWarnings) && userWarnings.some((w: any) => w?.name === BOT_WARNING_KEY)

    const workers: ConfigWorkers = {
        ...DEFAULT_WORKERS,
        ...(config?.workers || {})
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

    // 若配置显式要求完全跳过账号 (skipOnBotWarning: true)
    if ((config as any)?.skipOnBotWarning === true) {
        return {
            hasBotWarning: true,
            action: 'skip_account' as any,
            shouldSkipAccount: true,
            modifiedWorkers: { ...workers },
            skippedReasons: { all: 'skip_bot_score_guard' },
            hitlNotification: {
                type: 'bot_challenge_alert',
                level: 'warn',
                title: '⚠️ 微软 BotScore 风控中 (账号已跳过)',
                content: `Microsoft Rewards reported ${BOT_WARNING_KEY}. This account was skipped as configured.`,
                actionUrl: 'https://rewards.bing.com',
                actionLabel: '打开官方页面',
                timestamp: Date.now()
            }
        }
    }

    // 若配置强制继续运行 (contintueOnBotWarning: true)
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
                actionLabel: '打开官方页面',
                timestamp: Date.now()
            }
        }
    }

    // HITL 人机协同防风控降级模式 (默认推荐)：
    // 每日任务(问答、投票等)模拟交互极易触发翻转图片/旋转动物拼图，自动规避并交由手机端人工完成；
    // 自动化程序专职安全执行大量搜索与阅读打卡任务。
    const modifiedWorkers: ConfigWorkers = {
        ...workers,
        doDailySet: false,
        doDesktopSearch: workers.doDesktopSearch,
        doMobileSearch: workers.doMobileSearch
    }

    const skippedReasons: Record<string, string> = {
        dailySet: 'skip_bot_risk_guard_delegated_to_mobile'
    }

    const hitlNotification: HitlNotification = {
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
