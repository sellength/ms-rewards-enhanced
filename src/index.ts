import { AsyncLocalStorage } from 'node:async_hooks'
import cluster, { Worker } from 'cluster'
import type { BrowserContext, Cookie, Page } from 'patchright'
import pkg from '../package.json'

import type { BrowserFingerprintWithHeaders } from 'fingerprint-generator'

import Browser from './browser/Browser'
import BrowserFunc from './browser/BrowserFunc'
import BrowserUtils from './browser/BrowserUtils'
import ReactFunc from './browser/ReactFunc'
import type { PageSnapshot } from './browser/ReactFunc'

import { IpcLog, Logger } from './logging/Logger'
import Utils, { isBrowserClosedError } from './util/Utils'
import { loadAccounts, loadConfig } from './util/Load'
import { closeSessionStore, loadResolvedRegion, saveResolvedRegion } from './util/SessionStore'
import { checkNodeVersion } from './util/Validator'
import { normalizeCountry, resolveAccountLocale } from './util/Locale'
import type { AccountLocale } from './util/Locale'
import { resolveOfficialDailySetDate } from './util/DailySetCycle'
import { runIsolatedTask } from './util/TaskIsolation'
import { sanitizeCookies } from './util/SessionSanitizer'
import { selectPcKeepEarningPromotions } from '../promotion-classification.cjs'
import { evaluateBotChallengePolicy, BOT_WARNING_KEY } from './util/HitlBotChallenge'

import { Login } from './browser/auth/Login'
import Activities from './functions/Activities'
import { SearchManager } from './functions/activities/search/SearchManager'
import { resolveAppDailySetDate } from './functions/activities/app/AppState'

import type { Account } from './interface/Account'
import HttpClient from './util/Http'
import { sendDiscord, flushDiscordQueue } from './logging/Discord'
import { sendNtfy, flushNtfyQueue } from './logging/Ntfy'
import { sendTelegram, flushTelegramQueue } from './logging/Telegram'
import type { BasePromotion, DashboardData } from './interface/DashboardData'
import type { AppDashboardData } from './interface/AppDashBoardData'
import type { AppEarnablePoints, BrowserEarnablePoints } from './interface/Points'

interface ExecutionContext {
    isMobile: boolean
    account: Account
}

interface BrowserSession {
    context: BrowserContext
    fingerprint: BrowserFingerprintWithHeaders
}

interface AccountStats {
    email: string
    initialPoints: number
    finalPoints: number
    collectedPoints: number
    duration: number
    success: boolean
    error?: string
}

interface AccountRunResult {
    initialPoints: number
    collectedPoints: number
    skippedForBotWarning?: boolean
}

const executionContext = new AsyncLocalStorage<ExecutionContext>()

export function getCurrentContext(): ExecutionContext {
    const context = executionContext.getStore()
    if (!context) {
        return { isMobile: false, account: {} as Account }
    }
    return context
}

async function flushAllWebhooks(timeoutMs = 5000): Promise<void> {
    await Promise.allSettled([flushDiscordQueue(timeoutMs), flushNtfyQueue(timeoutMs), flushTelegramQueue(timeoutMs)])
    closeSessionStore()
}

interface UserData {
    userName: string
    geoLocale: string
    langCode: string
    timezoneOffset: string
    initialPoints: number
    currentPoints: number
    gainedPoints: number
}

export class MicrosoftRewardsBot {
    public logger: Logger
    public config
    public utils: Utils
    public activities: Activities = new Activities(this)
    public browser: { func: BrowserFunc; utils: BrowserUtils; react: ReactFunc }

    public mainMobilePage!: Page
    public mainDesktopPage!: Page

    public userData: UserData
    public accountLocale: AccountLocale

    public nextActions: Record<string, string> = {}
    public nextRouterStateTree = ''
    public reactSnapshot: PageSnapshot | null = null
    public reactSnapshots: { mobile: PageSnapshot | null; desktop: PageSnapshot | null } = {
        mobile: null,
        desktop: null
    }
    public searchTopicsCache: { key: string; topics: Promise<string[]> } | null = null
    public dailySetDate: string | null = null

    public accessToken = ''
    public browserEarnable: BrowserEarnablePoints | null = null
    public cookies: { mobile: Cookie[]; desktop: Cookie[] }
    private fingerprintMobile?: BrowserFingerprintWithHeaders
    private fingerprintDesktop?: BrowserFingerprintWithHeaders

    get fingerprint(): BrowserFingerprintWithHeaders {
        const ctx = this.isMobile ? this.fingerprintMobile : this.fingerprintDesktop
        return (ctx ?? this.fingerprintMobile ?? this.fingerprintDesktop) as BrowserFingerprintWithHeaders
    }

    private activeWorkers: number
    private exitedWorkers: number[]
    private browserFactory: Browser = new Browser(this)
    private accounts: Account[]
    private searchManager: SearchManager
    private login = new Login(this)

    public http!: HttpClient

    constructor() {
        this.userData = {
            userName: '',
            geoLocale: 'US',
            langCode: 'en',
            timezoneOffset: '60',
            initialPoints: 0,
            currentPoints: 0,
            gainedPoints: 0
        }
        this.accountLocale = resolveAccountLocale({ langCode: 'en', geoLocale: 'US' })
        this.logger = new Logger(this)
        this.accounts = []
        this.cookies = { mobile: [], desktop: [] }
        this.utils = new Utils()
        this.searchManager = new SearchManager(this)
        this.browser = {
            func: new BrowserFunc(this),
            utils: new BrowserUtils(this),
            react: new ReactFunc(this)
        }
        this.config = loadConfig()
        this.activeWorkers = this.config.clusters
        this.exitedWorkers = []
    }

    get isMobile(): boolean {
        return getCurrentContext().isMobile
    }

    get currentAccountEmail(): string | null {
        return getCurrentContext().account?.email || null
    }

    async refreshCurrentRewardsContext(reason: string): Promise<boolean> {
        const context = getCurrentContext()
        const account = context.account
        let page = context.isMobile ? this.mainMobilePage : this.mainDesktopPage
        let recoverySession: BrowserSession | null = null
        let refreshSucceeded = false

        if (!account?.email) {
            this.logger.debug(
                this.isMobile,
                'CONTEXT-REFRESH',
                `Cannot refresh rewards context | reason=${reason} | account=unavailable`
            )
            return false
        }

        try {
            this.logger.warn(
                this.isMobile,
                'CONTEXT-REFRESH',
                `Refreshing rewards browser context after request failure | reason=${reason}`
            )

            if (!page || page.isClosed()) {
                recoverySession = await this.browserFactory.createBrowser(account)
                page = await recoverySession.context.newPage()
                if (context.isMobile) {
                    this.mainMobilePage = page
                    this.fingerprintMobile = recoverySession.fingerprint
                } else {
                    this.mainDesktopPage = page
                    this.fingerprintDesktop = recoverySession.fingerprint
                }

                await this.login.login(page, account)
            } else {
                this.nextActions = {}
                this.nextRouterStateTree = ''
                this.reactSnapshot = null
                await this.browser.func.synchronizeActiveBrowserCookies('CONTEXT-REFRESH-COOKIE-SEED', true)
                try {
                    await this.browser.func.bootstrap(page)
                } catch {
                    await this.login.login(page, account)
                }
            }

            await this.browser.func.checkpointActiveSession('CONTEXT-REFRESH')

            const refreshedCookies = await page.context().cookies()
            this.logger.info(
                this.isMobile,
                'CONTEXT-REFRESH',
                `Rewards context refreshed successfully | cookies=${refreshedCookies.length}`,
                'green'
            )
            refreshSucceeded = true
            return true
        } catch (error) {
            this.logger.error(
                this.isMobile,
                'CONTEXT-REFRESH',
                `Rewards context refresh failed | reason=${reason} | message=${error instanceof Error ? error.message : String(error)}`
            )
            return false
        } finally {
            if (recoverySession) {
                await this.browser.func.closeBrowser(recoverySession.context, account.email, refreshSucceeded)
            }
        }
    }

    async initialize(): Promise<void> {
        this.accounts = loadAccounts()
        const targetEmail = process.env.REWARDS_ACTIVE_PROFILE_EMAIL?.trim().toLowerCase()
        if (targetEmail) {
            const filtered = this.accounts.filter(a => a.email.toLowerCase() === targetEmail)
            if (filtered.length > 0) {
                this.accounts = filtered
            } else {
                const targetRegion = process.env.REWARDS_ACTIVE_PROFILE_REGION || 'auto'
                this.accounts = [{
                    email: process.env.REWARDS_ACTIVE_PROFILE_EMAIL ? process.env.REWARDS_ACTIVE_PROFILE_EMAIL.trim() : targetEmail,
                    password: '',
                    recoveryEmail: '',
                    geoLocale: targetRegion,
                    langCode: 'en',
                    proxy: { proxyHttp: false, url: '', port: 0, username: '', password: '' },
                    saveFingerprint: { mobile: true, desktop: true }
                }]
            }
        }
        this.warnExperimental()
    }

    private warnExperimental(): void {
        const exp = this.config.experimental
        const searchFeatures = [exp.apiSearch && 'apiSearch', exp.apiSearchOnBing && 'apiSearchOnBing'].filter(
            Boolean
        ) as string[]

        if (searchFeatures.length) {
            this.logger.warn(
                'main',
                'EXPERIMENTAL',
                `${searchFeatures.join(' + ')} enabled - these perform searches over HTTP with no real browser. ` +
                    `This path is EXPERIMENTAL and UNSAFE and may get your account flagged or banned. ` +
                    `Disable it under config.experimental if you are unsure.`,
                'redBright'
            )
        }

        if (exp.edgeBrowsing && process.env.REWARDS_MODE !== 'mobile') {
            this.logger.warn(
                'main',
                'EXPERIMENTAL',
                'edgeBrowsing enabled - the Edge browsing activity will be reported over HTTP in the background. ' +
                    'This integration is experimental; disable it under config.experimental if it behaves unexpectedly.'
            )
        }
    }

    async run(): Promise<void> {
        const totalAccounts = this.accounts.length
        const runStartTime = Date.now()

        this.logger.info(
            'main',
            'RUN-START',
            `Starting Microsoft Rewards Script | v${pkg.version} | Accounts: ${totalAccounts} | Clusters: ${this.config.clusters}`
        )

        if (this.config.clusters > 1) {
            if (cluster.isPrimary) {
                await this.runMaster(runStartTime)
            } else {
                this.runWorker(runStartTime)
            }
        } else {
            await this.runTasks(this.accounts, runStartTime)
        }
    }

    private async runMaster(runStartTime: number): Promise<void> {
        void this.logger.info('main', 'CLUSTER-PRIMARY', `Primary process started | PID: ${process.pid}`)

        const rawChunks = this.utils.chunkArray(this.accounts, this.config.clusters)
        const accountChunks = rawChunks.filter(c => c && c.length > 0)
        this.activeWorkers = accountChunks.length

        const allAccountStats: AccountStats[] = []
        let hadWorkerFailure = false

        for (const [chunkIndex, chunk] of accountChunks.entries()) {
            if (chunkIndex > 0) {
                await this.waitBeforeNextAccount(chunk[0]?.email)
            }

            const worker = cluster.fork()
            worker.send?.({ chunk, runStartTime })

            worker.on('message', (msg: { __ipcLog?: IpcLog; __stats?: AccountStats[] }) => {
                if (msg.__stats) {
                    allAccountStats.push(...msg.__stats)
                }

                const log = msg.__ipcLog
                if (log && typeof log.content === 'string') {
                    const { webhook } = this.config
                    if (webhook.enabled === false) return
                    const { content, level } = log

                    if (webhook.discord?.enabled && webhook.discord.url) {
                        sendDiscord(webhook.discord.url, content, level)
                    }
                    if (webhook.ntfy?.enabled && webhook.ntfy.url) {
                        sendNtfy(webhook.ntfy, content, level)
                    }
                    if (webhook.telegram?.enabled && webhook.telegram.botToken && webhook.telegram.chatId) {
                        sendTelegram(webhook.telegram, content, level)
                    }
                }
            })
        }

        const onWorkerExit = async (worker: Worker, code?: number, signal?: string): Promise<void> => {
            const { pid } = worker.process

            if (!pid || this.exitedWorkers.includes(pid)) {
                return
            }

            this.exitedWorkers.push(pid)
            this.activeWorkers -= 1

            const failed = (code ?? 0) !== 0 || Boolean(signal)
            if (failed) {
                hadWorkerFailure = true
            }

            this.logger.warn(
                'main',
                'CLUSTER-WORKER-EXIT',
                `Worker ${pid} exit | Code: ${code ?? 'n/a'} | Signal: ${signal ?? 'n/a'} | Active workers: ${this.activeWorkers}`
            )

            if (this.activeWorkers <= 0) {
                const totalCollectedPoints = allAccountStats.reduce((sum, s) => sum + s.collectedPoints, 0)
                const totalInitialPoints = allAccountStats.reduce((sum, s) => sum + s.initialPoints, 0)
                const totalFinalPoints = allAccountStats.reduce((sum, s) => sum + s.finalPoints, 0)
                const totalDurationMinutes = ((Date.now() - runStartTime) / 1000 / 60).toFixed(1)

                this.logger.info(
                    'main',
                    'RUN-END',
                    `Completed all accounts | accountsProcessed=${allAccountStats.length} | pointsGained=${totalCollectedPoints} | previousBalance=${totalInitialPoints} | currentBalance=${totalFinalPoints} | runtimeMinutes=${totalDurationMinutes}`,
                    'green'
                )

                await flushAllWebhooks()

                process.exit(hadWorkerFailure ? 1 : 0)
            }
        }

        cluster.on('exit', (worker, code, signal) => {
            void onWorkerExit(worker, code ?? undefined, signal ?? undefined)
        })

        cluster.on('disconnect', worker => {
            const pid = worker.process?.pid
            this.logger.warn('main', 'CLUSTER-WORKER-DISCONNECT', `Worker ${pid ?? '?'} disconnected`)
        })
    }

    private runWorker(runStartTimeFromMaster?: number): void {
        void this.logger.info('main', 'CLUSTER-WORKER-START', `Worker spawned | PID: ${process.pid}`)

        process.on('message', async ({ chunk, runStartTime }: { chunk: Account[]; runStartTime: number }) => {
            void this.logger.info(
                'main',
                'CLUSTER-WORKER-TASK',
                `Worker ${process.pid} received ${chunk.length} accounts.`
            )

            try {
                const stats = await this.runTasks(chunk, runStartTime ?? runStartTimeFromMaster ?? Date.now())

                if (process.send) {
                    process.send({ __stats: stats })
                }

                await flushAllWebhooks()
                process.exit(0)
            } catch (error) {
                this.logger.error(
                    'main',
                    'CLUSTER-WORKER-ERROR',
                    `Worker task crash: ${error instanceof Error ? error.message : String(error)}`
                )

                await flushAllWebhooks()
                process.exit(1)
            }
        })
    }

    private async runTasks(accounts: Account[], runStartTime: number): Promise<AccountStats[]> {
        const accountStats: AccountStats[] = []

        for (const [accountIndex, account] of accounts.entries()) {
            if (accountIndex > 0) {
                await this.waitBeforeNextAccount(account.email)
            }

            const accountStartTime = Date.now()
            const accountEmail = account.email
            this.userData.userName = this.utils.getEmailUsername(accountEmail)
            this.userData.timezoneOffset = String(new Date().getTimezoneOffset())

            try {
                const cachedRegion =
                    account.geoLocale === 'auto' ? loadResolvedRegion(this.config.sessionPath, accountEmail) : undefined
                this.accountLocale = resolveAccountLocale(account, cachedRegion)
                this.userData.langCode = this.accountLocale.language
                this.userData.geoLocale = this.accountLocale.country ?? 'US'

                this.logger.info(
                    'main',
                    'ACCOUNT-START',
                    `Starting account: ${accountEmail} | geoLocale: ${account.geoLocale} | locale: ${this.accountLocale.locale}${
                        cachedRegion ? ` | cachedRegion: ${cachedRegion}` : ''
                    }`
                )

                this.http = new HttpClient(account.proxy, {
                    'Accept-Language': this.accountLocale.acceptLanguage
                })

                const result: AccountRunResult | undefined = await this.Main(account).catch(error => {
                    void this.logger.error(
                        true,
                        'FLOW',
                        `Mobile flow failed for ${accountEmail}: ${error instanceof Error ? error.message : String(error)}`
                    )
                    return undefined
                })

                const durationSeconds = ((Date.now() - accountStartTime) / 1000).toFixed(1)

                if (result) {
                    const collectedPoints = result.collectedPoints ?? 0
                    const accountInitialPoints = result.initialPoints ?? 0
                    const accountFinalPoints = accountInitialPoints + collectedPoints

                    if (result.skippedForBotWarning) {
                        accountStats.push({
                            email: accountEmail,
                            initialPoints: accountInitialPoints,
                            finalPoints: accountInitialPoints,
                            collectedPoints: 0,
                            duration: parseFloat(durationSeconds),
                            success: false,
                            error: 'Microsoft bot-score warning detected'
                        })

                        this.logger.warn(
                            'main',
                            'ACCOUNT-SKIP',
                            `Skipped account: ${accountEmail} | reason=Fraud_UserWarning_BotScore_UX | durationSeconds=${durationSeconds}`
                        )
                    } else {
                        accountStats.push({
                            email: accountEmail,
                            initialPoints: accountInitialPoints,
                            finalPoints: accountFinalPoints,
                            collectedPoints: collectedPoints,
                            duration: parseFloat(durationSeconds),
                            success: true
                        })

                        this.logger.info(
                            'main',
                            'ACCOUNT-END',
                            `Completed account: ${accountEmail} | pointsGained=${collectedPoints} | previousBalance=${accountInitialPoints} | currentBalance=${accountFinalPoints} | durationSeconds=${durationSeconds}`,
                            'green'
                        )
                    }
                } else {
                    accountStats.push({
                        email: accountEmail,
                        initialPoints: 0,
                        finalPoints: 0,
                        collectedPoints: 0,
                        duration: parseFloat(durationSeconds),
                        success: false,
                        error: 'Flow failed'
                    })
                }
            } catch (error) {
                const durationSeconds = ((Date.now() - accountStartTime) / 1000).toFixed(1)
                this.logger.error(
                    'main',
                    'ACCOUNT-ERROR',
                    `${accountEmail}: ${error instanceof Error ? error.message : String(error)}`
                )

                accountStats.push({
                    email: accountEmail,
                    initialPoints: 0,
                    finalPoints: 0,
                    collectedPoints: 0,
                    duration: parseFloat(durationSeconds),
                    success: false,
                    error: error instanceof Error ? error.message : String(error)
                })
            }
        }

        if (this.config.clusters <= 1 && cluster.isPrimary) {
            const totalCollectedPoints = accountStats.reduce((sum, s) => sum + s.collectedPoints, 0)
            const totalInitialPoints = accountStats.reduce((sum, s) => sum + s.initialPoints, 0)
            const totalFinalPoints = accountStats.reduce((sum, s) => sum + s.finalPoints, 0)
            const totalDurationMinutes = ((Date.now() - runStartTime) / 1000 / 60).toFixed(1)

            this.logger.info(
                'main',
                'RUN-END',
                `Completed all accounts | accountsProcessed=${accountStats.length} | pointsGained=${totalCollectedPoints} | previousBalance=${totalInitialPoints} | currentBalance=${totalFinalPoints} | runtimeMinutes=${totalDurationMinutes}`,
                'green'
            )

            await flushAllWebhooks()
            process.exit(0)
        }

        return accountStats
    }

    private async waitBeforeNextAccount(nextEmail?: string): Promise<void> {
        const { min, max } = this.config.accountDelay
        const minMs = typeof min === 'number' ? min : this.utils.stringToNumber(min)
        const maxMs = typeof max === 'number' ? max : this.utils.stringToNumber(max)

        if (minMs < 0 || maxMs < 0 || maxMs < minMs) {
            throw new Error('accountDelay must use non-negative values with max greater than or equal to min')
        }

        const delayMs = this.utils.randomNumber(Math.ceil(minMs), Math.floor(maxMs))
        this.logger.info(
            'main',
            'ACCOUNT-DELAY',
            `Waiting ${(delayMs / 1000).toFixed(1)} seconds before starting the next account${
                nextEmail ? ` (${nextEmail})` : ''
            }`
        )
        await this.utils.wait(delayMs)
    }

    async createDesktopSession(account: Account): Promise<BrowserSession> {
        const session = await this.browserFactory.createBrowser(account)
        if (this.cookies.mobile && this.cookies.mobile.length > 0) {
            try {
                const cleanCookies = sanitizeCookies(this.cookies.mobile, false)
                if (cleanCookies.length > 0) {
                    await session.context.addCookies(cleanCookies)
                }
            } catch {}
        }
        this.mainDesktopPage = await session.context.newPage()
        this.fingerprintDesktop = session.fingerprint

        this.logger.info(this.isMobile, 'BROWSER', `Desktop Browser started | ${account.email}`)

        await this.login.login(this.mainDesktopPage, account)
        await this.browser.func.checkpointActiveSession('LOGIN-CHECKPOINT')
        this.cookies.desktop = await session.context.cookies()

        return session
    }

    async Main(account: Account): Promise<AccountRunResult> {
        const originalWorkers = { ...this.config.workers }
        const accountEmail = account.email
        this.logger.info('main', 'FLOW', `Starting session for ${accountEmail}`)

        this.accessToken = ''
        this.cookies = { mobile: [], desktop: [] }
        this.fingerprintMobile = undefined
        this.fingerprintDesktop = undefined
        this.reactSnapshot = null
        this.reactSnapshots = { mobile: null, desktop: null }
        this.searchTopicsCache = null
        this.dailySetDate = null

        const apiSearch = this.config.experimental.apiSearch
        const apiSearchOnBing = this.config.experimental.apiSearchOnBing
        const fullApi = apiSearch && (apiSearchOnBing || !this.config.activities.searchOnBing)
        const desktopMode = process.env.REWARDS_MODE === 'desktop'
        const mobileMode = process.env.REWARDS_MODE === 'mobile'
        const sharedMode = process.env.REWARDS_MODE === 'shared'
        const loginMode = process.env.REWARDS_MODE === 'login'
        const allowDesktopTasks = !mobileMode && !loginMode
        const allowMobileTasks = !desktopMode && !loginMode && !sharedMode
        const needsAppActivities =
            allowMobileTasks &&
            (this.config.workers.doDailyCheckIn ||
                this.config.workers.doAppPromotions ||
                this.config.workers.doReadToEarn)
        const needsAppState =
            loginMode ||
            needsAppActivities ||
            (allowMobileTasks && this.config.workers.doMobileSearch) ||
            (mobileMode && this.config.workers.doDailySet)
        const needsAppAccessToken = (allowDesktopTasks && this.config.experimental.edgeBrowsing) || needsAppState

        let mobileSession: BrowserSession | null = null
        let desktopSession: BrowserSession | null = null
        const edgeBrowsingController = new AbortController()
        let edgeBrowsingTask: Promise<void> | null = null
        let edgeBrowsingFinished = false

        const closeMobileSession = async (): Promise<void> => {
            const session = mobileSession
            if (!session) return
            mobileSession = null

            await executionContext.run({ isMobile: true, account }, async () => {
                await this.browser.func.checkpointActiveSession('PRE-BROWSER-CLOSE')
                await this.browser.func.closeBrowser(session.context, accountEmail)
            })
        }

        const closeDesktopSession = async (): Promise<void> => {
            const session = desktopSession
            if (!session) return
            desktopSession = null

            await executionContext.run({ isMobile: false, account }, async () => {
                await this.browser.func.checkpointActiveSession('PRE-BROWSER-CLOSE')
                await this.browser.func.closeBrowser(session.context, accountEmail)
            })
        }

        const ensureDesktopSession = async (): Promise<void> => {
            if (desktopSession) return
            await executionContext.run({ isMobile: false, account }, async () => {
                desktopSession = await this.createDesktopSession(account)
            })
        }

        const runDesktopTask = async <T>(task: () => Promise<T>): Promise<T> => {
            await ensureDesktopSession()
            return await executionContext.run({ isMobile: false, account }, task)
        }

        const runIsolatedActivity = async (
            isMobile: boolean,
            context: string,
            task: () => Promise<void>
        ): Promise<void> => {
            await runIsolatedTask(task, error => {
                this.logger.error(
                    isMobile,
                    context,
                    `Task failed; continuing with the next independent activity | message=${
                        error instanceof Error ? error.message : String(error)
                    }`
                )
            })
        }

        const runMobileActivity = async (context: string, task: () => Promise<void>): Promise<void> => {
            await runIsolatedActivity(true, context, task)
        }

        const runDesktopActivity = async (context: string, task: () => Promise<void>): Promise<void> => {
            await ensureDesktopSession()
            await runIsolatedActivity(false, context, () => executionContext.run({ isMobile: false, account }, task))
        }

        try {
            return await executionContext.run({ isMobile: true, account }, async () => {
                mobileSession = await this.browserFactory.createBrowser(account)
                const initialContext: BrowserContext = mobileSession.context
                this.mainMobilePage = await initialContext.newPage()

                this.logger.info('main', 'BROWSER', `Mobile Browser started | ${accountEmail}`)

                await this.login.login(this.mainMobilePage, account)

                if (needsAppAccessToken) {
                    try {
                        this.accessToken = await this.login.getAppAccessToken(this.mainMobilePage, accountEmail)
                    } catch (error) {
                        this.logger.error(
                            'main',
                            'FLOW',
                            `Failed to get mobile access token: ${error instanceof Error ? error.message : String(error)}`
                        )
                        this.accessToken = ''
                    }
                }

                await this.browser.func.checkpointActiveSession('LOGIN-CHECKPOINT')
                this.cookies.mobile = await initialContext.cookies()
                this.fingerprintMobile = mobileSession.fingerprint

                if (fullApi && !(mobileMode && this.config.workers.doDailySet)) {
                    await closeMobileSession()
                    this.logger.info(
                        'main',
                        'FLOW',
                        'Mobile login browser closed; continuing with the saved session and HTTP requests'
                    )
                }

                const data: DashboardData = await this.browser.func.getDashboardData()
                const dailySetMap = data.dashboard.dailySetPromotions ?? {}
                const allDailyOffers = Object.values(dailySetMap).flat()
                const candidateOfferIds = (this.reactSnapshot?.offers ?? []).length > 0
                    ? (this.reactSnapshot?.offers ?? []).map(offer => offer.offerId)
                    : allDailyOffers.map(o => o.offerId)
                this.dailySetDate = resolveOfficialDailySetDate(
                    Object.keys(dailySetMap),
                    candidateOfferIds,
                    process.env.REWARDS_DAILY_SET_DATE
                )
                const botChallengePolicy = evaluateBotChallengePolicy(data.dashboard, this.config)
                if (botChallengePolicy.hasBotWarning) {
                    const availablePoints = data.dashboard.userStatus.availablePoints ?? 0

                    if (botChallengePolicy.shouldSkipAccount) {
                        this.logger.warn(
                            'main',
                            'BOT-WARNING',
                            `Microsoft Rewards reported ${BOT_WARNING_KEY} for ${accountEmail}. ` +
                                'This account will be skipped for safety as configured.'
                        )

                        return {
                            initialPoints: availablePoints,
                            collectedPoints: 0,
                            skippedForBotWarning: true
                        }
                    }

                    if (botChallengePolicy.action === 'hitl_safe_fallback') {
                        this.logger.warn(
                            'main',
                            'HITL-BOT-CHALLENGE',
                            `[HITL-BOT-CHALLENGE] 🛡️ 微软官方已下发人机质询标记 (${BOT_WARNING_KEY})。系统已启动 HITL 安全避险模式：自动跳过每日任务(问答/答题)，专职安全执行日常搜索与轻量打卡任务。`
                        )
                        this.config.workers = {
                            ...this.config.workers,
                            ...botChallengePolicy.modifiedWorkers
                        }
                    } else if (botChallengePolicy.action === 'continue_unsafe') {
                        this.logger.warn(
                            'main',
                            'BOT-WARNING',
                            `Microsoft Rewards reported ${BOT_WARNING_KEY} for ${accountEmail}, but contintueOnBotWarning=true. ` +
                                'Continuing as configured is not recommended; waiting a few days is the preferred action.'
                        )
                    }
                }

                const profileCountry = normalizeCountry(data.dashboard.userProfile.attributes.country)

                if (account.geoLocale === 'auto') {
                    if (profileCountry) {
                        saveResolvedRegion(this.config.sessionPath, accountEmail, profileCountry)
                    } else {
                        this.logger.warn(
                            'main',
                            'GEO-LOCALE',
                            `Microsoft profile returned an invalid country; retaining ${
                                this.accountLocale.country ?? 'US fallback'
                            }`
                        )
                    }
                }

                this.accountLocale = resolveAccountLocale(account, profileCountry ?? this.accountLocale.country)
                this.userData.langCode = this.accountLocale.language
                this.userData.geoLocale = this.accountLocale.country ?? 'US'
                this.http.setDefaultHeaders({
                    'Accept-Language': this.accountLocale.acceptLanguage
                })

                let appData: AppDashboardData | null = null

                if (this.accessToken && needsAppState) {
                    try {
                        appData = await this.browser.func.getAppDashboardData()
                    } catch (error) {
                        this.logger.warn(
                            'main',
                            'LOGIN-APP',
                            `App dashboard unavailable - app activities will be skipped this run | message=${error instanceof Error ? error.message : String(error)}`
                        )
                        this.accessToken = ''
                    }
                }

                if (mobileMode) {
                    const appDailySetDate = appData ? resolveAppDailySetDate(appData) : null
                    const preflightDate = process.env.REWARDS_DAILY_SET_DATE
                    this.dailySetDate = preflightDate && preflightDate !== appDailySetDate ? null : appDailySetDate
                }
                if (this.dailySetDate) {
                    this.logger.info(
                        'main',
                        'DAILY-SET-CYCLE',
                        `${mobileMode ? 'SAAndroid' : 'Rewards Web'} Daily Set cycle resolved | date=${this.dailySetDate}`,
                        'green'
                    )
                } else {
                    this.logger.warn(
                        'main',
                        'DAILY-SET-CYCLE',
                        `${mobileMode ? 'SAAndroid market time' : 'Official Dashboard'} Daily Set cycle unavailable; Daily Set will be skipped for safety`
                    )
                }

                const sourceBalance =
                    mobileMode && appData
                        ? Number(appData.response.balance ?? 0)
                        : data.dashboard.userStatus.availablePoints
                this.userData.initialPoints = sourceBalance
                this.userData.currentPoints = sourceBalance
                const initialPoints = this.userData.initialPoints ?? 0

                if (loginMode) {
                    await executionContext.run({ isMobile: false, account }, async () => {
                        desktopSession = await this.createDesktopSession(account)
                    })
                    await closeDesktopSession()
                    this.logger.info(
                        'main',
                        'LOGIN-READY',
                        `PC Web and SAAndroid authorization verified | account=${accountEmail}`,
                        'green'
                    )
                    return { initialPoints, collectedPoints: 0 }
                }

                const counters = data.dashboard.userStatus.counters
                const pcEarned = (counters.pcSearch || []).reduce((acc: number, c) => acc + (c.pointProgress || 0), 0)
                const pcMax = (counters.pcSearch || []).reduce((acc: number, c) => acc + (c.pointProgressMax || 0), 0)
                const mbEarned = (counters.mobileSearch || []).reduce(
                    (acc: number, c) => acc + (c.pointProgress || 0),
                    0
                )
                const mbMax = (counters.mobileSearch || []).reduce(
                    (acc: number, c) => acc + (c.pointProgressMax || 0),
                    0
                )
                const offersEarned = (counters.activityAndQuiz || []).reduce(
                    (acc: number, c) => acc + (c.pointProgress || 0),
                    0
                )
                const officialDailyPoint = (counters.dailyPoint || []).reduce(
                    (acc: number, c) => acc + (c.pointProgress || 0),
                    0
                )
                const totalTodayOfficial =
                    officialDailyPoint > 0 ? officialDailyPoint : pcEarned + mbEarned + offersEarned

                const lifetimePoints = data.dashboard.userStatus.lifetimePoints || 0
                const availablePoints = data.dashboard.userStatus.availablePoints || 0

                const todayStr = this.dailySetDate
                const dailySetItems = todayStr ? (dailySetMap[todayStr] ?? []) : []
                const dsEarned = dailySetItems.reduce(
                    (acc: number, item) => acc + (item.complete ? item.pointProgressMax : item.pointProgress || 0),
                    0
                )
                const dsMax = dailySetItems.reduce((acc: number, item) => acc + (item.pointProgressMax || 0), 0)

                const promoItems = [
                    ...(data.dashboard.morePromotions ?? []),
                    ...(data.dashboard.morePromotionsWithoutPromotionalItems ?? [])
                ]
                const uniquePromos = selectPcKeepEarningPromotions(promoItems, dailySetItems,
                    await this.browser.func.getKeepEarningOfferIds())
                const promoEarned = uniquePromos.reduce(
                    (acc: number, item) => acc + (item.complete ? item.pointProgressMax : item.pointProgress || 0),
                    0
                )
                const promoMax = uniquePromos.reduce((acc: number, item) => acc + (item.pointProgressMax || 0), 0)
                const terminalDailyEarned = pcEarned + dsEarned + promoEarned
                const terminalDailyMax = pcMax + dsMax + promoMax
                const officialDailyMax = totalTodayOfficial + Math.max(0, terminalDailyMax - terminalDailyEarned)

                const totalDailyTasksEarned = pcEarned + mbEarned + dsEarned + promoEarned + 35
                const estimatedShopPoints = Math.max(0, availablePoints - totalDailyTasksEarned)

                const levelInfo = data.dashboard.userStatus.levelInfo
                const levelName =
                    levelInfo?.activeLevelName ||
                    (levelInfo?.activeLevel
                        ? String(levelInfo.activeLevel).includes('2')
                            ? 'Level 2'
                            : 'Level 1'
                        : 'Level 1')
                const levelProgress = levelInfo?.progress || 0
                const levelProgressMax = levelInfo?.progressMax || 500

                if (!mobileMode) {
                    this.logger.info(
                        false,
                        'POINTS-BREAKDOWN',
                        JSON.stringify({
                            date: todayStr,
                            account: accountEmail,
                            available: availablePoints,
                            lifetime: lifetimePoints,
                            dailyEarned: totalTodayOfficial,
                            dailyMax: officialDailyMax,
                            officialAccountTodayEarned: totalTodayOfficial,
                            pcDailyEarned: terminalDailyEarned,
                            pcDailyMax: terminalDailyMax,
                            offers: offersEarned,
                            pcSearch: `${pcEarned}/${pcMax}`,
                            mobileSearch: `${mbEarned}/${mbMax}`,
                            dailySet: `${dsEarned}/${dsMax}`,
                            promotions: `${promoEarned}/${promoMax}`,
                            shopPoints: estimatedShopPoints,
                            level: levelName,
                            levelProgress: `${levelProgress}/${levelProgressMax}`
                        })
                    )
                }

                const pendingDailySet = dailySetItems.filter(
                    item =>
                        !item.complete &&
                        ((item.pointProgressMax || 0) > (item.pointProgress || 0) || !item.pointProgressMax)
                )
                const pendingPromos = uniquePromos.filter(
                    item =>
                        !item.complete &&
                        ((item.pointProgressMax || 0) > (item.pointProgress || 0) || !item.pointProgressMax)
                )

                const parseIconUrl = (item: BasePromotion) => {
                    const attributes = (item.attributes ?? {}) as Record<string, string | undefined>
                    const raw =
                        attributes.image ||
                        attributes.icon ||
                        attributes.small_image ||
                        attributes.modern_image ||
                        item.imageUrl ||
                        item.smallImageUrl ||
                        item.iconUrl ||
                        attributes.bg_image ||
                        ''
                    if (!raw || typeof raw !== 'string') return ''
                    if (raw.startsWith('//')) return 'https:' + raw
                    if (raw.startsWith('/')) return 'https://www.bing.com' + raw
                    return raw
                }

                const dailySetCards = dailySetItems.map(item => ({
                    offerId: item.offerId,
                    title: item.title || item.name || '日常任务',
                    description: item.description || '',
                    points: Math.max(0, Number(item.pointProgressMax) || 0),
                    progress: Math.max(0, Number(item.pointProgress) || 0),
                    complete: Boolean(
                        item.complete || (item.pointProgressMax && item.pointProgress >= item.pointProgressMax)
                    ),
                    iconUrl: parseIconUrl(item),
                    destinationUrl: item.destinationUrl || ''
                }))

                const promoCards = uniquePromos.map(item => ({
                    offerId: item.offerId,
                    title: item.title || item.name || '活动推广',
                    description: item.description || '',
                    points: Math.max(0, Number(item.pointProgressMax) || 0),
                    progress: Math.max(0, Number(item.pointProgress) || 0),
                    complete: Boolean(
                        item.complete || (item.pointProgressMax && item.pointProgress >= item.pointProgressMax)
                    ),
                    iconUrl: parseIconUrl(item),
                    destinationUrl: item.destinationUrl || ''
                }))

                if (!mobileMode) {
                    this.logger.info(
                        false,
                        'TASK-DISCOVERY',
                        JSON.stringify({
                            dailySetTotal: dailySetItems.length,
                            dailySetPending: pendingDailySet.length,
                            promoTotal: uniquePromos.length,
                            promoPending: pendingPromos.length,
                            dailySetCards,
                            promoCards
                        })
                    )
                }

                const browserEarnable = await this.browser.func.getBrowserEarnablePoints(data)
                this.browserEarnable = browserEarnable
                let appEarnable: AppEarnablePoints | null = null

                if (this.accessToken && needsAppActivities) {
                    try {
                        appEarnable = await this.browser.func.getAppEarnablePoints()
                    } catch (error) {
                        this.logger.warn(
                            'main',
                            'LOGIN-APP',
                            `App earnable-points lookup failed - app activities will be skipped this run | message=${error instanceof Error ? error.message : String(error)}`
                        )
                        this.accessToken = ''
                        appData = null
                    }
                }

                const appAvailable = Boolean(this.accessToken && appData)

                this.logger.info(
                    'main',
                    'POINTS',
                    `Earnable today | Mobile: ${browserEarnable.mobileSearchPoints} | Browser: ${
                        browserEarnable.desktopSearchPoints
                    } | App: ${appEarnable?.totalEarnablePoints ?? 0} | ${accountEmail} | locale: ${this.accountLocale.locale}`
                )

                const parallel = this.config.searchSettings.parallelSearching
                const doBonus = allowMobileTasks && this.config.workers.doBonusSearches
                const doVisualSearch = allowDesktopTasks && this.config.workers.doVisualSearch

                let mobilePoints = 0
                let desktopPoints = 0
                let bonusPoints = 0

                if (allowDesktopTasks && this.config.experimental.edgeBrowsing) {
                    edgeBrowsingTask = executionContext
                        .run({ isMobile: false, account }, async () =>
                            this.activities.doEdgeBrowsing(data, edgeBrowsingController.signal)
                        )
                        .catch(error => {
                            this.logger.error(
                                false,
                                'EDGE-BROWSING',
                                `Unexpected background task failure | message=${
                                    error instanceof Error ? error.message : String(error)
                                }`
                            )
                        })
                        .finally(() => {
                            edgeBrowsingFinished = true
                        })
                }

                if (fullApi) {
                    if (allowDesktopTasks && this.config.ensureStreakProtection) {
                        await runDesktopActivity('STREAK-PROTECTION', () => this.activities.doEnsureStreakProtection())
                    }
                    if (allowDesktopTasks && this.config.workers.doActivateSearchPerk)
                        await runDesktopActivity('ACTIVATE-SEARCH-PERK', () =>
                            this.activities.doActivateSearchPerk(data)
                        )

                    const plan = desktopMode
                        ? await runDesktopTask(() => this.searchManager.getSearchPoints(appData ?? undefined))
                        : await this.searchManager.getSearchPoints(appData ?? undefined)
                    const doMobileSearch = allowMobileTasks && plan.doMobile
                    const doDesktopSearch = allowDesktopTasks && plan.doDesktop
                    const desktopBrowserNeeded =
                        (allowDesktopTasks && this.config.workers.doPunchCards) || doVisualSearch

                    if (doDesktopSearch && !desktopBrowserNeeded) {
                        this.cookies.desktop = [...this.cookies.mobile]
                        this.fingerprintDesktop = await this.browserFactory.generateFingerprint(false)
                    }

                    if (desktopBrowserNeeded) {
                        await executionContext.run({ isMobile: false, account }, async () => {
                            await ensureDesktopSession()
                            if (allowDesktopTasks && this.config.workers.doPunchCards)
                                await runIsolatedActivity(false, 'PUNCH-CARDS', () =>
                                    this.activities.doPunchCardsDesktop()
                                )
                            if (doVisualSearch)
                                await runIsolatedActivity(false, 'VISUAL-SEARCH', async () => {
                                    await this.activities.doVisualSearch(data)
                                })
                        })
                    }

                    if (this.config.workers.doDailySet) {
                        if (mobileMode) {
                            if (appData)
                                await runMobileActivity('MOBILE-DAILY-SET', () =>
                                    this.activities.doMobileDailySet(appData)
                                )
                            else
                                this.logger.warn(
                                    true,
                                    'MOBILE-DAILY-SET',
                                    '[PLAN] dailySet skip_state_unavailable source=SAAndroid'
                                )
                        } else if (allowDesktopTasks) {
                            await runDesktopActivity('DAILY-SET', () => this.activities.doDailySet(data))
                        }
                    } else if (botChallengePolicy?.hasBotWarning) {
                        this.logger.warn(
                            'main',
                            'DAILY-SET',
                            `[PLAN] dailySet skip_risk_guard: Microsoft reported ${BOT_WARNING_KEY}, skipped automatically to protect account.`
                        )
                    }
                    if (allowDesktopTasks && this.config.workers.doMorePromotions)
                        await runDesktopActivity('MORE-PROMOTIONS', () => this.activities.doMorePromotions(data))
                    if (allowMobileTasks && appAvailable && this.config.workers.doDailyCheckIn)
                        await runMobileActivity('DAILY-CHECK-IN', () => this.activities.doDailyCheckIn())
                    if (allowMobileTasks && appAvailable && this.config.workers.doAppPromotions && appData)
                        await runMobileActivity('APP-PROMOTIONS', () => this.activities.doAppPromotions(appData))
                    if (allowMobileTasks && appAvailable && this.config.workers.doReadToEarn)
                        await runMobileActivity('READ-TO-EARN', () => this.activities.doReadToEarn())

                    if (doMobileSearch) mobilePoints = await this.searchManager.searchMobile(account)
                    if (doBonus) bonusPoints = await this.searchManager.bonusMobile(account)
                    if (doDesktopSearch) desktopPoints = await this.searchManager.searchDesktop(account)
                } else {
                    if (allowDesktopTasks && this.config.ensureStreakProtection) {
                        await runDesktopActivity('STREAK-PROTECTION', () => this.activities.doEnsureStreakProtection())
                    }
                    if (this.config.workers.doDailySet) {
                        if (mobileMode) {
                            if (appData)
                                await runMobileActivity('MOBILE-DAILY-SET', () =>
                                    this.activities.doMobileDailySet(appData)
                                )
                            else
                                this.logger.warn(
                                    true,
                                    'MOBILE-DAILY-SET',
                                    '[PLAN] dailySet skip_state_unavailable source=SAAndroid'
                                )
                        } else if (allowDesktopTasks) {
                            await runDesktopActivity('DAILY-SET', () => this.activities.doDailySet(data))
                        }
                    } else if (botChallengePolicy?.hasBotWarning) {
                        this.logger.warn(
                            'main',
                            'DAILY-SET',
                            `[PLAN] dailySet skip_risk_guard: Microsoft reported ${BOT_WARNING_KEY}, skipped automatically to protect account.`
                        )
                    }
                    if (allowDesktopTasks && this.config.workers.doActivateSearchPerk)
                        await runDesktopActivity('ACTIVATE-SEARCH-PERK', () =>
                            this.activities.doActivateSearchPerk(data)
                        )
                    if (allowDesktopTasks && this.config.workers.doMorePromotions)
                        await runDesktopActivity('MORE-PROMOTIONS', () => this.activities.doMorePromotions(data))
                    if (allowMobileTasks && appAvailable && this.config.workers.doDailyCheckIn)
                        await runMobileActivity('DAILY-CHECK-IN', () => this.activities.doDailyCheckIn())
                    if (allowMobileTasks && appAvailable && this.config.workers.doAppPromotions && appData)
                        await runMobileActivity('APP-PROMOTIONS', () => this.activities.doAppPromotions(appData))
                    if (allowMobileTasks && appAvailable && this.config.workers.doReadToEarn)
                        await runMobileActivity('READ-TO-EARN', () => this.activities.doReadToEarn())
                    const plan = desktopMode
                        ? await runDesktopTask(() => this.searchManager.getSearchPoints(appData ?? undefined))
                        : await this.searchManager.getSearchPoints(appData ?? undefined)
                    const doMobileSearch = allowMobileTasks && plan.doMobile
                    const doDesktopSearch = allowDesktopTasks && plan.doDesktop

                    const hasPendingPunchCards =
                        Array.isArray(data.dashboard.punchCards) &&
                        data.dashboard.punchCards.some(
                            p => !p.parentPromotion?.complete && (p.parentPromotion?.pointProgressMax || 0) > 0
                        )

                    const desktopBrowserNeeded =
                        (allowDesktopTasks && this.config.workers.doPunchCards && hasPendingPunchCards) ||
                        doVisualSearch ||
                        (doDesktopSearch && !apiSearch)

                    if (apiSearch && doDesktopSearch && !desktopBrowserNeeded) {
                        this.cookies.desktop = sanitizeCookies(this.cookies.mobile, false)
                        this.fingerprintDesktop = await this.browserFactory.generateFingerprint(false)
                    }

                    if (parallel && !apiSearch && doMobileSearch && doDesktopSearch) {
                        await executionContext.run({ isMobile: false, account }, async () => {
                            await ensureDesktopSession()
                            if (allowDesktopTasks && this.config.workers.doPunchCards)
                                await runIsolatedActivity(false, 'PUNCH-CARDS', () =>
                                    this.activities.doPunchCardsDesktop()
                                )
                            if (doVisualSearch)
                                await runIsolatedActivity(false, 'VISUAL-SEARCH', async () => {
                                    await this.activities.doVisualSearch(data)
                                })
                        })

                        const mobileWork = async (): Promise<[number, number]> => {
                            try {
                                const searchPoints = await this.searchManager.searchMobile(account)
                                const extraPoints = doBonus ? await this.searchManager.bonusMobile(account) : 0
                                return [searchPoints, extraPoints]
                            } finally {
                                await closeMobileSession()
                            }
                        }
                        const desktopWork = async (): Promise<number> => {
                            return this.searchManager.searchDesktop(account)
                        }

                        ;[[mobilePoints, bonusPoints], desktopPoints] = await Promise.all([mobileWork(), desktopWork()])
                    } else {
                        if (apiSearch) await closeMobileSession()

                        if (doMobileSearch) mobilePoints = await this.searchManager.searchMobile(account)
                        if (doBonus) bonusPoints = await this.searchManager.bonusMobile(account)

                        if (!apiSearch) await closeMobileSession()

                        if (desktopBrowserNeeded) {
                            await executionContext.run({ isMobile: false, account }, async () => {
                                await ensureDesktopSession()

                                if (allowDesktopTasks && this.config.workers.doPunchCards)
                                    await runIsolatedActivity(false, 'PUNCH-CARDS', () =>
                                        this.activities.doPunchCardsDesktop()
                                    )
                                if (doVisualSearch)
                                    await runIsolatedActivity(false, 'VISUAL-SEARCH', async () => {
                                        await this.activities.doVisualSearch(data)
                                    })
                                if (doDesktopSearch && !apiSearch) {
                                    desktopPoints = await this.searchManager.searchDesktop(account)
                                }
                            })
                        }

                        if (doDesktopSearch && apiSearch) {
                            desktopPoints = await this.searchManager.searchDesktop(account)
                        }
                    }
                }

                this.logger.info(
                    'main',
                    'SEARCH-MANAGER',
                    `Search summary | mobile=${mobilePoints} | desktop=${desktopPoints} | bonus=${bonusPoints} | total=${
                        mobilePoints + desktopPoints + bonusPoints
                    }`
                )

                if (allowDesktopTasks && this.config.workers.doClaimBonusPoints)
                    await runDesktopActivity('CLAIM-BONUS-POINTS', () => this.activities.doClaimBonusPoints())

                if (edgeBrowsingTask) {
                    if (!edgeBrowsingFinished) {
                        this.logger.info(
                            false,
                            'EDGE-BROWSING',
                            'Foreground activities finished; waiting for the background Edge browsing activity'
                        )
                    }
                    await edgeBrowsingTask
                    edgeBrowsingTask = null
                }

                const finalPoints = mobileMode
                    ? Number(
                          (await this.browser.func.getAppDashboardData()).response.balance ??
                              this.userData.currentPoints
                      )
                    : await runDesktopTask(() => this.browser.func.getCurrentPoints())
                const collectedPoints = finalPoints - initialPoints

                this.logger.info(
                    'main',
                    'FLOW',
                    `Points collected | pointsGained=${collectedPoints} | currentBalance=${finalPoints} | account=${accountEmail}`
                )

                if (!mobileMode) {
                    this.logger.info(
                        false,
                        'POINTS-BREAKDOWN',
                        JSON.stringify({
                            date: todayStr,
                            account: accountEmail,
                            available: finalPoints,
                            lifetime: lifetimePoints,
                            dailyEarned: totalTodayOfficial + Math.max(0, collectedPoints),
                            dailyMax: officialDailyMax,
                            officialAccountTodayEarned: totalTodayOfficial + Math.max(0, collectedPoints),
                            pcDailyEarned: Math.min(
                                terminalDailyMax,
                                terminalDailyEarned + Math.max(0, collectedPoints)
                            ),
                            pcDailyMax: terminalDailyMax,
                            pointsGained: collectedPoints,
                            pointsSchemaVersion: 2
                        })
                    )
                }

                return {
                    initialPoints,
                    collectedPoints: collectedPoints || 0
                }
            })
        } finally {
            this.config.workers = originalWorkers
            if (edgeBrowsingTask) {
                edgeBrowsingController.abort()
                await edgeBrowsingTask
                edgeBrowsingTask = null
            }

            if (mobileSession) {
                try {
                    await closeMobileSession()
                } catch (error) {
                    this.logger.debug(
                        'main',
                        'CLEANUP',
                        `Mobile context close failed | ${error instanceof Error ? error.message : String(error)}`
                    )
                }
            }

            if (desktopSession) {
                try {
                    await closeDesktopSession()
                } catch (error) {
                    this.logger.debug(
                        'main',
                        'CLEANUP',
                        `Desktop context close failed | ${error instanceof Error ? error.message : String(error)}`
                    )
                }
            }
        }
    }
}

export { executionContext }

async function main(): Promise<void> {
    checkNodeVersion()
    const rewardsBot = new MicrosoftRewardsBot()

    process.on('beforeExit', () => {
        void flushAllWebhooks()
    })
    process.on('SIGINT', async () => {
        rewardsBot.logger.warn('main', 'PROCESS', 'SIGINT received, flushing and exiting...')
        await flushAllWebhooks()
        process.exit(130)
    })
    process.on('SIGTERM', async () => {
        rewardsBot.logger.warn('main', 'PROCESS', 'SIGTERM received, flushing and exiting...')
        await flushAllWebhooks()
        process.exit(143)
    })
    process.on('uncaughtException', async error => {
        if (isBrowserClosedError(error)) {
            rewardsBot.logger.debug(
                'main',
                'UNCAUGHT-EXCEPTION',
                `Ignoring benign browser-closed error during teardown | ${error instanceof Error ? error.message : String(error)}`
            )
            return
        }
        rewardsBot.logger.error('main', 'UNCAUGHT-EXCEPTION', error)
        await flushAllWebhooks()
        process.exit(1)
    })
    process.on('unhandledRejection', async reason => {
        if (isBrowserClosedError(reason)) {
            rewardsBot.logger.debug(
                'main',
                'UNHANDLED-REJECTION',
                `Ignoring benign browser-closed rejection during teardown | ${reason instanceof Error ? reason.message : String(reason)}`
            )
            return
        }
        rewardsBot.logger.error('main', 'UNHANDLED-REJECTION', reason as Error)
        await flushAllWebhooks()
        process.exit(1)
    })

    try {
        await rewardsBot.initialize()
        await rewardsBot.run()
    } catch (error) {
        rewardsBot.logger.error('main', 'MAIN-ERROR', error as Error)
        await flushAllWebhooks()
        process.exitCode = 1
    }
}

main().catch(async error => {
    const tmpBot = new MicrosoftRewardsBot()
    tmpBot.logger.error('main', 'MAIN-ERROR', error as Error)
    await flushAllWebhooks()
    process.exit(1)
})
