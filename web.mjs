import http from 'node:http'
import https from 'node:https'
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import { createDailySetProbeState } from './scripts/api/dailySetProbeState.mjs'
import { createRuntimeReplay } from './scripts/api/runtimeReplay.mjs'
import { sessionCookieHeader } from './scripts/api/sessionCookieHeader.mjs'
import { sanitizeAllDirtyCookies } from './scripts/api/sessionSanitizer.mjs'
import { clearAccountSessionStorage, clearAccountLoginFiles } from './scripts/api/sessionLogout.mjs'
import { createLiveRunSync, shouldRefreshRun } from './scripts/api/liveRunSync.mjs'
import { BOT_WARNING_KEY, evaluateBotChallengePolicy, formatHitlWebhookPayload } from './scripts/api/hitlBotChallenge.mjs'

import {
    earnKeepEarningIds,
    appProgressFields,
    isCurrentAppDailySetCandidate,
    isExploreOnBingPromotion as isExploreOnBingTask,
    isAppInteractivePromotion as isAppInteractiveTask,
    isTomorrowLockedPromotion as isTomorrowLockedTask,
    isInteractiveDailySetDestination,
    isManualKeepEarningPromotion as isManualKeepEarningTask,
    getExploreOnBingStatus,
    selectPcKeepEarningPromotions
} from './promotion-classification.mjs'
import {
    initProfileSchema,
    listProfiles,
    getActiveProfile,
    setActiveProfile,
    saveProfile,
    deleteProfile,
    getDecryptedAiConfig,
    testAiConnection,
    fetchAiModels
} from './scripts/api/profileManager.mjs'
import { AI_PROVIDERS, getCategorizedProviders } from './scripts/api/aiProviders.mjs'
import { maskSecret } from './scripts/api/profileCrypto.mjs'
import crypto from 'node:crypto'
import {
    verifyAiUrlTargetBinding,
    validateAndNormalizeAiUrl,
    sanitizeErrorKey
} from './scripts/api/aiUrlSecurity.mjs'
import {
    createAuthorizedClient,
    validateClientCredential,
    revokeClient,
    revokeAllClients,
    generateDeviceCsrfToken,
    verifyDeviceCsrfToken,
    buildDeviceCookieHeader,
    buildClearDeviceCookieHeader,
    initClientAuthSchema,
    DEVICE_COOKIE_NAME,
    DEFAULT_DEVICE_COOKIE_MAX_AGE
} from './scripts/api/webClientAuth.mjs'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const PORT = process.env.PORT || 3888
const HOST = process.env.HOST || '127.0.0.1'

export function getSessionDir() {
    if (process.env.MS_SESSION_DIR && process.env.MS_SESSION_DIR.trim()) {
        return path.resolve(process.env.MS_SESSION_DIR.trim())
    }
    if (process.env.MS_SESSION_DB_PATH && process.env.MS_SESSION_DB_PATH.trim()) {
        return path.resolve(path.dirname(process.env.MS_SESSION_DB_PATH.trim()))
    }
    return path.join(__dirname, 'sessions')
}

export function getSessionDbPath() {
    if (process.env.MS_SESSION_DB_PATH && process.env.MS_SESSION_DB_PATH.trim()) {
        return path.resolve(process.env.MS_SESSION_DB_PATH.trim())
    }
    return path.join(getSessionDir(), 'sessions.db')
}

const stateFilePath = path.join(getSessionDir(), 'daily_state.json')
const mobileStateFilePath = path.join(getSessionDir(), 'mobile_state.json')
const publicDir = path.join(__dirname, 'public')

// 本地安全会话令牌与 CSRF 令牌（高熵随机生成，不硬编码在代码或长期配置文件中）
let localSessionToken = process.env.MS_LOCAL_SESSION_TOKEN || crypto.randomBytes(32).toString('hex')
let localCsrfToken = process.env.MS_LOCAL_CSRF_TOKEN || crypto.randomBytes(32).toString('hex')

export function getLocalSecurityTokens() {
    return { sessionToken: localSessionToken, csrfToken: localCsrfToken }
}

export function setLocalSecurityTokens({ sessionToken, csrfToken }) {
    if (sessionToken) localSessionToken = sessionToken
    if (csrfToken) localCsrfToken = csrfToken
}

// ==========================================
// 配对凭证管理、弱密码拦截与失败限速
// ==========================================
const COMMON_WEAK_PASSWORDS = new Set([
    '12345678', '123456789', '123456789012345', 'password', 'password123456',
    'admin123', 'root1234', '11111111', '111111111111111', 'qwertyui',
    'default1', 'administrator', 'administrator1', 'pass1234'
])

export function validatePairingSecretStrength(secret) {
    if (!secret || typeof secret !== 'string') {
        return { valid: false, reason: '配对密码不能为空' }
    }
    const trimmed = secret.trim()
    if (trimmed.length < 15) {
        return { valid: false, reason: '手动设置的配对密码长度至少需要 15 个字符' }
    }
    if (COMMON_WEAK_PASSWORDS.has(trimmed.toLowerCase())) {
        return { valid: false, reason: '手动设置的配对密码过于简单，属于常见弱密码' }
    }
    if (/^(.)\1+$/.test(trimmed)) {
        return { valid: false, reason: '手动设置的配对密码不能为单一字符完全重复' }
    }
    return { valid: true }
}

let pairingSecretInitError = null

export function getPairingInitError() {
    return pairingSecretInitError
}
let localPairingSecret = null

export function initPairingSecret() {
    pairingSecretInitError = null
    if (process.env.MS_WEB_PAIRING_SECRET && process.env.MS_WEB_PAIRING_SECRET.trim()) {
        const rawSecret = process.env.MS_WEB_PAIRING_SECRET.trim()
        const check = validatePairingSecretStrength(rawSecret)
        if (!check.valid) {
            pairingSecretInitError = `MS_WEB_PAIRING_SECRET 配置不合规：${check.reason}。请设置强密码（至少 15 字符），或移除该变量以使用自动生成的高熵配对码。`
            localPairingSecret = null
            return null
        }
        localPairingSecret = rawSecret
        return rawSecret
    }
    const pairingFilePath = path.join(getSessionDir(), '.web_pairing_secret')
    try {
        const sessionsDir = path.dirname(pairingFilePath)
        if (!fs.existsSync(sessionsDir)) {
            fs.mkdirSync(sessionsDir, { recursive: true, mode: 0o700 })
        }
        if (fs.existsSync(pairingFilePath)) {
            const rawContent = fs.readFileSync(pairingFilePath, 'utf-8')
            const secret = rawContent.trim()
            // 文件已存在：必须为有效高熵凭据 (至少16字符)
            if (secret && secret.length >= 16) {
                if (!rawContent.endsWith('\n')) {
                    try {
                        fs.writeFileSync(pairingFilePath, secret + '\n', { mode: 0o600 })
                    } catch (_) {}
                }
                localPairingSecret = secret
                return secret
            }
            // 文件存在但为空或格式异常：严禁生成新码覆盖原文件！必须 fail closed 并保留原文件
            pairingSecretInitError = '配对凭据文件 (.web_pairing_secret) 为空或格式异常，已拒绝启动以防覆盖原凭据。请核实文件内容或由管理员手动修复。'
            localPairingSecret = null
            return null
        }
        const newSecret = crypto.randomBytes(24).toString('hex')
        fs.writeFileSync(pairingFilePath, newSecret + '\n', { mode: 0o600, flag: 'wx' })
        try { fs.chmodSync(pairingFilePath, 0o600) } catch (_) {}
        localPairingSecret = newSecret
        return newSecret
    } catch (err) {
        if (err?.code === 'EEXIST') {
            try {
                const secret = fs.readFileSync(pairingFilePath, 'utf-8').trim()
                if (secret && secret.length >= 16) {
                    localPairingSecret = secret
                    return secret
                }
            } catch (_) {}
        }
        // fail closed: 绝不静默返回未落盘的内存随机码，避免出现宿主机看不到码或每次重启更换伪码
        pairingSecretInitError = '无法读取或持久化配对凭证文件，请检查 sessions 目录读写权限'
        localPairingSecret = null
        return null
    }
}

localPairingSecret = initPairingSecret()

export function getLocalPairingSecret() {
    if (process.env.MS_WEB_PAIRING_SECRET && process.env.MS_WEB_PAIRING_SECRET.trim()) {
        const rawSecret = process.env.MS_WEB_PAIRING_SECRET.trim()
        const check = validatePairingSecretStrength(rawSecret)
        if (!check.valid) {
            pairingSecretInitError = `MS_WEB_PAIRING_SECRET 配置不合规：${check.reason}。请设置强密码（至少 15 字符），或移除该变量以使用自动生成的高熵配对码。`
            return null
        }
        pairingSecretInitError = null
        return rawSecret
    }
    return localPairingSecret
}

export function setLocalPairingSecret(secret) {
    if (secret) {
        localPairingSecret = String(secret).trim()
        pairingSecretInitError = null
    } else {
        localPairingSecret = null
    }
}

// /api/pair 失败尝试频率限制 (基于客户端真实 IP，防暴力破解)
const pairFailureTracker = new Map()
const PAIR_MAX_FAILURES = 5
const PAIR_WINDOW_MS = 60 * 1000
const PAIR_LOCK_MS = 60 * 1000

export function normalizeIp(ip) {
    if (!ip || typeof ip !== 'string') return '127.0.0.1'
    let cleaned = ip.trim()
    if (cleaned.startsWith('::ffff:')) {
        cleaned = cleaned.substring(7)
    }
    return cleaned
}

const trustedProxySet = new Set()

export function reloadTrustedProxies(envProxies = process.env.TRUSTED_PROXIES) {
    trustedProxySet.clear()
    if (envProxies && typeof envProxies === 'string') {
        envProxies.split(',').map(s => s.trim()).filter(Boolean).forEach(ip => {
            trustedProxySet.add(normalizeIp(ip))
        })
    }
}
reloadTrustedProxies()

export function isProxyTrusted(socketAddress) {
    if (!socketAddress || trustedProxySet.size === 0) return false
    return trustedProxySet.has(normalizeIp(socketAddress))
}

export function getClientIp(req) {
    const remoteAddr = req.socket?.remoteAddress || '127.0.0.1'
    // 严格安全防御：仅当底层 socket 连接来自明确配置的 TRUSTED_PROXIES 时，才信任 X-Forwarded-For 头；
    // 否则直接使用底层真实 socket 地址，严防攻击者伪造请求头绕过防爆破限速
    if (isProxyTrusted(remoteAddr)) {
        const forwarded = req.headers['x-forwarded-for']
        if (forwarded && typeof forwarded === 'string') {
            const first = forwarded.split(',')[0].trim()
            if (first) return normalizeIp(first)
        }
    }
    return normalizeIp(remoteAddr)
}

export function checkPairRateLimit(ip) {
    const now = Date.now()
    const entry = pairFailureTracker.get(ip)
    if (!entry) return { allowed: true }
    if (entry.lockedUntil && now < entry.lockedUntil) {
        const remainingSeconds = Math.ceil((entry.lockedUntil - now) / 1000)
        return { allowed: false, remainingSeconds }
    }
    if (now >= entry.resetAt) {
        pairFailureTracker.delete(ip)
        return { allowed: true }
    }
    return { allowed: true }
}

export function recordPairFailure(ip) {
    const now = Date.now()
    let entry = pairFailureTracker.get(ip)
    if (!entry || now >= entry.resetAt) {
        entry = { count: 1, resetAt: now + PAIR_WINDOW_MS, lockedUntil: 0 }
    } else {
        entry.count += 1
        if (entry.count >= PAIR_MAX_FAILURES) {
            entry.lockedUntil = now + PAIR_LOCK_MS
        }
    }
    pairFailureTracker.set(ip, entry)
    if (pairFailureTracker.size > 1000) {
        for (const [k, v] of pairFailureTracker.entries()) {
            if (now >= v.resetAt && now >= v.lockedUntil) {
                pairFailureTracker.delete(k)
            }
        }
    }
    return entry
}

export function resetPairFailure(ip) {
    pairFailureTracker.delete(ip)
}

export function clearAllPairFailures() {
    pairFailureTracker.clear()
}

export function isRequestHttps(req) {
    if (req.socket?.encrypted) return true
    const remoteAddr = req.socket?.remoteAddress
    // 严格安全防御：仅当底层 socket 连接来自明确配置的 TRUSTED_PROXIES 时，才信任 X-Forwarded-Proto 头；
    // 否则直接判定为非 HTTPS，严防客户端伪造请求头造成协议混淆、降级或错误注入 Secure Cookie
    if (remoteAddr && isProxyTrusted(remoteAddr)) {
        const proto = req.headers['x-forwarded-proto']
        if (proto && typeof proto === 'string') {
            return proto.split(',')[0].trim().toLowerCase() === 'https'
        }
    }
    return false
}

/**
 * 集中校验请求身份认证状态 (支持长期设备凭证、会话Cookie与本地请求头)
 * @param {import('node:http').IncomingMessage} req
 * @returns {{ authenticated: boolean, type?: 'device'|'session'|'header', deviceId?: string, deviceSecret?: string, authEpoch?: string }}
 */
export function checkRequestAuthentication(req, res = null) {
    const cookies = parseCookies(req)
    const isHttps = isRequestHttps(req)

    // 1. 优先校验已配对浏览器长期设备凭证 (ms_device_token)
    const deviceToken = cookies[DEVICE_COOKIE_NAME]
    if (deviceToken) {
        try {
            const db = getDatabase(false)
            try {
                const validation = validateClientCredential(db, deviceToken)
                if (validation.valid) {
                    // 阻断点 3 修复：服务端滑动续期时，若提供 res 且未发送头，向客户端同步下发续期 Set-Cookie 头，确保浏览器 Max-Age 满格
                    let renewalCookie = null
                    if (validation.renewed) {
                        renewalCookie = buildDeviceCookieHeader(deviceToken, { isHttps })
                        if (res && typeof res.setHeader === 'function' && !res.headersSent) {
                            try {
                                const existing = res.getHeader('Set-Cookie')
                                if (!existing) {
                                    res.setHeader('Set-Cookie', renewalCookie)
                                } else if (Array.isArray(existing)) {
                                    res.setHeader('Set-Cookie', [...existing, renewalCookie])
                                } else {
                                    res.setHeader('Set-Cookie', [existing, renewalCookie])
                                }
                            } catch (_) {}
                        }
                    }
                    return {
                        authenticated: true,
                        type: 'device',
                        deviceId: validation.deviceId,
                        deviceSecret: validation.deviceSecret,
                        authEpoch: validation.authEpoch,
                        renewed: Boolean(validation.renewed),
                        renewalCookie
                    }
                } else {
                    // 阻断点 2 核心修复：一旦携带设备凭据但校验失败（已撤销/已过期/伪造），严禁降级到共享的 ms_local_token，直接坚决拒绝
                    return {
                        authenticated: false,
                        reason: validation.reason || 'invalid_device_token'
                    }
                }
            } finally {
                db.close()
            }
        } catch (_) {
            return { authenticated: false, reason: 'database_error' }
        }
    }

    // 2. 兼容本地直接请求头 (X-Local-Token)，仅用于同机受信任 CLI 工具
    const headerToken = req.headers['x-local-token']
    if (headerToken && headerToken === localSessionToken) {
        return { authenticated: true, type: 'header' }
    }

    return { authenticated: false }
}

/**
 * 集中校验请求 CSRF 令牌有效性 (支持当前进程随机令牌与基于设备密钥/版本派生的持久令牌)
 * @param {import('node:http').IncomingMessage} req
 * @param {{ authenticated: boolean, type?: string, deviceSecret?: string, authEpoch?: string }} auth
 * @returns {boolean}
 */
export function checkRequestCsrf(req, auth) {
    const reqCsrf = req.headers['x-csrf-token']
    if (!reqCsrf || typeof reqCsrf !== 'string') return false
    if (reqCsrf === localCsrfToken) return true
    if (auth?.deviceSecret) {
        // 核心安全解耦：使用独立稳定的设备/服务端版本 (authEpoch) 派生 CSRF 令牌，
        // 彻底解耦 MS_WEB_PAIRING_SECRET。修改配对密码绝不导致已有合法浏览器写请求遭遇 403；
        // 管理员点击“撤销所有设备授权” (轮换 authEpoch) 时所有旧 CSRF 令牌同步失效！
        const csrfSeed = auth.authEpoch || 'device_csrf_seed'
        if (verifyDeviceCsrfToken(auth.deviceSecret, csrfSeed, reqCsrf)) {
            return true
        }
    }
    return false
}


export function parseHostHeader(hostHeader, isHttps = false) {
    if (!hostHeader || typeof hostHeader !== 'string') return null
    const trimmed = hostHeader.trim().toLowerCase()
    if (!trimmed || trimmed.includes('/') || trimmed.includes('\\') || trimmed.includes(' ') || trimmed.includes('\t')) {
        return null
    }
    let hostname = ''
    let port = null
    let portSpecified = false

    if (trimmed.startsWith('[')) {
        const closeIdx = trimmed.indexOf(']')
        if (closeIdx === -1) return null
        hostname = trimmed.substring(0, closeIdx + 1)
        const after = trimmed.substring(closeIdx + 1)
        if (after.startsWith(':')) {
            portSpecified = true
            const portStr = after.substring(1)
            if (!/^\d+$/.test(portStr)) return null
            const p = Number(portStr)
            if (!Number.isInteger(p) || p <= 0 || p > 65535) return null
            port = p
        } else if (after.length > 0) {
            return null
        }
    } else {
        const colonIdx = trimmed.indexOf(':')
        if (colonIdx !== -1) {
            if (trimmed.indexOf(':', colonIdx + 1) !== -1) return null
            hostname = trimmed.substring(0, colonIdx)
            portSpecified = true
            const portStr = trimmed.substring(colonIdx + 1)
            if (!/^\d+$/.test(portStr)) return null
            const p = Number(portStr)
            if (!Number.isInteger(p) || p <= 0 || p > 65535) return null
            port = p
        } else {
            hostname = trimmed
        }
    }

    if (!hostname) return null
    if (!portSpecified) {
        port = isHttps ? 443 : 80
    }
    return { hostname, port }
}

const ALLOWED_HOSTNAMES = new Set(['127.0.0.1', 'localhost', '::1', '[::1]'])

export function reloadAllowedHosts(envAllowedHosts = process.env.ALLOWED_HOSTS) {
    ALLOWED_HOSTNAMES.clear()
    ;['127.0.0.1', 'localhost', '::1', '[::1]'].forEach(h => ALLOWED_HOSTNAMES.add(h))
    if (envAllowedHosts) {
        envAllowedHosts.split(',').map(s => s.trim().toLowerCase()).filter(Boolean).forEach(h => {
            const parsed = parseHostHeader(h)
            if (parsed) {
                ALLOWED_HOSTNAMES.add(parsed.hostname)
            } else {
                ALLOWED_HOSTNAMES.add(h)
            }
        })
    }
}
reloadAllowedHosts()

export function isValidHost(hostHeader, isHttps = false) {
    const parsed = parseHostHeader(hostHeader, isHttps)
    if (!parsed) return false
    return ALLOWED_HOSTNAMES.has(parsed.hostname)
}

export function isValidOrigin(originHeader, expectedPort = null, hostHeader = null, isHttps = false) {
    if (!originHeader) return true
    try {
        const u = new URL(originHeader)
        const originHostname = u.hostname.toLowerCase()

        // 1. 严格协议匹配：Origin 的协议必须与请求实际协议一致 (防 HTTP/HTTPS 协议伪造与混淆)
        const expectedProtocol = isHttps ? 'https:' : 'http:'
        if (u.protocol !== expectedProtocol) return false

        // 2. 检查 Origin 的 hostname 是否属于允许列表
        if (!ALLOWED_HOSTNAMES.has(originHostname)) return false

        const originPort = u.port ? Number(u.port) : (isHttps ? 443 : 80)

        // 3. 若传入 hostHeader (如从真实请求头中传入)
        if (hostHeader && typeof hostHeader === 'string') {
            const parsedHost = parseHostHeader(hostHeader, isHttps)
            // 严格拒绝非法 Host 或端口 (包括非法端口格式或超出 1-65535 范围)
            if (!parsedHost) return false
            // Origin 的 hostname 必须与 Host 请求头的 hostname 一致
            if (originHostname !== parsedHost.hostname) return false
            // Origin 的端口必须与 Host 请求头的端口一致 (同源校验，支持宿主机端口映射如 4888->3888)
            if (originPort !== parsedHost.port) return false
            return true
        }

        // 兼容单体/单元测试显式传入 expectedPort 的场景
        const serverPort = expectedPort ?? (server?.address?.()?.port || PORT)
        return originPort === Number(serverPort)
    } catch {
        return false
    }
}

function parseCookies(req) {
    const list = {}
    const rc = req.headers.cookie
    if (rc) {
        rc.split(';').forEach(cookie => {
            const parts = cookie.split('=')
            const key = parts.shift()?.trim()
            if (key) {
                list[key] = decodeURIComponent(parts.join('=').trim())
            }
        })
    }
    return list
}

let activeBotProcess = null
let scheduledSyncRunning = false
let scheduledSyncTimer = null
let scheduledSyncFailureIndex = 0
let activeRunPlatform = null
let activeRunStopped = false
let activeRunTaskIds = new Set()
let activeRunErrors = new Set()
const plannedTaskIds = { desktop: [], mobile: [] }
const sseClients = new Set()
const runtimeReplay = createRuntimeReplay()
const dailySetProbeState = createDailySetProbeState()
let activeProbeAccount = null
let latestBotChallengeAlert = null
const POINTS_SCHEMA_VERSION = 5
const BACKGROUND_SYNC_INTERVAL_MS = 5 * 60 * 1000
const BACKGROUND_SYNC_BUSY_RETRY_MS = 60 * 1000
const BACKGROUND_SYNC_FAILURE_DELAYS_MS = [60, 120, 300, 600].map(seconds => seconds * 1000)
const MANUAL_SYNC_COOLDOWN_MS = 15 * 1000
const lastManualSyncAt = { desktop: 0, mobile: 0 }
const BING_APP_CHANNEL = 'SAAndroid'
const BING_APP_VERSION = '34.0.440821006'
const BING_APP_USER_AGENT =
    'Mozilla/5.0 (Linux; Android 16; Mobile; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/151.0.7922.199 Mobile Safari/537.36 BingSapphire/34.0.440821006'

function buildAppHeaders(token, country = 'US', language = 'en') {
    return {
        Authorization: `Bearer ${token}`,
        'User-Agent': BING_APP_USER_AGENT,
        'X-Rewards-AppId': `${BING_APP_CHANNEL}/${BING_APP_VERSION}`,
        'X-Rewards-PartnerId': 'startapp',
        'X-Rewards-Country': country,
        'X-Rewards-Language': language,
        'X-Rewards-Flights': 'rwgobig',
        'X-Rewards-IsMobile': 'true'
    }
}

function isAppPromotionComplete(attrs = {}) {
    return appProgressFields(attrs).complete
}

function inferRegionFromPromotions(promos) {
    if (!Array.isArray(promos) || promos.length === 0) return null
    const counts = {}
    const validCountries = new Set([
        'US', 'HK', 'TW', 'JP', 'GB', 'UK', 'CA', 'AU', 'DE', 'FR',
        'SG', 'KR', 'IN', 'BR', 'MX', 'IT', 'ES', 'NL', 'SE', 'NO',
        'DK', 'PL', 'NZ', 'IE'
    ])
    for (const p of promos) {
        if (!p) continue
        const attrs = p.attributes || p
        const str = [p.name, p.offerId, attrs.offerid, attrs.offerId, attrs.title, attrs.destinationurl, attrs.destinationUrl].filter(Boolean).join(' ')
        const matches = str.matchAll(/(?:REWARDSQUIZ_|POLL_|urlreward_|[A-Za-z]+_)?([A-Za-z]{2})([A-Za-z]{2})_/g)
        for (const m of matches) {
            const country = m[2].toUpperCase()
            if (validCountries.has(country)) {
                counts[country] = (counts[country] || 0) + 1
            }
        }
    }
    let top = null, max = 0
    for (const [k, v] of Object.entries(counts)) {
        if (v > max) { max = v; top = k }
    }
    return top
}

function getDatabase(readOnly = false) {
    const dbPath = getSessionDbPath()
    const dir = path.dirname(dbPath)
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
    try { fs.chmodSync(dir, 0o700) } catch (_) {}
    const db = new DatabaseSync(dbPath, { readOnly: readOnly && fs.existsSync(dbPath) })
    if (!readOnly) {
        initProfileSchema(db)
        initClientAuthSchema(db)
    }
    return db
}

function getActiveProfileEmail(db) {
    try {
        const active = getActiveProfile(db)
        if (active?.email) return active.email
    } catch (_) {}
    return getSavedAccount().email || null
}

function getActiveProfileRecord() {
    try {
        const db = getDatabase(false)
        const active = getActiveProfile(db)
        db.close()
        return active
    } catch (_) {}
    return null
}

function getDailyStateFilePath(profileId = null) {
    let pId = profileId
    if (!pId) {
        const active = getActiveProfileRecord()
        pId = active?.id
    }
    pId = pId || 'profile_default'
    const perProfilePath = path.join(getSessionDir(), `daily_state_${pId}.json`)
    if (fs.existsSync(perProfilePath)) return perProfilePath
    if (pId === 'profile_default' && fs.existsSync(stateFilePath)) return stateFilePath
    return perProfilePath
}

function getMobileStateFilePath(profileId = null) {
    let pId = profileId
    if (!pId) {
        const active = getActiveProfileRecord()
        pId = active?.id
    }
    pId = pId || 'profile_default'
    const perProfilePath = path.join(getSessionDir(), `mobile_state_${pId}.json`)
    if (fs.existsSync(perProfilePath)) return perProfilePath
    if (pId === 'profile_default' && fs.existsSync(mobileStateFilePath)) return mobileStateFilePath
    return perProfilePath
}

function getSessionAuthorizationStatus() {
    const status = { desktop: false, mobile: false, desktopEmail: '', mobileEmail: '' }
    const dbPath = getSessionDbPath()
    if (!fs.existsSync(dbPath)) return status

    let db
    try {
        db = getDatabase(false)
        const targetEmail = getActiveProfileEmail(db)
        for (const platform of ['desktop', 'mobile']) {
            let row = null
            if (targetEmail) {
                row = db
                    .prepare('SELECT email, storage_state FROM sessions WHERE platform = ? AND email = ? AND storage_state IS NOT NULL LIMIT 1')
                    .get(platform, targetEmail)
            }
            if (!row) {
                row = db
                    .prepare('SELECT email, storage_state FROM sessions WHERE platform = ? AND storage_state IS NOT NULL LIMIT 1')
                    .get(platform)
            }
            if (!row?.email || !row.storage_state) continue
            const storage = JSON.parse(row.storage_state)
            if (!Array.isArray(storage.cookies) || storage.cookies.length === 0) continue
            status[platform] = true
            status[`${platform}Email`] = row.email
        }
    } catch (_) {
        return status
    } finally {
        try { db?.close() } catch (_) {}
    }
    return status
}

function selectAppSearchPromotion(promotions) {
    const level = String(promotions.find(p => p.name === 'level_info')?.attributes?.level || '').toLowerCase()
    const candidates = promotions.filter(p => {
        const attrs = p.attributes || {}
        return attrs.type === 'search' &&
            String(attrs.give_eligible || '').toLowerCase() !== 'false' &&
            String(attrs.hidden || '').toLowerCase() !== 'true' &&
            appProgressFields(attrs).max > 0
    })
    return (level
        ? candidates.find(p => `${p.name || ''} ${p.attributes?.offerid || ''}`.toLowerCase().includes(level))
        : null) || candidates.sort((a, b) => pointValue(b.priority) - pointValue(a.priority))[0] || null
}

function isDailySetIdentity(promotion) {
    const attrs = promotion?.attributes || {}
    const identity = `${promotion?.name || promotion?.offerId || ''} ${attrs.offerid || ''}`
    return Boolean(attrs.daily_set_date || promotion?.daily_set_date) ||
        /daily[_-]?set[_-]?\d{8}[_-]?child\d+/i.test(identity)
}

function isCurrentAppDailySetPromotion(promotion, appDate) {
    return isCurrentAppDailySetCandidate(promotion, appDate)
}

function isAppMoreActivityPromotion(promotion) {
    const attrs = promotion.attributes || {}
    const name = String(promotion.name || '').toLowerCase()
    const type = String(attrs.type || '').toLowerCase()
    const isDailySet = Boolean(attrs.daily_set_date)
    const excluded = ['impression', 'trialuser', 'progress_info', '_info', 'userwarning']
        .some(marker => name.includes(marker))

    return (type === 'urlreward' || type === 'sapphire') &&
        !isDailySet &&
        !excluded &&
        Boolean(attrs.offerid) &&
        String(attrs.give_eligible || '').toLowerCase() !== 'false' &&
        String(attrs.hidden || '').toLowerCase() !== 'true' &&
        appProgressFields(attrs).max > 0
}

function discoverAdditionalAppTaskSections(promotions) {
    const knownTypes = new Set(['search', 'msnreadearn', 'streak', 'urlreward', 'sapphire'])
    const excludedMarkers = ['impression', 'trialuser', 'progress_info', '_info', 'userwarning', 'layout', 'level_info']
    const groups = new Map()

    for (const promotion of promotions) {
        const attrs = promotion?.attributes || {}
        const type = String(attrs.type || '').toLowerCase()
        const name = String(promotion?.name || '').toLowerCase()
        const max = appProgressFields(attrs).max
        if (!attrs.offerid || max <= 0 || knownTypes.has(type) || isDailySetIdentity(promotion)) continue
        if (String(attrs.give_eligible || '').toLowerCase() === 'false' || String(attrs.hidden || '').toLowerCase() === 'true') continue
        if (excludedMarkers.some(marker => name.includes(marker))) continue

        const sectionKey = type || 'other'
        if (!groups.has(sectionKey)) groups.set(sectionKey, [])
        const progress = appProgressFields(attrs).progress
        const complete = isAppPromotionComplete(attrs)
        groups.get(sectionKey).push({
            offerId: attrs.offerid,
            title: attrs.title || promotion.name || 'Official activity',
            description: attrs.description || '',
            points: max,
            progress: complete ? max : progress,
            complete,
            destinationUrl: attrs.destination_url || attrs.destinationUrl || attrs.destination || attrs.url || '',
            source: `SAAndroid · ${sectionKey}`
        })
    }

    return [...groups.entries()].map(([type, cards]) => ({
        id: `saandroid-${type}`,
        title: `其他官方任务 · ${type}`,
        source: `SAAndroid · ${type}`,
        cards
    }))
}

function discoverAdditionalWebTaskSections(dashboard, knownOfferIds) {
    const ignoredCollections = new Set([
        'promotionalItems', 'dailySetPromotions', 'morePromotions', 'morePromotionsWithoutPromotionalItems',
        'streakBonusPromotions', 'componentImpressionPromotions', 'suggestedRewards', 'autoRedeemSubscriptions',
        'coupons', 'popUpPromotions', 'highValueSweepstakesPromotions', 'megaIntroOfferPromotions'
    ])
    const sections = []

    for (const [collection, rawItems] of Object.entries(dashboard || {})) {
        if (!Array.isArray(rawItems) || !rawItems.length || ignoredCollections.has(collection)) continue
        if (!/(punch|task|activit|offer|promotion)/i.test(collection)) continue

        const cards = []
        const seen = new Set()
        for (const rawItem of rawItems) {
            const item = rawItem?.parentPromotion || rawItem
            const offerId = item?.offerId || item?.name || ''
            const max = pointValue(item?.pointProgressMax)
            if (!offerId || max <= 0 || knownOfferIds.has(offerId) || isDailySetIdentity(item) || seen.has(offerId)) continue
            seen.add(offerId)
            const progress = Math.min(max, pointValue(item?.pointProgress))
            const complete = Boolean(item?.complete || progress >= max)
            cards.push({
                offerId,
                title: item?.title || item?.name || 'Official activity',
                description: item?.description || '',
                points: max,
                progress: complete ? max : progress,
                complete,
                iconUrl: item?.attributes?.image || item?.imageUrl || '',
                destinationUrl: item?.destinationUrl || '',
                source: `Rewards Web · ${collection}`
            })
        }
        if (cards.length) {
            const title = collection.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/^./, value => value.toUpperCase())
            sections.push({ id: `rewards-web-${collection}`, title, source: `Rewards Web · ${collection}`, cards })
        }
    }
    return sections
}

function pointValue(value) {
    const parsed = Number(value)
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 0
}

let latestOfficialDashboardResetAt = null

function extractOfficialDailySetDate(dashboardHtml) {
    const offerIds = dashboardHtml?.match(/[A-Za-z0-9_-]*DailySet_\d{8}_Child\d+/gi) || []
    const dates = new Set()
    for (const offerId of offerIds) {
        const stamp = offerId.match(/DailySet_(\d{8})_Child\d+/i)?.[1]
        if (stamp) dates.add(`${stamp.slice(4, 6)}/${stamp.slice(6, 8)}/${stamp.slice(0, 4)}`)
    }
    const expiresMatch = dashboardHtml?.match(/expiresAt\\*":\\*"(?:\$D)?(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2}))/)
    if (expiresMatch) {
        latestOfficialDashboardResetAt = expiresMatch[1]
    }
    return dates.size === 1 ? [...dates][0] : null
}

export function selectOfficialDailySetDate(dailySetPromotions, region = 'US', now = new Date()) {
    if (!dailySetPromotions || typeof dailySetPromotions !== 'object') return null
    const dateKeys = Object.keys(dailySetPromotions).filter(d => /^\d{2}\/\d{2}\/\d{4}$/.test(d))
    if (!dateKeys.length) return null
    if (dateKeys.length === 1) return dateKeys[0]

    // 1. 如果某个日期的任务已完成或已有进度，说明该日期正是正在进行或已做完的当天任务
    const inProgressDate = dateKeys.find(d => {
        const items = dailySetPromotions[d]
        return Array.isArray(items) && items.some(item => Boolean(item.complete) || Number(item.pointProgress || 0) > 0)
    })
    if (inProgressDate) return inProgressDate

    // 2. 检查候选日期是否匹配当前账号所在区域或本地/UTC的当前日历日期
    const candidateMatches = new Set()

    const localMm = String(now.getMonth() + 1).padStart(2, '0')
    const localDd = String(now.getDate()).padStart(2, '0')
    const localYyyy = now.getFullYear()
    candidateMatches.add(`${localMm}/${localDd}/${localYyyy}`)

    const utcMm = String(now.getUTCMonth() + 1).padStart(2, '0')
    const utcDd = String(now.getUTCDate()).padStart(2, '0')
    const utcYyyy = now.getUTCFullYear()
    candidateMatches.add(`${utcMm}/${utcDd}/${utcYyyy}`)

    const timezones = ['America/New_York', 'America/Los_Angeles']
    const regUpper = String(region || '').trim().toUpperCase()
    if (regUpper === 'HK') timezones.push('Asia/Hong_Kong')
    if (regUpper === 'TW') timezones.push('Asia/Taipei')
    if (regUpper === 'JP') timezones.push('Asia/Tokyo')
    if (regUpper === 'GB') timezones.push('Europe/London')

    for (const tz of timezones) {
        try {
            const parts = new Intl.DateTimeFormat('en-US', { timeZone: tz, month: '2-digit', day: '2-digit', year: 'numeric' }).formatToParts(now)
            const m = parts.find(p => p.type === 'month')?.value
            const d = parts.find(p => p.type === 'day')?.value
            const y = parts.find(p => p.type === 'year')?.value
            if (m && d && y) candidateMatches.add(`${m}/${d}/${y}`)
        } catch (_) {}
    }

    const matchedToday = dateKeys.find(d => candidateMatches.has(d))
    if (matchedToday) return matchedToday

    // 3. 过滤掉未来日期（按当前 UTC 时间向后宽限 14 小时，即地球上最早的时区）
    const nonFutureDates = dateKeys.filter(d => {
        const [m, day, y] = d.split('/').map(Number)
        const dateUtc = Date.UTC(y, m - 1, day)
        return dateUtc <= now.getTime() + 14 * 3600 * 1000
    })

    if (nonFutureDates.length > 0) {
        nonFutureDates.sort((a, b) => {
            const [am, ad, ay] = a.split('/').map(Number)
            const [bm, bd, by] = b.split('/').map(Number)
            return Date.UTC(ay, am - 1, ad) - Date.UTC(by, bm - 1, bd)
        })
        return nonFutureDates[nonFutureDates.length - 1]
    }

    // 4. 终极兜底：升序排列，取最早日期（今天排在明天之前）
    dateKeys.sort((a, b) => {
        const [am, ad, ay] = a.split('/').map(Number)
        const [bm, bd, by] = b.split('/').map(Number)
        return Date.UTC(ay, am - 1, ad) - Date.UTC(by, bm - 1, bd)
    })
    return dateKeys[0]
}

async function fetchOfficialDailySetDate(cookieHeader, region = 'US') {
    try {
        const response = await fetch('https://rewards.bing.com/dashboard', {
            headers: {
                'Cookie': cookieHeader,
                'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36 Edg/133.0.0.0',
                'Accept-Language': 'en-US,en;q=0.9'
            },
            signal: AbortSignal.timeout(8000)
        })
        if (response.ok) {
            const extracted = extractOfficialDailySetDate(await response.text())
            if (extracted) return extracted
        }
    } catch (_) {}

    try {
        const userInfoRes = await fetch('https://rewards.bing.com/api/getuserinfo', {
            headers: {
                'Cookie': cookieHeader,
                'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36 Edg/133.0.0.0'
            },
            signal: AbortSignal.timeout(6000)
        })
        if (userInfoRes.ok) {
            const userInfoJson = await userInfoRes.json()
            const selected = selectOfficialDailySetDate(userInfoJson.dashboard?.dailySetPromotions, region)
            if (selected) return selected
        }
    } catch (_) {}
    return null
}

function computeRegionNextResetAt(region, now = new Date()) {
    const regionCode = String(region || '').trim().toUpperCase()
    if (regionCode === 'US' && latestOfficialDashboardResetAt) {
        const epoch = Date.parse(latestOfficialDashboardResetAt)
        if (Number.isFinite(epoch) && epoch > now.getTime()) {
            return latestOfficialDashboardResetAt
        }
    }
    const tzMap = {
        US: 'Etc/GMT+8',
        HK: 'Asia/Hong_Kong',
        TW: 'Asia/Taipei',
        SG: 'Asia/Singapore',
        JP: 'Asia/Tokyo',
        GB: 'Europe/London',
        UK: 'Europe/London',
        DE: 'Europe/Berlin',
        FR: 'Europe/Paris',
        CA: 'America/Toronto',
        AU: 'Australia/Sydney'
    }
    const tz = tzMap[String(region || '').trim().toUpperCase()] || (region ? 'UTC' : null)
    if (!tz) return null
    try {
        const fmt = new Intl.DateTimeFormat('en-CA', {
            timeZone: tz,
            year: 'numeric',
            month: '2-digit',
            day: '2-digit',
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit',
            hour12: false
        })
        const formatted = fmt.format(now)
        const timePart = formatted.includes(', ') ? formatted.split(', ')[1] : formatted.split(' ')[1]
        if (!timePart) return null
        const [h, min, s] = timePart.split(':').map(Number)
        const secondsUntilMidnight = (24 * 3600) - (h * 3600 + min * 60 + s)
        const nextResetEpoch = now.getTime() + secondsUntilMidnight * 1000
        return new Date(nextResetEpoch).toISOString()
    } catch (_) {
        return null
    }
}

function resolveAppDailySetDate(promotions) {
    if (!Array.isArray(promotions) && promotions?.response?.promotions) {
        promotions = promotions.response.promotions
    }
    if (!Array.isArray(promotions)) return null

    const marketTime = promotions.find(p => p.name === 'BingFlyout_Layout_DailyCheckIn')?.attributes?.markettime
    const stamp = String(marketTime || '').match(/^(\d{4})(\d{2})(\d{2})T/)
    if (stamp) {
        const appDate = `${stamp[2]}/${stamp[3]}/${stamp[1]}`
        return promotions.some(p => p.attributes?.daily_set_date === appDate) ? appDate : null
    }

    const dateMap = new Map()
    for (const p of promotions) {
        const dsDate = p.attributes?.daily_set_date
        const offerId = p.attributes?.offerid || p.name || ''
        if (dsDate && /_Child[123]$/i.test(offerId)) {
            dateMap.set(dsDate, (dateMap.get(dsDate) || 0) + 1)
        }
    }
    const completeDates = Array.from(dateMap.entries())
        .filter(([_, count]) => count >= 3)
        .map(([date]) => date)
        .sort((a, b) => {
            const [am, ad, ay] = a.split('/').map(Number)
            const [bm, bd, by] = b.split('/').map(Number)
            return new Date(ay, am - 1, ad).getTime() - new Date(by, bm - 1, bd).getTime()
        })

    return completeDates[0] || null
}

function parseQuota(value) {
    const match = String(value || '').match(/^(\d+)\/(\d+)/)
    if (!match) return { earned: 0, max: 0, complete: false }
    const earned = Number(match[1])
    const max = Number(match[2])
    return { earned, max, complete: max > 0 && earned >= max }
}

function summarizePointItems(items = []) {
    return items.reduce(
        (summary, item) => {
            const max = pointValue(item?.pointProgressMax ?? item?.attributes?.pointmax ?? item?.attributes?.max)
            const rawEarned = pointValue(
                item?.pointProgress ?? item?.attributes?.pointprogress ?? item?.attributes?.progress
            )
            const complete = item?.complete === true || item?.attributes?.complete === true || item?.attributes?.complete === 'True'
            summary.earned += complete ? max : Math.min(max, rawEarned)
            summary.max += max
            return summary
        },
        { earned: 0, max: 0 }
    )
}

function sameLocalDay(value, now = new Date()) {
    const date = new Date(value)
    return Number.isFinite(date.getTime()) && date.toDateString() === now.toDateString()
}

function parseRewardsCounter(value) {
    if (typeof value !== 'string') return null
    const parts = value.split(';')
    return {
        activity: pointValue(parts[0]),
        points: pointValue(parts[2]),
        updatedAt: parts[5] || '',
        step: pointValue(parts[parts.length - 1])
    }
}

function getLatestCounter(counters, prefix, excludeDateKey = '') {
    const names = Object.keys(counters || {})
        .filter(name => name.startsWith(prefix) && (!excludeDateKey || !name.endsWith(excludeDateKey)))
        .sort()
        .reverse()
    if (!names.length) return null
    return parseRewardsCounter(counters[names[0]])
}

function buildCheckInState(counters, prefix, dateKey, schedule) {
    const today = parseRewardsCounter(counters?.[`${prefix}${dateKey}`])
    const previous = getLatestCounter(counters, prefix, dateKey)
    const step = today?.step || ((previous?.step || 0) % schedule.length) + 1
    const reward = schedule[(Math.max(1, step) - 1) % schedule.length] || 0
    return {
        progress: step,
        max: schedule.length,
        done: Boolean(today),
        earned: today ? reward : 0,
        reward,
        days: schedule
    }
}

function broadcast(data) {
    runtimeReplay.record(data)
    const payload = `data: ${JSON.stringify(data)}\n\n`
    for (const res of sseClients) {
        try {
            res.write(payload)
        } catch (e) {
            sseClients.delete(res)
        }
    }
}

let activeCloudReads = 0

async function fetchLiveMicrosoftState() {
    if (!getSavedAccount().email) return null
    activeCloudReads++
    try { return await readLiveMicrosoftState() }
    finally { activeCloudReads-- }
}

async function readLiveMicrosoftState() {
    return new Promise((resolve) => {
        try {
            const dbPath = getSessionDbPath()
            const db = getDatabase(false)
            const activeProfile = getActiveProfile(db)
            const targetEmail = activeProfile?.email || getActiveProfileEmail(db)
            let row = null
            if (targetEmail) {
                row = db.prepare('SELECT email, storage_state FROM sessions WHERE platform = ? AND email = ? LIMIT 1').get('desktop', targetEmail)
            }
            if (!row) {
                row = db.prepare('SELECT email, storage_state FROM sessions WHERE platform = ? LIMIT 1').get('desktop')
            }
            if (!row || !row.storage_state) return resolve(null)
            
            const email = row.email
            if (!email) return resolve(null)
            const savedAccount = getSavedAccount()
            const resolvedRegion = db
                .prepare('SELECT resolved_region FROM account_metadata WHERE email = ? LIMIT 1')
                .get(email)?.resolved_region
            const appCountry = (activeProfile?.region && activeProfile.region !== 'AUTO')
                ? activeProfile.region
                : (savedAccount.geoLocale && savedAccount.geoLocale !== 'auto'
                    ? savedAccount.geoLocale
                    : (resolvedRegion || 'US'))
            const appLanguage = savedAccount.langCode || 'en'
            const storage = JSON.parse(row.storage_state)
            if (!storage.cookies || !storage.cookies.length) return resolve(null)
            const authUrl = `https://login.live.com/oauth20_authorize.srf?response_type=code&client_id=0000000040170455&redirect_uri=https%3A%2F%2Flogin.live.com%2Foauth20_desktop.srf&scope=service%3A%3Aprod.rewardsplatform.microsoft.com%3A%3AMBI_SSL&access_type=offline_access&login_hint=${encodeURIComponent(email)}`
            const authCookieHeader = sessionCookieHeader(storage.cookies, authUrl)
            const earnCookieHeader = sessionCookieHeader(storage.cookies, 'https://rewards.bing.com/earn')
            const dashboardCookieHeader = sessionCookieHeader(storage.cookies, 'https://rewards.bing.com/dashboard')
            const userInfoCookieHeader = sessionCookieHeader(storage.cookies, 'https://rewards.bing.com/api/getuserinfo')

            https.request(authUrl, {
                headers: {
                    'Cookie': authCookieHeader,
                    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36'
                },
                timeout: 8000
            }, (resAuth) => {
                const loc = resAuth.headers.location || ''
                resAuth.resume()
                const match = loc.match(/[?&]code=([^&]+)/)
                if (!match) return resolve(null)
                const code = decodeURIComponent(match[1])

                const postData = new URLSearchParams({
                    grant_type: 'authorization_code',
                    client_id: '0000000040170455',
                    code: code,
                    redirect_uri: 'https://login.live.com/oauth20_desktop.srf',
                    scope: 'service::prod.rewardsplatform.microsoft.com::MBI_SSL'
                }).toString()

                const reqToken = https.request('https://login.microsoftonline.com/consumers/oauth2/v2.0/token', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/x-www-form-urlencoded',
                        'Content-Length': Buffer.byteLength(postData)
                    },
                    timeout: 8000
                }, (resToken) => {
                    let tokenData = ''
                    resToken.on('data', chunk => tokenData += chunk)
                    resToken.on('end', () => {
                        try {
                            const tokenJson = JSON.parse(tokenData)
                            const token = tokenJson.access_token
                            if (!token) return resolve(null)

                            // 1. Fetch official /earn page (RSC flight data) for exact un-calculated Today's points and streaks
                            Promise.all([
                                fetch('https://rewards.bing.com/earn', {
                                    headers: {
                                        'Cookie': earnCookieHeader,
                                        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36',
                                        'RSC': '1'
                                    }
                                }).then(res => res.text()),
                                fetchOfficialDailySetDate(dashboardCookieHeader)
                            ])
                            .then(([earnText, initialDailySetDate]) => {
                                try {
                                    let officialDailySetDate = initialDailySetDate
                                    const todayPointsMatch = earnText.match(/\"EarnHeader_TodaysStat\"[^{}]*\"data\":\{[^{}]*\"totalPoints\":(\d+)/)
                                    const officialTodayPoints = todayPointsMatch ? Number(todayPointsMatch[1]) : null

                                    const streakMatch = earnText.match(/\"EarnHeader_StreakStat\"[^{}]*\"data\":\{[^{}]*\"streakCounter\":(\d+)/)
                                    const officialStreak = streakMatch ? Number(streakMatch[1]) : 7

                                    const streakCards = []
                                    const cardRe = /\"EarnStreaksSection_StreakCard\"[^{}]*\"data\":(\{[^{}]+\})/g
                                    let cm
                                    while ((cm = cardRe.exec(earnText)) !== null) {
                                        try { streakCards.push(JSON.parse(cm[1])) } catch(_) {}
                                    }

                                    const dsStreak = streakCards.find(c => c.partner === 'dailyset')
                                    const bingStreak = streakCards.find(c => c.partner === 'bing')
                                    const edgeStreak = streakCards.find(c => c.partner === 'edge')
                                    const appStreak = streakCards.find(c => c.partner === 'bingapp')

                                        // 2. Fetch getuserinfo for rich user balance, level and promotion cards
                                        https.get('https://rewards.bing.com/api/getuserinfo', {
                                            headers: {
                                                'Cookie': userInfoCookieHeader,
                                                'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36 Edg/133.0.0.0'
                                            },
                                            timeout: 8000
                                        }, (resInfo) => {
                                            let infoRaw = ''
                                            resInfo.on('data', c => infoRaw += c)
                                            resInfo.on('end', async () => {
                                                try {
                                                    let infoData = null
                                                    if (infoRaw && infoRaw.trim().startsWith('{')) {
                                                        try { infoData = JSON.parse(infoRaw) } catch (_) {}
                                                    }
                                                    if (!infoData?.dashboard) {
                                                        try {
                                                            const platformRes = await fetch('https://prod.rewardsplatform.microsoft.com/dapi/me?channel=SAAndroid&options=612', {
                                                                headers: buildAppHeaders(token, appCountry, appLanguage),
                                                                signal: AbortSignal.timeout(8000)
                                                            })
                                                            if (platformRes.ok) {
                                                                const platformJson = await platformRes.json()
                                                                const promos = platformJson.response?.promotions || []
                                                                const bal = pointValue(platformJson.response?.balance)
                                                                const dailySetPromotions = {}
                                                                promos.forEach(p => {
                                                                    const attrs = p.attributes || {}
                                                                    const d = attrs.daily_set_date
                                                                    if (d) {
                                                                        dailySetPromotions[d] = dailySetPromotions[d] || []
                                                                        dailySetPromotions[d].push({
                                                                            offerId: attrs.offerid || p.name,
                                                                            title: attrs.title || p.name,
                                                                            description: attrs.description || '',
                                                                            pointProgressMax: appProgressFields(attrs).max || 10,
                                                                            complete: isAppPromotionComplete(attrs),
                                                                            attributes: attrs,
                                                                            destinationUrl: attrs.destinationurl || ''
                                                                        })
                                                                    }
                                                                })
                                                                const morePromos = promos.filter(p => !p.attributes?.daily_set_date && !/daily[_-]?set/i.test(p.name || '')).map(p => {
                                                                    const attrs = p.attributes || {}
                                                                    return {
                                                                        offerId: attrs.offerid || p.name,
                                                                        title: attrs.title || p.name,
                                                                        description: attrs.description || '',
                                                                        pointProgressMax: appProgressFields(attrs).max || 0,
                                                                        pointProgress: appProgressFields(attrs).progress || 0,
                                                                        complete: isAppPromotionComplete(attrs),
                                                                        attributes: attrs,
                                                                        destinationUrl: attrs.destinationurl || ''
                                                                    }
                                                                })
                                                                infoData = {
                                                                    dashboard: {
                                                                        userStatus: {
                                                                            availablePoints: bal,
                                                                            lifetimePoints: bal,
                                                                            levelInfo: { activeLevelName: 'Level 2', progress: 500, progressMax: 500 },
                                                                            counters: {
                                                                                pcSearch: [{ pointProgress: 0, pointProgressMax: 150, complete: false }]
                                                                            }
                                                                        },
                                                                        dailySetPromotions,
                                                                        morePromotions: morePromos,
                                                                        punchCards: []
                                                                    }
                                                                }
                                                            }
                                                        } catch (_) {}
                                                    }
                                                    if (!infoData?.dashboard) return resolve(null)
                                                    const userStatus = infoData?.dashboard?.userStatus || {}
                                                    const available = pointValue(userStatus.availablePoints)
                                                    const lifetime = pointValue(userStatus.lifetimePoints)

                                                    const resolvedDate = selectOfficialDailySetDate(infoData?.dashboard?.dailySetPromotions, appCountry)
                                                    if (resolvedDate) {
                                                        officialDailySetDate = resolvedDate
                                                    }
                                                    if (!officialDailySetDate) return resolve(null)

                                                    const dailySetItems = infoData?.dashboard?.dailySetPromotions?.[officialDailySetDate] || []
                                                    const isDsComplete = Boolean(
                                                        (dsStreak && dsStreak.complete >= dsStreak.total) ||
                                                        (dailySetItems.length > 0 && dailySetItems.every(item => item.complete))
                                                    )

                                                    const rawPromos = [
                                                        ...(infoData?.dashboard?.morePromotions || []),
                                                        ...(infoData?.dashboard?.morePromotionsWithoutPromotionalItems || [])
                                                    ]

                                                    const promoRegion = inferRegionFromPromotions(dailySetItems.concat(rawPromos))
                                                    const profileCountry = infoData?.dashboard?.userProfile?.attributes?.country?.toUpperCase()
                                                    const detectedRegion = (promoRegion && /^[A-Z]{2}$/.test(promoRegion)) ? promoRegion : (profileCountry && /^[A-Z]{2}$/.test(profileCountry) ? profileCountry : null)
                                                    if (detectedRegion && /^[A-Z]{2}$/.test(detectedRegion)) {
                                                        try {
                                                            db.prepare(`
                                                                INSERT INTO account_metadata (email, resolved_region, updated_at)
                                                                VALUES (?, ?, ?)
                                                                ON CONFLICT(email)
                                                                DO UPDATE SET resolved_region = excluded.resolved_region, updated_at = excluded.updated_at
                                                            `).run(email, detectedRegion, Date.now())
                                                        } catch (_) {}
                                                    }
                                                    const currentRegion = detectedRegion || appCountry || 'US'

                                                    const userWarnings = infoData?.dashboard?.userWarnings || []
                                                    const hasBotWarning = Array.isArray(userWarnings) && userWarnings.some(w => w?.name === BOT_WARNING_KEY)
                                                    if (hasBotWarning) {
                                                        latestBotChallengeAlert = {
                                                            type: 'bot_challenge_alert',
                                                            level: 'warn',
                                                            title: '⚠️ 触发微软人机安全质询 (BotScore / 拼图验证)',
                                                            content: '检测到微软官方风控标记 (Fraud_UserWarning_BotScore_UX)。系统已启动安全避险模式：自动跳过每日任务(问答/答题)高危项目，保留日常安全搜索与签到。建议在手机 Bing App 中手动完成以破冰。',
                                                            actionUrl: 'https://rewards.bing.com',
                                                            actionLabel: '前往官方页面破冰',
                                                            timestamp: Date.now()
                                                        }
                                                    } else if (latestBotChallengeAlert) {
                                                        latestBotChallengeAlert = null
                                                        broadcast({ type: 'botChallengeCleared' })
                                                    }

                                                    const dailySetCards = dailySetItems.map((item) => {
                                                        const hasRiskWarning = Boolean(hasBotWarning && !item.complete)
                                                        return {
                                                            offerId: item.offerId,
                                                            requiresAppInteraction: false,
                                                            isLockedTomorrow: isTomorrowLockedTask(item),
                                                            title: item.title || item.name || '日常任务',
                                                            description: item.description || '',
                                                            points: Number(item.pointProgressMax || 10),
                                                            complete: Boolean(item.complete),
                                                            hasRiskWarning,
                                                            riskLevel: hasRiskWarning ? 'HIGH_RISK' : 'NORMAL',
                                                            requiresManual: hasRiskWarning,
                                                            riskBadge: hasRiskWarning ? '⚠️ 高风险 (需手工)' : null,
                                                            iconUrl: item.attributes?.image || item.imageUrl || '',
                                                            destinationUrl: item.destinationUrl || ''
                                                        }
                                                    })

                                                    const visibleOfferIds = earnKeepEarningIds(earnText)
                                                    if (visibleOfferIds === null) return resolve(null)
                                                    const promoCards = selectPcKeepEarningPromotions(rawPromos, dailySetItems, visibleOfferIds).map(item => ({
                                                        offerId: item.offerId || item.name || '',
                                                        title: item.title || item.name || '活动推广',
                                                        description: item.description || '',
                                                        points: pointValue(item.pointProgressMax),
                                                        progress: pointValue(item.pointProgress),
                                                        complete: Boolean(item.complete || (pointValue(item.pointProgressMax) > 0 && pointValue(item.pointProgress) >= pointValue(item.pointProgressMax))),
                                                        requiresManualInteraction: isManualKeepEarningTask(item),
                                                        isLockedTomorrow: isTomorrowLockedTask(item),
                                                        iconUrl: item.attributes?.image || item.imageUrl || '',
                                                        destinationUrl: item.destinationUrl || ''
                                                    }))

                                                    const promoEarned = promoCards.reduce((sum, c) => sum + Math.min(c.points, c.complete ? c.points : c.progress), 0)
                                                    const promoTotal = promoCards.reduce((s, c) => s + c.points, 0)

                                                    const pcSearch = summarizePointItems(userStatus.counters?.pcSearch || [])
                                                    const dailySet = summarizePointItems(dailySetItems)
                                                    const pcDailyEarned = pcSearch.earned + dailySet.earned + promoEarned
                                                    const pcDailyMax = pcSearch.max + dailySet.max + promoTotal
                                                    const dailyEarned = officialTodayPoints ?? pcDailyEarned
                                                    const pcRemaining = Math.max(0, pcDailyMax - pcDailyEarned)
                                                    const dailyMax = dailyEarned + pcRemaining
                                                    const levelInfo = userStatus.levelInfo || {}
                                                    const punchCards = (infoData?.dashboard?.punchCards || []).map(card => {
                                                        const promotion = card.parentPromotion || card
                                                        const max = pointValue(promotion.pointProgressMax)
                                                        const earned = promotion.complete ? max : Math.min(max, pointValue(promotion.pointProgress))
                                                        return {
                                                            title: promotion.title || promotion.name || 'Punch card',
                                                            earned,
                                                            max,
                                                            complete: Boolean(promotion.complete || (max > 0 && earned >= max))
                                                        }
                                                    }).filter(card => card.max > 0)
                                                    const knownOfferIds = new Set([
                                                        ...dailySetItems.map(item => item.offerId || item.name).filter(Boolean),
                                                        ...promoCards.map(item => item.offerId).filter(Boolean)
                                                    ])
                                                    const additionalTaskSections = discoverAdditionalWebTaskSections(
                                                        infoData?.dashboard,
                                                        knownOfferIds
                                                    )
                                                    const edgeProgress = edgeStreak ? pointValue(edgeStreak.complete) : 0
                                                    const edgeMax = edgeStreak ? pointValue(edgeStreak.total) : 0

                                                    resolve({
                                                        account: email,
                                                        region: currentRegion,
                                                        totalPoints: available,
                                                        lifetimePoints: lifetime,
                                                        level: levelInfo.activeLevelName || levelInfo.activeLevel || '',
                                                        levelProgress: `${pointValue(levelInfo.progress ?? levelInfo.levelUpActivitiesProgress)}/${pointValue(levelInfo.progressMax ?? levelInfo.levelUpActivitiesMax)}`,
                                                        available: available,
                                                        lifetime: lifetime,
                                                        dailyEarned: dailyEarned,
                                                        dailyMax,
                                                        officialAccountTodayEarned: officialTodayPoints,
                                                        pcDailyEarned,
                                                        pcDailyMax,
                                                        offers: promoEarned,
                                                        thisMonth: pointValue(levelInfo.progress),
                                                        thisYear: null,
                                                        pcSearchQuota: `${pcSearch.earned}/${pcSearch.max}`,
                                                        dailySetDate: officialDailySetDate,
                                                        taskRefresh: { source: 'rewards-web', accountDate: officialDailySetDate, nextResetAt: computeRegionNextResetAt(currentRegion) },
                                                        dailySetCards,
                                                        promoCards,
                                                        promotionsQuota: `${promoEarned}/${promoTotal}`,
                                                        appStreak: `🔥 ${officialStreak}`,
                                                        appCheckIn: `Check-in: ${appStreak ? `${appStreak.complete}/${appStreak.total}` : '未知'}`,
                                                        streak: officialStreak,
                                                        streakDetails: {
                                                            dailySet: dsStreak ? `${dsStreak.complete}/${dsStreak.total}` : '未知',
                                                            bingSearch: bingStreak ? `${bingStreak.complete}/${bingStreak.total}` : '未知',
                                                            edgeBrowsing: edgeStreak ? `${edgeStreak.complete}/${edgeStreak.total} min` : '未知',
                                                            appCheckIn: appStreak ? `${appStreak.complete}/${appStreak.total}` : '未知'
                                                        },
                                                        edgeBrowsing: {
                                                            earned: edgeProgress,
                                                            max: edgeMax,
                                                            unit: 'min',
                                                            complete: edgeMax > 0 && edgeProgress >= edgeMax,
                                                            available: Boolean(edgeStreak)
                                                        },
                                                        punchCards,
                                                        additionalTaskSections,
                                                        syncSource: 'rewards-web',
                                                        syncedAt: new Date().toISOString(),
                                                        allTasksDone: isDsComplete,
                                                        isNewDay: !isDsComplete,
                                                        region: currentRegion,
                                                        hasBotWarning,
                                                        userWarnings,
                                                        pointsSchemaVersion: POINTS_SCHEMA_VERSION
                                                    })
                                                } catch (e) { resolve(null) }
                                            })
                                        }).on('error', () => resolve(null))
                                    } catch (e) { resolve(null) }
                                }).catch(() => resolve(null))
                        } catch (e) { resolve(null) }
                    })
                })
                reqToken.on('error', () => resolve(null))
                reqToken.write(postData)
                reqToken.end()
            }).on('error', () => resolve(null)).end()
        } catch (e) { resolve(null) }
    })
}

function normalizeDate(d) {
    if (!d || typeof d !== 'string') return ''
    if (d.includes('/')) {
        const [m, day, y] = d.split('/')
        return `${y}-${m.padStart(2, '0')}-${day.padStart(2, '0')}`
    }
    return d.slice(0, 10)
}

function getSavedState(profileId = null) {
    const today = new Date().toISOString().slice(0, 10)
    const targetFile = getDailyStateFilePath(profileId)
    try {
        if (fs.existsSync(targetFile)) {
            const raw = fs.readFileSync(targetFile, 'utf-8')
            const state = JSON.parse(raw)
            if (state.pointsSchemaVersion !== POINTS_SCHEMA_VERSION) {
                state.dailyEarned = 0
                state.dailyMax = 0
                state.pcSearchQuota = '0/0'
                state.allTasksDone = false
                state.isNewDay = true
            }
            const stateDate = normalizeDate(state.currentDate || state.date)
            if (stateDate && stateDate !== today) {
                state.isNewDay = true
                state.currentDate = today
                state.dailyEarned = 0
                state.allTasksDone = false
                state.dailySetQuota = '0/30'
                state.pcSearchQuota = '0/30'
                state.offers = 0
            }
            const inferred = state.region || inferRegionFromPromotions([...(state.dailySetCards || []), ...(state.promoCards || [])])
            if (inferred) {
                state.region = inferred
                try {
                    const dbPath = getSessionDbPath()
                    if (fs.existsSync(dbPath)) {
                        const db = new DatabaseSync(dbPath)
                        const targetEmail = state.account || getSavedAccount().email
                        if (targetEmail) {
                            db.prepare(`
                                INSERT INTO account_metadata (email, resolved_region, updated_at)
                                VALUES (?, ?, ?)
                                ON CONFLICT(email)
                                DO UPDATE SET resolved_region = excluded.resolved_region, updated_at = excluded.updated_at
                            `).run(targetEmail, inferred, Date.now())
                        }
                    }
                } catch (_) {}
            } else {
                state.region = state.region || getResolvedAccountRegion(state.account)
            }
            if (state.region) {
                if (!state.taskRefresh) {
                    state.taskRefresh = {
                        source: 'rewards-web',
                        accountDate: state.dailySetDate || null,
                        nextResetAt: computeRegionNextResetAt(state.region)
                    }
                } else {
                    state.taskRefresh.nextResetAt = computeRegionNextResetAt(state.region)
                }
            }
            return dailySetProbeState.apply(state.account || getSavedAccount().email, 'desktop', state)
        }
    } catch (e) {}
    const defaultRegion = getResolvedAccountRegion()
    return {
        date: today,
        currentDate: today,
        isNewDay: true,
        account: '',
        region: defaultRegion,
        taskRefresh: {
            source: 'rewards-web',
            accountDate: null,
            nextResetAt: computeRegionNextResetAt(defaultRegion)
        },
        totalPoints: 0,
        lifetimePoints: 0,
        dailyEarned: 0,
        dailyMax: 0,
        offers: 0,
        shopPoints: 0,
        level: '',
        levelProgress: '',
        pcSearchQuota: '0/0',
        mobileSearchQuota: '0/0',
        dailySetQuota: '0/30',
        promotionsQuota: '0/30',
        allTasksDone: false,
        pointsSchemaVersion: POINTS_SCHEMA_VERSION
    }
}

function computeTasks(state) {
    const dailySetCards = state.dailySetCards || []
    const dailySetDoneCount = dailySetCards.filter(c => c.complete).length
    const dailySetTotal = dailySetCards.length
    const dailySetPts = dailySetCards.reduce((s, c) => s + (c.complete ? c.points : 0), 0)

    const promoCards = state.promoCards || []
    const promoDoneCount = promoCards.filter(c => c.complete).length
    const promoTotal = promoCards.length
    const promoPts = promoCards.reduce((s, c) => s + (c.complete ? c.points : 0), 0)

    const pcQuota = parseQuota(state.pcSearchQuota)
    const edge = state.edgeBrowsing || { earned: 0, max: 0, complete: false, available: false }
    const punchCards = state.punchCards || []
    const punchEarned = punchCards.reduce((sum, card) => sum + pointValue(card.earned), 0)
    const punchMax = punchCards.reduce((sum, card) => sum + pointValue(card.max), 0)
    const punchDone = punchCards.filter(card => card.complete).length

    const hasRisk = Boolean(state.hasBotWarning)
    const isDailySetHighRisk = hasRisk && dailySetDoneCount < dailySetTotal && dailySetTotal > 0

    return {
        dailySet: {
            name: '每日任务卡 (Daily Set)',
            owner: 'shared-account',
            source: 'rewards-web',
            status: dailySetTotal <= 0
                ? 'UNAVAILABLE'
                : (dailySetDoneCount === dailySetTotal
                    ? 'DONE'
                    : (isDailySetHighRisk ? 'HIGH_RISK' : 'PENDING')),
            originalStatus: dailySetTotal <= 0 ? 'UNAVAILABLE' : (dailySetDoneCount === dailySetTotal ? 'DONE' : 'PENDING'),
            riskLevel: isDailySetHighRisk ? 'HIGH_RISK' : 'NORMAL',
            requiresManual: isDailySetHighRisk,
            hasRiskWarning: isDailySetHighRisk,
            riskBadge: isDailySetHighRisk ? '⚠️ 高风险 (需手工)' : null,
            progress: `${dailySetDoneCount}/${dailySetTotal}`,
            points: `${dailySetPts}/${dailySetCards.reduce((s, c) => s + c.points, 0)}分`,
            info: dailySetDoneCount === dailySetTotal && dailySetTotal > 0
                ? '今日已全部完成 (已达标)'
                : (isDailySetHighRisk
                    ? '⚠️ 微软风控中：高高危问答已标记【高风险】，已自动跳过执行，请在手机端手工完成！'
                    : `待完成 (${dailySetDoneCount}/${dailySetTotal})`)
        },
        promotions: {
            name: '活动与推广 (Promotions)',
            owner: 'desktop',
            source: 'rewards-web',
            status: promoTotal <= 0 ? 'UNAVAILABLE' : (promoDoneCount === promoTotal ? 'DONE' : 'PENDING'),
            progress: `${promoDoneCount}/${promoTotal}`,
            points: `${promoPts}/${promoCards.reduce((s, c) => s + c.points, 0)}分`,
            info: promoDoneCount === promoTotal && promoTotal > 0 ? '今日已全部完成' : `待完成 (${promoDoneCount}/${promoTotal})`
        },
        desktopSearch: {
            name: 'PC 桌面端搜索 (PC Search)',
            owner: 'desktop',
            source: 'rewards-web',
            status: pcQuota.complete ? 'DONE' : (pcQuota.max > 0 ? 'PENDING' : 'UNAVAILABLE'),
            progress: state.pcSearchQuota || '0/0',
            points: `${state.pcSearchQuota || '0/0'}分`,
            info: pcQuota.complete ? '今日配额已满 (跳过)' : (pcQuota.max > 0 ? '待搜索' : '官方未返回配额')
        },
        edgeBrowsing: {
            name: 'Edge 浏览 (Edge Browsing)',
            owner: 'desktop',
            source: 'rewards-web-rsc',
            status: edge.complete ? 'DONE' : (edge.available ? 'PENDING' : 'UNAVAILABLE'),
            progress: `${edge.earned}/${edge.max}${edge.unit === 'min' ? ' min' : ''}`,
            points: `${edge.earned}/${edge.max}`,
            info: edge.complete ? '今日已完成' : (edge.available ? '官方尚未确认满额；上报结束不代表任务完成' : '官方未返回状态')
        },
        punchCards: {
            name: 'Punch Cards',
            owner: 'desktop',
            source: 'rewards-web',
            status: punchCards.length <= 0 ? 'UNAVAILABLE' : (punchDone === punchCards.length ? 'DONE' : 'PENDING'),
            progress: `${punchDone}/${punchCards.length}`,
            points: `${punchEarned}/${punchMax}分`,
            info: punchCards.length <= 0 ? '官方未返回状态' : (punchDone === punchCards.length ? '今日已完成' : '待完成')
        }
    }
}

function saveState(newState) {
    const profileId = arguments[1] || null
    try {
        const current = getSavedState(profileId)
        const merged = {
            ...current,
            ...newState,
            pointsSchemaVersion: POINTS_SCHEMA_VERSION,
            updatedAt: new Date().toISOString()
        }
        merged.tasks = computeTasks(merged)
        const dailySetCards = merged.dailySetCards || []
        const promoCards = merged.promoCards || []
        const dailySetDoneCount = dailySetCards.filter(card => card.complete).length
        const promoDoneCount = promoCards.filter(card => card.complete).length
        merged.dailySetQuota = `${dailySetDoneCount}/${dailySetCards.length}`
        merged.promotionsQuota = `${promoDoneCount}/${promoCards.length}`
        merged.dailySetPending = dailySetCards.filter(card => !card.complete).length
        merged.promoPending = promoCards.filter(card => !card.complete).length
        const availableTasks = Object.values(merged.tasks).filter(task => task.status !== 'UNAVAILABLE' && task.status !== 'SKIPPED' && task.status !== 'HIGH_RISK')
        merged.allTasksDone = availableTasks.length > 0 && availableTasks.every(task => task.status === 'DONE')
        merged.isNewDay = dailySetCards.length <= 0 || merged.dailySetPending > 0
        dailySetProbeState.apply(merged.account || getSavedAccount().email, 'desktop', merged)
        const targetFile = getDailyStateFilePath(profileId)
        fs.writeFileSync(targetFile, JSON.stringify(merged, null, 2), 'utf-8')
        return merged
    } catch (e) {
        return newState
    }
}

async function fetchLiveMobileState() {
    if (!getSavedAccount().email) return null
    activeCloudReads++
    try { return await readLiveMobileState() }
    finally { activeCloudReads-- }
}

async function readLiveMobileState() {
    return new Promise((resolve) => {
        try {
            const dbPath = getSessionDbPath()
            const db = getDatabase(false)
            const activeProfile = getActiveProfile(db)
            const targetEmail = activeProfile?.email || getActiveProfileEmail(db)
            let row = null
            if (targetEmail) {
                row = db.prepare('SELECT email, storage_state FROM sessions WHERE platform = ? AND email = ? LIMIT 1').get('mobile', targetEmail)
            }
            if (!row) {
                row = db.prepare('SELECT email, storage_state FROM sessions WHERE platform = ? LIMIT 1').get('mobile')
            }
            if (!row || !row.storage_state) return resolve(null)
            const email = row.email
            if (!email) return resolve(null)
            const savedAccount = getSavedAccount()
            const resolvedRegion = db
                .prepare('SELECT resolved_region FROM account_metadata WHERE email = ? LIMIT 1')
                .get(email)?.resolved_region
            let appCountry = (activeProfile?.region && activeProfile.region !== 'AUTO')
                ? activeProfile.region
                : (savedAccount.geoLocale && savedAccount.geoLocale !== 'auto'
                    ? savedAccount.geoLocale
                    : (resolvedRegion || 'US'))
            const appLanguage = savedAccount.langCode || 'en'
            const storage = JSON.parse(row.storage_state)
            const authUrl = `https://login.live.com/oauth20_authorize.srf?response_type=code&client_id=0000000040170455&redirect_uri=https%3A%2F%2Flogin.live.com%2Foauth20_desktop.srf&scope=service%3A%3Aprod.rewardsplatform.microsoft.com%3A%3AMBI_SSL&access_type=offline_access&login_hint=${encodeURIComponent(email)}`
            const cookieHeader = sessionCookieHeader(storage.cookies, authUrl)

            const reqAuth = https.request(authUrl, {
                headers: {
                    'Cookie': cookieHeader,
                    'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1 BingSapphire/29.5.410729003'
                },
                timeout: 8000
            }, (resAuth) => {
                const loc = resAuth.headers.location || ''
                resAuth.resume()
                const match = loc.match(/[?&]code=([^&]+)/)
                if (!match) return resolve(null)
                const code = decodeURIComponent(match[1])

                const postData = new URLSearchParams({
                    grant_type: 'authorization_code',
                    client_id: '0000000040170455',
                    code: code,
                    redirect_uri: 'https://login.live.com/oauth20_desktop.srf',
                    scope: 'service::prod.rewardsplatform.microsoft.com::MBI_SSL'
                }).toString()

                const reqToken = https.request('https://login.microsoftonline.com/consumers/oauth2/v2.0/token', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/x-www-form-urlencoded',
                        'Content-Length': Buffer.byteLength(postData)
                    },
                    timeout: 8000
                }, (resToken) => {
                    let tokenData = ''
                    resToken.on('data', chunk => tokenData += chunk)
                    resToken.on('end', () => {
                        try {
                            const tokenJson = JSON.parse(tokenData)
                            const token = tokenJson.access_token
                            if (!token) return resolve(null)

                            // Bing Android Rewards mini-app loads the task payload with options=612.
                            // Profile data is requested separately with options=1; the task payload
                            // already includes the balance needed by this dashboard.
                            const reqApp = https.request('https://prod.rewardsplatform.microsoft.com/dapi/me?channel=SAAndroid&options=612', {
                                headers: buildAppHeaders(token, appCountry, appLanguage),
                                timeout: 8000
                            }, (resApp) => {
                                let appRaw = ''
                                resApp.on('data', chunk => appRaw += chunk)
                                resApp.on('end', async () => {
                                    try {
                                        const appJson = JSON.parse(appRaw)
                                        const promos = appJson.response?.promotions || []
                                        const mobileDetectedRegion = inferRegionFromPromotions(promos)
                                        if (mobileDetectedRegion && /^[A-Z]{2}$/.test(mobileDetectedRegion)) {
                                            try {
                                                db.prepare(`
                                                    INSERT INTO account_metadata (email, resolved_region, updated_at)
                                                    VALUES (?, ?, ?)
                                                    ON CONFLICT(email)
                                                    DO UPDATE SET resolved_region = excluded.resolved_region, updated_at = excluded.updated_at
                                                `).run(email, mobileDetectedRegion, Date.now())
                                            } catch (_) {}
                                        }
                                        const mobileRegion = mobileDetectedRegion || appCountry || 'US'
                                        appCountry = mobileRegion
                                        const availablePoints = pointValue(appJson.response?.balance)
                                        const appDate = resolveAppDailySetDate(promos)
                                        if (!appDate) return resolve(null)

                                        let rewardsCounters = {}
                                        try {
                                            const countersResponse = await fetch('https://prod.rewardsplatform.microsoft.com/dapi/me?channel=SAAndroid&options=2', {
                                                headers: buildAppHeaders(token, appCountry, appLanguage),
                                                signal: AbortSignal.timeout(8000)
                                            })
                                            if (countersResponse.ok) {
                                                const countersJson = await countersResponse.json()
                                                rewardsCounters = countersJson.response?.counters || {}
                                            }
                                        } catch (_) {}

                                        const todayDate = new Date()
                                        const yyyy = todayDate.getFullYear()
                                        const mm = String(todayDate.getMonth() + 1).padStart(2, '0')
                                        const dd = String(todayDate.getDate()).padStart(2, '0')
                                        const dateKey = `${yyyy}${mm}${dd}`
                                        const dailySetDateKey = appDate.replace(/(\d{2})\/(\d{2})\/(\d{4})/, '$3$1$2')
                                        let searchProgress = 0
                                        let searchMax = 0
                                        let readProgress = 0
                                        let readMax = 0
                                        let checkInDone = false
                                        let checkInEarned = 0
                                        let checkInMax = 0
                                        let streakDays = 6
                                        let streakBonus = 150
                                        let levelProgressStr = ''
                                        let accountTodayPoints = null
                                        let bingSearchDailyPoints = null
                                        let levelName = ''
                                        let thisMonth = 0
                                        let thisYear = 0
                                        const dailySetCards = []
                                        const promoCards = []
                                        const savedDesktopState = getSavedState()
                                        const hasBotWarning = Boolean(savedDesktopState?.hasBotWarning)

                                        promos.forEach(p => {
                                            const attrs = p.attributes || {}
                                            const title = attrs.title || p.name
                                            const desc = attrs.description || ''
                                            const pts = appProgressFields(attrs).max
                                            const isComplete = isAppPromotionComplete(attrs)

                                            const promotionName = String(p.name || '')

                                            if (isCurrentAppDailySetPromotion(p, appDate)) {
                                                    const hasRiskWarning = Boolean(hasBotWarning && !isComplete)
                                                    dailySetCards.push({
                                                        offerId: attrs.offerid,
                                                        requiresAppInteraction: false,
                                                        isLockedTomorrow: isTomorrowLockedTask(p),
                                                        interactionCandidate: isInteractiveDailySetDestination(p),
                                                        title,
                                                        description: desc,
                                                        points: pts || 10,
                                                        complete: isComplete,
                                                        hasRiskWarning,
                                                        riskBadge: hasRiskWarning ? '⚠️ 风控跳过' : null
                                                    })
                                            } else if (isAppMoreActivityPromotion(p)) {
                                                const max = pts
                                                const progress = isComplete
                                                    ? max
                                                    : appProgressFields(attrs).progress
                                                const isExplore = isExploreOnBingTask(p)
                                                const exploreStatus = isExplore ? getExploreOnBingStatus(p) : null
                                                promoCards.push({
                                                    offerId: attrs.offerid,
                                                    title: attrs.title || promotionName,
                                                    description: attrs.description || '',
                                                    points: max,
                                                    progress,
                                                    complete: isComplete || progress >= max,
                                                    isExploreOnBing: isExplore,
                                                    exploreStatus,
                                                    requiresAppInteraction: isAppInteractiveTask(p),
                                                    requiresManualInteraction: isManualKeepEarningTask(p),
                                                    isLockedTomorrow: isTomorrowLockedTask(p) || exploreStatus === 'tomorrow_locked',
                                                    isActivated: exploreStatus === 'activated',
                                                    destinationUrl: attrs.destination_url || attrs.destinationUrl || attrs.destination || attrs.url || ''
                                                })
                                            }

                                            if (attrs.type === 'streak' || p.name === 'Gamification_Streak_Counter_Promotion') {
                                                streakDays = Number(attrs.activity_progress || attrs.progress || streakDays)
                                            }
                                            if (p.name === 'level_info') {
                                                const lvlProg = pointValue(attrs.progress)
                                                const lvlMax = pointValue(attrs.max)
                                                levelProgressStr = `月度: ${Number(lvlProg).toLocaleString()} / ${lvlMax} (已达标)`
                                                thisMonth = lvlProg
                                                thisYear = pointValue(attrs.current_year_progress)
                                                const levelIndex = Math.max(0, Number(String(attrs.level || '').match(/\d+/)?.[0] || 1) - 1)
                                                levelName = String(attrs.level_values || '').split(';')[levelIndex] || String(attrs.level || '')
                                                if (attrs.todays_points !== undefined) {
                                                    accountTodayPoints = Math.max(0, Number(attrs.todays_points) || 0)
                                                }
                                                if (attrs.bing_search_daily_points !== undefined) {
                                                    bingSearchDailyPoints = Math.max(0, Number(attrs.bing_search_daily_points) || 0)
                                                }
                                            }
                                        })

                                        const activeRead = promos.find(p => String(p.attributes?.type || '').toLowerCase() === 'msnreadearn')
                                        if (activeRead) {
                                            readProgress = appProgressFields(activeRead.attributes).progress
                                            readMax = appProgressFields(activeRead.attributes).max
                                        }
                                        const activeSearch = selectAppSearchPromotion(promos)
                                        if (activeSearch) {
                                            const attrs = activeSearch.attributes || {}
                                            searchMax = appProgressFields(attrs).max
                                            searchProgress = appProgressFields(attrs).progress
                                        }

                                        const bonusPromoCards = promoCards.map(card => ({ ...card }))
                                        const additionalTaskSections = discoverAdditionalAppTaskSections(promos)

                                        const moreActivitiesEarned = promoCards.reduce(
                                            (sum, card) => sum + (
                                                card.requiresAppInteraction
                                                    ? 0
                                                    : Math.min(card.points, card.complete ? card.points : card.progress)
                                            ),
                                            0
                                        )
                                        const moreActivitiesMax = promoCards.reduce((sum, card) => sum + card.points, 0)

                                        const dailySetEarned = dailySetCards.reduce((sum, card) => sum + (card.complete ? card.points : 0), 0)
                                        const dailySetMax = dailySetCards.reduce((sum, card) => sum + card.points, 0)

                                        const sapphireDateKey = rewardsCounters?.[`DailyCheckIn_Sapphire${dailySetDateKey}`]
                                            ? dailySetDateKey
                                            : (rewardsCounters?.[`DailyCheckIn_Sapphire${dateKey}`] ? dateKey : (dailySetDateKey || dateKey))
                                        const bingDateKey = rewardsCounters?.[`DailyCheckIn_Bing_ClaimingFlight${dailySetDateKey}`]
                                            ? dailySetDateKey
                                            : (rewardsCounters?.[`DailyCheckIn_Bing_ClaimingFlight${dateKey}`] ? dateKey : (dailySetDateKey || dateKey))
                                        const sapphireCheckIn = buildCheckInState(
                                            rewardsCounters,
                                            'DailyCheckIn_Sapphire',
                                            sapphireDateKey,
                                            [5, 5, 10, 10, 15, 15, 50]
                                        )
                                        const bingCheckIn = buildCheckInState(
                                            rewardsCounters,
                                            'DailyCheckIn_Bing_ClaimingFlight',
                                            bingDateKey,
                                            [3, 3, 3, 3, 3, 3, 100]
                                        )
                                        const dailySetCheckIn = buildCheckInState(
                                            rewardsCounters,
                                            'DailyCheckIn_DailySet',
                                            dailySetDateKey,
                                            [30, 30, 30, 30, 30, 30, 100]
                                        )
                                        const bingCompletion = parseRewardsCounter(
                                            rewardsCounters[`DailyCheckIn_Bing_CompletionCheck${bingDateKey}`] ||
                                            rewardsCounters[`DailyCheckIn_Bing_CompletionCheck${dateKey}`]
                                        )
                                        bingCheckIn.todayProgress = bingCompletion ? 1 : 0
                                        bingCheckIn.todayMax = 1
                                        dailySetCheckIn.todayProgress = dailySetCards.filter(card => card.complete).length
                                        dailySetCheckIn.todayMax = dailySetCards.length
                                        const puzzleProgress = parseRewardsCounter(
                                            rewardsCounters.DailyCheckIn_Parent_PuzzleOffer
                                        )?.activity || 0
                                        const counterStreak = parseRewardsCounter(rewardsCounters.Gamification_Streak)?.activity
                                        if (counterStreak) streakDays = counterStreak
                                        checkInDone = sapphireCheckIn.done
                                        checkInEarned = sapphireCheckIn.earned
                                        checkInMax = sapphireCheckIn.reward
                                        // This mirrors the score refactor in the Bing Android mini-app:
                                        // earned/max = Daily set + Search to earn + Read to earn.
                                        // Check-in, streak rewards and More activities are intentionally
                                        // excluded from the "Today's points" card.
                                        const mobileTaskEarned = dailySetEarned + searchProgress + readProgress
                                        const mobileTaskMax = dailySetMax + searchMax + readMax
                                        const todayEarned = mobileTaskEarned
                                        const todayMax = mobileTaskMax
                                        const mobileTasks = {
                                            appSearch: {
                                                owner: 'mobile', source: 'saandroid', earned: searchProgress, max: searchMax,
                                                status: searchMax <= 0 ? 'UNAVAILABLE' : (searchProgress >= searchMax ? 'DONE' : 'PENDING')
                                            },
                                            readToEarn: {
                                                owner: 'mobile', source: 'saandroid', earned: readProgress, max: readMax,
                                                status: readMax <= 0 ? 'UNAVAILABLE' : (readProgress >= readMax ? 'DONE' : 'PENDING')
                                            },
                                            sapphireCheckIn: {
                                                owner: 'mobile', source: 'saandroid-counters', earned: checkInDone ? 1 : 0, max: 1,
                                                status: checkInDone ? 'DONE' : 'PENDING'
                                            },
                                            appPromotions: {
                                                owner: 'mobile', source: 'saandroid', earned: moreActivitiesEarned, max: moreActivitiesMax,
                                                status: moreActivitiesMax <= 0 ? 'UNAVAILABLE' : (moreActivitiesEarned >= moreActivitiesMax ? 'DONE' : 'PENDING')
                                            },
                                            dailySet: {
                                                owner: 'shared-account', source: 'saandroid', earned: dailySetEarned, max: dailySetMax,
                                                status: dailySetMax <= 0 ? 'UNAVAILABLE' : (dailySetEarned >= dailySetMax ? 'DONE' : 'PENDING')
                                            }
                                        }

                                        const state = {
                                            account: email,
                                            platform: 'mobile',
                                            channel: 'SAAndroid',
                                            totalPoints: availablePoints,
                                            todayEarned,
                                            todayMax,
                                            officialAppTodayEarned: mobileTaskEarned,
                                            accountTodayPoints,
                                            levelInfoTodayPoints: accountTodayPoints,
                                            todayPointsFormula: 'daily-set+active-search+read-to-earn',
                                            bingSearchDailyPoints,
                                            mobileTaskEarned,
                                            mobileTaskMax,
                                            mobileSearch: `${searchProgress}/${searchMax}`,
                                            searchScope: 'saandroid-active-offer',
                                            mobileSearchProgress: searchProgress,
                                            mobileSearchMax: searchMax,
                                            readToEarn: `${readProgress}/${readMax}`,
                                            readToEarnProgress: readProgress,
                                            readToEarnMax: readMax,
                                            readToEarnDone: readProgress >= readMax,
                                            checkIn: `${checkInDone ? `1/1 已签到 (${checkInEarned}分)` : `0/1 今日待签到 (${checkInMax}分)`}`,
                                            checkInDone,
                                            checkInEarned,
                                            checkInMax,
                                            streak: streakDays,
                                            puzzlePieces: `${puzzleProgress}/12`,
                                            puzzleProgress,
                                            puzzleMax: 12,
                                            level: levelName,
                                            thisMonth,
                                            thisYear,
                                            levelProgress: levelProgressStr,
                                            streakBonus: streakBonus,
                                            appStreak: `🔥 ${streakDays}`,
                                            dailySetDate: appDate,
                                            taskRefresh: { source: 'saandroid', accountDate: appDate, nextResetAt: computeRegionNextResetAt(appCountry) },
                                            dailySetCards,
                                            promoCards,
                                            bonusPromoCards,
                                            additionalTaskSections,
                                            sapphireCheckIn,
                                            bingCheckIn,
                                            dailySetCheckIn,
                                            moreActivitiesEarned,
                                            moreActivitiesMax,
                                            appOffers: `${moreActivitiesEarned}/${moreActivitiesMax} 完成`,
                                            tasks: mobileTasks,
                                            syncSource: 'saandroid',
                                            syncedAt: new Date().toISOString(),
                                            region: appCountry,
                                            pointsSchemaVersion: POINTS_SCHEMA_VERSION,
                                            updatedAt: new Date().toISOString()
                                        }

                                        resolve(state)
                                    } catch (e) { resolve(null) }
                                })
                            })
                            reqApp.on('error', () => resolve(null))
                            reqApp.on('timeout', () => { reqApp.destroy(); resolve(null) })
                            reqApp.end()
                        } catch (e) { resolve(null) }
                    })
                })
                reqToken.on('error', () => resolve(null))
                reqToken.on('timeout', () => { reqToken.destroy(); resolve(null) })
                reqToken.write(postData)
                reqToken.end()
            })
            reqAuth.on('error', () => resolve(null))
            reqAuth.on('timeout', () => { reqAuth.destroy(); resolve(null) })
            reqAuth.end()
        } catch (e) { resolve(null) }
    })
}

function getSavedMobileState(profileId = null) {
    const targetFile = getMobileStateFilePath(profileId)
    try {
        if (fs.existsSync(targetFile)) {
            const raw = fs.readFileSync(targetFile, 'utf-8')
            const state = JSON.parse(raw)
            if (state.pointsSchemaVersion !== POINTS_SCHEMA_VERSION) {
                state.todayEarned = 0
                state.todayMax = 0
                state.mobileSearch = '0/0'
                state.mobileSearchProgress = 0
                state.mobileSearchMax = 0
                state.readToEarn = '0/0'
                state.readToEarnProgress = 0
                state.readToEarnMax = 0
            }
            const today = new Date().toISOString().slice(0, 10)
            const stateDate = normalizeDate(state.currentDate || state.dailySetDate || state.taskRefresh?.accountDate || state.syncedAt || state.updatedAt)
            if (stateDate && stateDate !== today) {
                state.isNewDay = true
                state.currentDate = today
                state.dailySetDate = `${today.slice(5, 7)}/${today.slice(8, 10)}/${today.slice(0, 4)}`
                if (state.taskRefresh) {
                    state.taskRefresh.accountDate = state.dailySetDate
                }
                state.todayEarned = 0
                state.officialAppTodayEarned = 0
                state.accountTodayPoints = 0
                state.levelInfoTodayPoints = 0
                state.mobileTaskEarned = 0
                state.mobileSearchProgress = 0
                state.mobileSearch = `0/${state.mobileSearchMax || 200}`
                state.readToEarnProgress = 0
                state.readToEarnDone = false
                state.readToEarn = `0/${state.readToEarnMax || 30}`
                state.checkInDone = false
                state.checkInEarned = 0
                state.checkIn = `0/1 今日待签到 (${state.checkInMax || 5}分)`
                state.allTasksDone = false
                if (Array.isArray(state.dailySetCards)) {
                    state.dailySetCards = state.dailySetCards.map(c => ({ ...c, complete: false, entryProbeResult: null }))
                }
                try {
                    fs.writeFileSync(targetFile, JSON.stringify(state, null, 2), 'utf-8')
                } catch (_) {}
            }
            const inferred = inferRegionFromPromotions([...(state.dailySetCards || []), ...(state.promoCards || []), ...(state.bonusPromoCards || [])])
            if (inferred) {
                state.region = inferred
            } else {
                state.region = state.region || getResolvedAccountRegion(state.account)
            }
            if (state.region) {
                if (!state.taskRefresh) {
                    state.taskRefresh = {
                        source: 'saandroid',
                        accountDate: state.dailySetDate || null,
                        nextResetAt: computeRegionNextResetAt(state.region)
                    }
                } else {
                    state.taskRefresh.nextResetAt = computeRegionNextResetAt(state.region)
                }
            }
            return dailySetProbeState.apply(state.account || getSavedAccount().email, 'mobile', state)
        }
    } catch (e) {}
    const defaultMobileRegion = getResolvedAccountRegion()
    return {
        account: '',
        region: defaultMobileRegion,
        taskRefresh: {
            source: 'saandroid',
            accountDate: null,
            nextResetAt: computeRegionNextResetAt(defaultMobileRegion)
        },
        platform: 'mobile',
        channel: 'SAAndroid',
        totalPoints: 0,
        todayEarned: 0,
        todayMax: 0,
        mobileSearch: '0/0',
        mobileSearchProgress: 0,
        mobileSearchMax: 0,
        readToEarn: '0/0',
        readToEarnProgress: 0,
        readToEarnMax: 0,
        readToEarnDone: false,
        checkIn: '0/1 待签到',
        checkInDone: false,
        streak: 0,
        appOffers: '0/0',
        pointsSchemaVersion: POINTS_SCHEMA_VERSION
    }
}

function saveMobileState(newState, profileId = null) {
    try {
        const current = getSavedMobileState(profileId)
        const merged = {
            ...current,
            ...newState,
            pointsSchemaVersion: POINTS_SCHEMA_VERSION,
            updatedAt: new Date().toISOString()
        }
        dailySetProbeState.apply(merged.account || getSavedAccount().email, 'mobile', merged)
        const targetFile = getMobileStateFilePath(profileId)
        fs.writeFileSync(targetFile, JSON.stringify(merged, null, 2), 'utf-8')
        return merged
    } catch (e) {
        return newState
    }
}

function getTimeStr() {
    const now = new Date()
    return now.toTimeString().split(' ')[0]
}

function broadcastTaskStatus(platform, taskId, status, detail = '', itemId = '') {
    broadcast({ type: 'taskStatus', platform, taskId, status, detail, itemId, time: getTimeStr() })
}

function snapshotTaskStatus(state, taskId) {
    return state?.tasks?.[taskId]?.status || 'UNAVAILABLE'
}

function inferTaskIdsFromLog(platform, line) {
    const value = line.toLowerCase()
    const matches = []
    const rules = platform === 'mobile'
        ? [
            ['dailySet', ['mobile-daily-set', 'daily-set']],
            ['readToEarn', ['read-to-earn', 'read to earn']],
            ['sapphireCheckIn', ['daily-check-in', 'check-in', 'check in']],
            ['appPromotions', ['app-promotions', 'app-reward', 'promotion']],
            ['appSearch', ['search-bing', 'search-manager', 'search query']]
        ]
        : [
            ['edgeBrowsing', ['edge-browsing', 'edge browsing']],
            ['dailySet', ['daily-set', 'daily set']],
            ['promotions', ['more-promotions', 'promotion']],
            ['punchCards', ['punchcard', 'punch card']],
            ['desktopSearch', ['search-bing', 'search-manager', 'search query']]
        ]
    for (const [taskId, needles] of rules) {
        if (needles.some(needle => value.includes(needle))) matches.push(taskId)
    }
    return matches
}

function extractOfferIdFromLog(line) {
    return line.match(/\bofferId=([^\s|]+)/i)?.[1] || ''
}

function recordTaskLifecycle(platform, line) {
    if (platform === 'shared') platform = 'desktop'
    if (platform !== activeRunPlatform) return
    const probe = dailySetProbeState.record(activeProbeAccount, platform, line)
    if (probe && activeRunTaskIds.has('dailySet')) {
        broadcastTaskStatus(platform, 'dailySet', probe.result === 'complete' ? 'DONE' :
            (probe.result === 'pending' ? 'RUNNING' : 'PENDING'), `entry_probe_${probe.result}`, probe.offer)
        return
    }
    const inferred = inferTaskIdsFromLog(platform, line)
    if (!inferred.length) return
    const itemId = extractOfferIdFromLog(line)
    const isDone = /\bskip_complete\b|completion verified by saandroid|daily check-in verified by today's saandroid counter|completed read to earn|completed bing searches/i.test(line)
    const isFinishedPending = /finished processing "app promotions" items|Edge reporting ended; official Web verification/i.test(line)
    const isStarting = /\b(run_pending|starting|started|opening verified|submitting current)\b/i.test(line)
    if (!isDone && !isFinishedPending && !isStarting) return

    for (const taskId of inferred) {
        if (!activeRunTaskIds.has(taskId) || activeRunErrors.has(taskId)) continue
        broadcastTaskStatus(
            platform,
            taskId,
            isDone ? 'DONE' : (isFinishedPending ? 'PENDING' : 'RUNNING'),
            line.replace(/^.*?\]\s*/, '').slice(0, 240),
            taskId === 'dailySet' ? itemId : ''
        )
    }
}

function isTaskFailureLog(line) {
    const value = line.toLowerCase().replace(/\bfailed\s*=\s*0\b/g, '')
    return /\b(error|failed|failure|unable|unavailable)\b|no progress|not complete|无法|异常|失败/.test(value)
}

function recordTaskFailure(platform, line) {
    if (platform === 'shared') platform = 'desktop'
    if (platform !== activeRunPlatform) return
    if (!isTaskFailureLog(line)) return
    const inferred = inferTaskIdsFromLog(platform, line)
    if (!inferred.length) return
    const itemId = extractOfferIdFromLog(line)
    for (const taskId of inferred) {
        if (!activeRunTaskIds.has(taskId)) continue
        if (!(taskId === 'dailySet' && itemId)) activeRunErrors.add(taskId)
        broadcastTaskStatus(
            platform,
            taskId,
            'ERROR',
            line.replace(/^.*?\]\s*/, '').slice(0, 240),
            taskId === 'dailySet' ? itemId : ''
        )
    }
}

function broadcastExecutionPlan(mode, state) {
    const platform = mode === 'mobile' ? 'mobile' : 'desktop'
    const config = getSavedConfig()
    const workers = config.workers || {}
    const plans = mode === 'mobile'
        ? [
            ['appSearch', state.mobileSearchProgress, state.mobileSearchMax, null, workers.doMobileSearch],
            ['readToEarn', state.readToEarnProgress, state.readToEarnMax, null, workers.doReadToEarn],
            ['sapphireCheckIn', state.checkInDone ? 1 : 0, 1, null, workers.doDailyCheckIn],
            ['appPromotions', state.moreActivitiesEarned, state.moreActivitiesMax, null, workers.doAppPromotions],
            ['dailySet', state.tasks?.dailySet?.earned, state.tasks?.dailySet?.max, state.tasks?.dailySet?.status, workers.doDailySet]
        ]
        : Object.entries(state.tasks || {}).map(([id, task]) => {
            const enabled = {
                dailySet: workers.doDailySet,
                promotions: workers.doMorePromotions,
                desktopSearch: workers.doDesktopSearch,
                edgeBrowsing: config.experimental?.edgeBrowsing,
                punchCards: workers.doPunchCards
            }[id]
            return [id, parseQuota(task.progress).earned, parseQuota(task.progress).max, task.status, enabled]
        })

    broadcast({
        type: 'log',
        platform,
        time: getTimeStr(),
        msg: `[PREFLIGHT] source=${state.syncSource || 'unknown'} syncedAt=${state.syncedAt || state.updatedAt || 'unknown'}`,
        level: 'highlight'
    })
    plannedTaskIds[platform] = []
    for (const [id, earnedValue, maxValue, explicitStatus, enabled] of plans) {
        const earned = Number(earnedValue) || 0
        const max = Number(maxValue) || 0
        const isSkippedDueToRisk = explicitStatus === 'SKIPPED' || explicitStatus === 'HIGH_RISK'
        const status = isSkippedDueToRisk
            ? 'skip_high_risk'
            : (enabled === false
                ? 'skip_disabled'
                : (explicitStatus === 'UNAVAILABLE' || max <= 0
                    ? 'skip_state_unavailable'
                    : (explicitStatus === 'DONE' || earned >= max ? 'skip_complete' : 'run_pending')))
        broadcast({
            type: 'log',
            platform,
            time: getTimeStr(),
            msg: `[PLAN] ${id} ${status} progress=${earned}/${max}${isSkippedDueToRisk ? ' (⚠️ 微软风控中，高高危任务已标记【高风险】并自动跳过，需手工执行)' : ''}`,
            level: status === 'run_pending' ? 'info' : (isSkippedDueToRisk ? 'warn' : 'success')
        })
        const uiStatus = status === 'run_pending'
            ? 'PENDING'
            : (status === 'skip_complete'
                ? 'DONE'
                : (status === 'skip_high_risk'
                    ? 'HIGH_RISK'
                    : (status === 'skip_disabled' ? 'DISABLED' : 'UNAVAILABLE')))
        broadcastTaskStatus(platform, id, uiStatus, isSkippedDueToRisk ? '⚠️ 微软风控高风险任务，已自动跳过，需在手机端手工执行' : `progress=${earned}/${max}`)
        if (status === 'run_pending') plannedTaskIds[platform].push(id)
    }
}

function resolveFinalTaskStatus(officialStatus, stopped, hasError, exitCode) {
    if (officialStatus === 'DONE') return 'DONE'
    if (officialStatus === 'HIGH_RISK') return 'HIGH_RISK'
    if (officialStatus === 'SKIPPED') return 'SKIPPED'
    if (stopped) return 'PENDING'
    if (hasError || exitCode !== 0) return 'ERROR'
    return officialStatus
}

function runBotProcess(mode = 'all', preflightState = null) {
    let activeProf = null
    try {
        const db = getDatabase(false)
        activeProf = getActiveProfile(db)
        db.close()
    } catch (_) {}
    const activeEmail = activeProf?.email || getSavedAccount().email
    activeProbeAccount = activeEmail
    if (activeBotProcess) {
        if (mode === 'login') {
            try { activeBotProcess.kill('SIGKILL') } catch (_) {}
            activeBotProcess = null
        } else {
            return
        }
    }
    broadcast({ type: 'runState', platform: mode, running: true })
    if (preflightState) broadcastExecutionPlan(mode, preflightState)

    let activeBotMode = mode
    activeRunPlatform = mode === 'mobile' ? 'mobile' : ((mode === 'desktop' || mode === 'shared') ? 'desktop' : null)
    activeRunStopped = false
    activeRunErrors = new Set()
    activeRunTaskIds = new Set(activeRunPlatform ? plannedTaskIds[activeRunPlatform] : [])
    const modeMsg = mode === 'mobile'
        ? '📱 启动【手机端专属自动化任务流】(Mobile 搜索 / Read to Earn 新闻 / 每日签到 / Sapphire 特权)...'
        : (mode === 'login'
            ? '🔐 启动【微软官方窗口登录】(请在弹出的官方浏览器窗口中直接登录您的微软账号)...'
        : (mode === 'desktop'
            ? '💻 启动【桌面端专用自动化任务流】(PC 搜索 / Daily Set / Keep earning / Edge 浏览)...'
        : (mode === 'shared'
            ? '🌐 启动【公共任务流 (PC微内核)】(Daily Set 每日任务 / Keep Earning 推广卡 / 趣味打卡)...'
            : '🚀 启动【全量统一任务流】(公共微内核 + PC搜索 + 移动专属)...')))

    broadcast({ type: 'log', platform: mode, time: getTimeStr(), msg: modeMsg, level: 'highlight' })
    broadcast({ type: 'action', platform: mode, action: mode === 'login' ? '请在弹出的微软官方窗口中完成登录...' : '正在连接微软云端拉取今日最新任务...' })
    const scriptToRun = mode === 'login' ? 'scripts/main/interactiveLogin.mjs' : 'dist/index.js'
    const cleanEnv = { ...process.env }
    Object.keys(cleanEnv).forEach(k => {
        if (/^ACCOUNT_([2-9]\d*)_/.test(k)) {
            delete cleanEnv[k]
        }
    })

    activeBotProcess = spawn('node', [scriptToRun], {
        cwd: __dirname,
        env: {
            ...cleanEnv,
            FORCE_COLOR: '0',
            REWARDS_MODE: mode,
            REWARDS_DAILY_SET_DATE: preflightState?.dailySetDate || '',
            ACCOUNT_1_EMAIL: activeEmail || '',
            REWARDS_ACTIVE_PROFILE_EMAIL: activeEmail || '',
            REWARDS_ACTIVE_PROFILE_ID: activeProf?.id || 'profile_default',
            REWARDS_ACTIVE_PROFILE_REGION: activeProf?.region || 'US'
        }
    })

    const liveSync = createLiveRunSync({
        refresh: async () => {
            const live = mode === 'mobile' ? await fetchLiveMobileState() : await fetchLiveMicrosoftState()
            if (!live && mode !== 'all') throw new Error('cloud_unavailable')
            const state = mode === 'mobile' ? saveMobileState(live) : saveState(live)
            broadcast({ type: mode === 'mobile' ? 'mobileState' : 'state', platform: mode, data: state })
            if (mode === 'all') {
                const liveMb = await fetchLiveMobileState().catch(() => null)
                if (liveMb) {
                    const mbState = saveMobileState(liveMb)
                    broadcast({ type: 'mobileState', platform: 'mobile', data: mbState })
                }
            }
        },
        onError: () => broadcast({ type: 'log', platform: mode, time: getTimeStr(),
            msg: '⚠️ 运行中积分同步失败，保留上次数据；任务继续，稍后自动重试。', level: 'warn' })
    })
    const liveSyncHeartbeat = (mode === 'desktop' || mode === 'mobile' || mode === 'shared' || mode === 'all')
        ? setInterval(() => liveSync.request(), 60000) : null

    activeBotProcess.stdout.on('data', (chunk) => {
        const text = chunk.toString()
        const lines = text.split('\n').filter(Boolean)
        for (const line of lines) {
            if ((mode === 'desktop' || mode === 'mobile' || mode === 'shared' || mode === 'all') && shouldRefreshRun(line)) liveSync.request()
            recordTaskLifecycle(mode, line)
            recordTaskFailure(mode, line)

            // Check HITL Bot Challenge
            if (line.includes('HITL-BOT-CHALLENGE') || line.includes('Fraud_UserWarning_BotScore_UX')) {
                const alertData = {
                    type: 'bot_challenge_alert',
                    level: 'warn',
                    title: '⚠️ 触发微软人机安全质询 (BotScore / 拼图验证)',
                    content: '检测到微软官方风控标记 (Fraud_UserWarning_BotScore_UX)。自动化程序已主动挂起高危批量搜索以保全账号，保留日常签到与打卡等轻量任务。建议立即前往官方页面完成拼图验证或日常搜索破冰。',
                    actionUrl: 'https://rewards.bing.com',
                    actionLabel: '前往官方页面破冰',
                    timestamp: Date.now()
                }
                latestBotChallengeAlert = alertData
                broadcast({ type: 'botChallengeAlert', platform: mode, data: alertData })
                dispatchHitlWebhookAlert(alertData)
            }
            // Check breakdown
            const breakdownMatch = line.match(/POINTS-BREAKDOWN\]\s+(\{.*\})/)
            if (breakdownMatch) {
                try {
                    JSON.parse(breakdownMatch[1])
                } catch (e) {}
            }

            // Check discovery
            const discMatch = line.match(/TASK-DISCOVERY\]\s+(\{.*\})/)
            if (discMatch && mode !== 'mobile') {
                try {
                    const data = JSON.parse(discMatch[1])
                    broadcast({ type: 'log', platform: mode, time: getTimeStr(), msg: `🔍 探查发现今日待做: Daily Set ${data.dailySetPending}项, 推广活动 ${data.promoPending}项`, level: 'highlight' })
                } catch (e) {}
            }

            // Check flow / points collected
            const flowMatch = line.match(/Points collected\s+\|\s+pointsGained=(\d+)\s+\|\s+currentBalance=(\d+)/) || line.match(/ACCOUNT-END.*currentBalance=(\d+)/)
            if (flowMatch && mode !== 'mobile') {
                if (mode === 'desktop' || mode === 'shared' || mode === 'all') liveSync.request()
            }

            // Check current action / search
            const queryMatch = line.match(/Search query:\s+(.+)/)
            if (queryMatch) {
                broadcast({ type: 'action', platform: mode, action: `搜索: "${queryMatch[1]}"` })
                broadcast({ type: 'log', platform: mode, time: getTimeStr(), msg: `🔍 正在必应搜索: "${queryMatch[1]}"` })
            }

            // Check countdown
            const sleepMatch = line.match(/Sleeping for (\d+)ms/)
            if (sleepMatch) {
                const sec = Math.ceil(parseInt(sleepMatch[1], 10) / 1000)
                broadcast({ type: 'countdown', platform: mode, sec })
            }

            // Normal info log
            if (line.includes('[INFO]')) {
                const clean = line.replace(/^.*\[INFO\]\s*/, '')
                broadcast({ type: 'log', platform: mode, time: getTimeStr(), msg: clean })
            } else if (line.includes('[ERROR]')) {
                const clean = line.replace(/^.*\[ERROR\]\s*/, '')
                broadcast({ type: 'log', platform: mode, time: getTimeStr(), msg: clean, level: 'err' })
            } else if (line.includes('[WARN]')) {
                const clean = line.replace(/^.*\[WARN\]\s*/, '')
                broadcast({ type: 'log', platform: mode, time: getTimeStr(), msg: clean, level: 'warn' })
            } else if (line.trim().length > 0) {
                broadcast({ type: 'log', platform: mode, time: getTimeStr(), msg: line.trim() })
            }
        }
    })

    activeBotProcess.stderr.on('data', (chunk) => {
        const text = chunk.toString()
        const lines = text.split('\n').filter(Boolean)
        for (const line of lines) {
            recordTaskFailure(mode, line)
            broadcast({ type: 'log', platform: mode, time: getTimeStr(), msg: line, level: 'err' })
        }
    })

    activeBotProcess.on('close', async (code) => {
        if (liveSyncHeartbeat) clearInterval(liveSyncHeartbeat)
        await liveSync.stop()
        let refreshed = null
        let normalized = null
        try {
            refreshed = mode === 'mobile' ? await fetchLiveMobileState() : await fetchLiveMicrosoftState()
            if (refreshed) {
                normalized = mode === 'mobile' ? saveMobileState(refreshed) : saveState(refreshed)
                broadcast({ type: mode === 'mobile' ? 'mobileState' : 'state', platform: mode, data: normalized })
            }
            if (mode === 'all') {
                const refreshedMb = await fetchLiveMobileState().catch(() => null)
                if (refreshedMb) {
                    const normMb = saveMobileState(refreshedMb)
                    broadcast({ type: 'mobileState', platform: 'mobile', data: normMb })
                }
            }
        } catch (_) {}
        if (activeRunPlatform) {
            for (const taskId of activeRunTaskIds) {
                const officialStatus = snapshotTaskStatus(normalized, taskId)
                const finalStatus = resolveFinalTaskStatus(
                    officialStatus,
                    activeRunStopped,
                    activeRunErrors.has(taskId),
                    code
                )
                broadcastTaskStatus(activeRunPlatform, taskId, finalStatus)
                if (taskId === 'dailySet' && Array.isArray(normalized?.dailySetCards)) {
                    for (const card of normalized.dailySetCards) {
                        const cardId = card.offerId || card.name || ''
                        if (cardId) {
                            broadcastTaskStatus(
                                activeRunPlatform,
                                'dailySet',
                                card.complete ? 'DONE' : (finalStatus === 'ERROR' ? 'ERROR' : 'PENDING'),
                                '',
                                cardId
                            )
                        }
                    }
                }
            }
        }
        broadcast({ type: 'log', platform: mode, time: getTimeStr(), msg: `🏁 任务会话结束 (状态码: ${code})`, level: 'success' })
        broadcast({ type: 'action', platform: mode, action: '今日自动化完成' })
        activeBotProcess = null
        broadcast({ type: 'finished', platform: mode, code })
        activeRunPlatform = null
        activeRunStopped = false
        activeRunTaskIds = new Set()
        activeRunErrors = new Set()
    })
}

function stopBotProcess() {
    if (activeBotProcess) {
        activeRunStopped = true
        activeBotProcess.kill('SIGINT')
        broadcast({ type: 'log', platform: 'desktop', time: getTimeStr(), msg: '🛑 任务已由用户手动停止', level: 'warn' })
        broadcast({ type: 'log', platform: 'mobile', time: getTimeStr(), msg: '🛑 任务已由用户手动停止', level: 'warn' })
        broadcast({ type: 'log', platform: 'all', time: getTimeStr(), msg: '🛑 任务已由用户手动停止', level: 'warn' })
        broadcast({ type: 'log', platform: 'shared', time: getTimeStr(), msg: '🛑 任务已由用户手动停止', level: 'warn' })
        broadcast({ type: 'action', platform: 'desktop', action: '已停止' })
        broadcast({ type: 'action', platform: 'mobile', action: '已停止' })
        broadcast({ type: 'action', platform: 'all', action: '已停止' })
        broadcast({ type: 'action', platform: 'shared', action: '已停止' })
    }
}

async function runScheduledSync() {
    if (activeBotProcess || scheduledSyncRunning) return { skipped: true, success: false }
    scheduledSyncRunning = true
    try {
        const [desktopResult, mobileResult] = await Promise.allSettled([
            fetchLiveMicrosoftState(),
            fetchLiveMobileState()
        ])
        const desktopSucceeded = desktopResult.status === 'fulfilled' && Boolean(desktopResult.value)
        const mobileSucceeded = mobileResult.status === 'fulfilled' && Boolean(mobileResult.value)
        if (desktopSucceeded) {
            const desktopState = saveState(desktopResult.value)
            broadcast({ type: 'state', platform: 'desktop', data: desktopState })
        }
        if (mobileSucceeded) {
            const mobileState = saveMobileState(mobileResult.value)
            broadcast({ type: 'mobileState', platform: 'mobile', data: mobileState })
        }
        return { skipped: false, success: desktopSucceeded && mobileSucceeded }
    } finally {
        scheduledSyncRunning = false
    }
}

function nextBackgroundSyncDelay(result) {
    if (result?.skipped) return BACKGROUND_SYNC_BUSY_RETRY_MS
    if (result?.success) {
        scheduledSyncFailureIndex = 0
        return BACKGROUND_SYNC_INTERVAL_MS
    }
    const delay = BACKGROUND_SYNC_FAILURE_DELAYS_MS[
        Math.min(scheduledSyncFailureIndex, BACKGROUND_SYNC_FAILURE_DELAYS_MS.length - 1)
    ]
    scheduledSyncFailureIndex += 1
    return delay
}

function scheduleBackgroundSync(delay = BACKGROUND_SYNC_INTERVAL_MS) {
    if (scheduledSyncTimer) clearTimeout(scheduledSyncTimer)
    scheduledSyncTimer = setTimeout(async () => {
        let result
        try {
            result = await runScheduledSync()
        } catch (_) {
            result = { skipped: false, success: false }
        }
        scheduleBackgroundSync(nextBackgroundSyncDelay(result))
    }, delay)
}

function claimManualSync(platform, silent = false, now = Date.now()) {
    if (silent) return 0
    const elapsed = now - lastManualSyncAt[platform]
    if (elapsed < MANUAL_SYNC_COOLDOWN_MS) {
        return Math.ceil((MANUAL_SYNC_COOLDOWN_MS - elapsed) / 1000)
    }
    lastManualSyncAt[platform] = now
    return 0
}

function readRequestBody(req, res, { maxSize = 1024 * 1024, timeoutMs = 10000 } = {}) {
    return new Promise((resolve, reject) => {
        let body = ''
        let received = 0
        let settled = false

        const timer = setTimeout(() => {
            if (settled) return
            settled = true
            if (typeof req.pause === 'function') req.pause()
            if (res && !res.headersSent) {
                res.writeHead(408, {
                    'Content-Type': 'application/json',
                    'Connection': 'close'
                })
                res.end(JSON.stringify({ success: false, error: 'request_timeout' }), () => {
                    req.destroy()
                })
            } else {
                req.destroy()
            }
            reject(new Error('request_timeout'))
        }, timeoutMs)

        req.on('data', chunk => {
            if (settled) return
            received += chunk.length
            if (received > maxSize) {
                settled = true
                clearTimeout(timer)
                if (typeof req.pause === 'function') req.pause()
                if (res && !res.headersSent) {
                    res.writeHead(413, {
                        'Content-Type': 'application/json',
                        'Connection': 'close'
                    })
                    res.end(JSON.stringify({ success: false, error: 'payload_too_large' }), () => {
                        req.destroy()
                    })
                } else {
                    req.destroy()
                }
                reject(new Error('payload_too_large'))
                return
            }
            body += chunk
        })

        req.on('end', () => {
            if (settled) return
            settled = true
            clearTimeout(timer)
            resolve(body)
        })

        req.on('error', err => {
            if (settled) return
            settled = true
            clearTimeout(timer)
            reject(err)
        })
    })
}

function renderPairingPage(errorMessage = '', { isServerError = false } = {}) {
    const errorClass = isServerError ? 'error-banner server-error' : 'error-banner'
    const safeError = errorMessage ? `<div class="${errorClass}">${errorMessage.replace(/[<>&"']/g, '')}</div>` : ''
    const submitDisabled = isServerError ? 'disabled style="opacity: 0.5; cursor: not-allowed;"' : ''
    return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>控制台设备安全配对 - Microsoft Rewards</title>
    <style>
        :root {
            --bg: #0f172a;
            --card-bg: rgba(30, 41, 59, 0.85);
            --border: rgba(255, 255, 255, 0.1);
            --text-main: #f8fafc;
            --text-sub: #94a3b8;
            --accent: #38bdf8;
            --accent-hover: #0ea5e9;
            --error-bg: rgba(239, 68, 68, 0.15);
            --error-border: rgba(239, 68, 68, 0.3);
            --error-text: #fca5a5;
        }
        * { box-sizing: border-box; margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }
        body {
            min-height: 100vh;
            display: flex;
            align-items: center;
            justify-content: center;
            background: radial-gradient(circle at 50% 20%, #1e293b, var(--bg));
            color: var(--text-main);
            padding: 20px;
        }
        .card {
            width: 100%;
            max-width: 480px;
            background: var(--card-bg);
            border: 1px solid var(--border);
            border-radius: 16px;
            padding: 32px;
            backdrop-filter: blur(12px);
            box-shadow: 0 20px 40px rgba(0, 0, 0, 0.4);
        }
        .icon { font-size: 40px; margin-bottom: 16px; text-align: center; }
        h1 { font-size: 20px; font-weight: 600; text-align: center; margin-bottom: 8px; }
        p.desc { font-size: 13px; color: var(--text-sub); text-align: center; margin-bottom: 20px; line-height: 1.5; }
        .error-banner {
            background: var(--error-bg);
            border: 1px solid var(--error-border);
            color: var(--error-text);
            padding: 10px 14px;
            border-radius: 8px;
            font-size: 13px;
            margin-bottom: 20px;
            text-align: center;
            line-height: 1.5;
        }
        .error-banner.server-error {
            background: rgba(220, 38, 38, 0.2);
            border-color: rgba(239, 68, 68, 0.5);
            font-weight: 500;
        }
        .form-group { margin-bottom: 20px; }
        label { display: block; font-size: 12px; font-weight: 500; color: var(--text-sub); margin-bottom: 6px; }
        input[type="password"], input[type="text"] {
            width: 100%;
            padding: 12px 14px;
            border-radius: 8px;
            border: 1px solid var(--border);
            background: rgba(15, 23, 42, 0.6);
            color: #fff;
            font-size: 14px;
            outline: none;
            transition: border-color 0.2s;
        }
        input:focus { border-color: var(--accent); }
        button.submit-btn {
            width: 100%;
            padding: 12px;
            border-radius: 8px;
            border: none;
            background: var(--accent);
            color: #0f172a;
            font-weight: 600;
            font-size: 14px;
            cursor: pointer;
            transition: background 0.2s;
        }
        button.submit-btn:hover { background: var(--accent-hover); }
        .input-wrapper {
            position: relative;
            display: flex;
            align-items: center;
        }
        .input-wrapper input {
            padding-right: 42px;
        }
        .toggle-btn {
            position: absolute;
            right: 8px;
            background: transparent;
            border: none;
            cursor: pointer;
            padding: 6px;
            color: var(--text-sub);
            font-size: 16px;
            line-height: 1;
            display: flex;
            align-items: center;
            justify-content: center;
            outline: none;
        }
        .toggle-btn:hover {
            color: var(--text-main);
        }
        .tip { font-size: 12px; color: var(--text-sub); margin-top: 20px; line-height: 1.6; border-top: 1px solid rgba(255, 255, 255, 0.08); padding-top: 16px; }
        .tip strong { color: var(--text-main); }
        code { background: rgba(255, 255, 255, 0.08); padding: 2px 6px; border-radius: 4px; font-family: monospace; font-size: 11px; }
    </style>
</head>
<body>
    <div class="card">
        <div class="icon">🛡️</div>
        <h1>控制台设备安全配对</h1>
        <p class="desc">首次从浏览器访问须验证带外配对凭据。配对成功后该浏览器将获得专属长期凭据，日常无感免密访问。</p>
        ${safeError}
        <form action="/api/pair" method="POST">
            <div class="form-group">
                <label for="pairToken">带外配对凭据 (Pairing Token)</label>
                <div class="input-wrapper">
                    <input type="password" id="pairToken" name="pairToken" placeholder="输入配对凭据" required autocomplete="off" autofocus ${isServerError ? 'disabled' : ''}>
                    <button type="button" class="toggle-btn" id="toggleVisibility" title="切换显示/隐藏">👁️</button>
                </div>
            </div>
            <button type="submit" class="submit-btn" ${submitDisabled}>完成配对并记住此浏览器</button>
        </form>
        <script>
            (function() {
                var input = document.getElementById('pairToken');
                var toggleBtn = document.getElementById('toggleVisibility');
                if (input && toggleBtn) {
                    toggleBtn.addEventListener('click', function(e) {
                        e.preventDefault();
                        if (input.type === 'password') {
                            input.type = 'text';
                            toggleBtn.textContent = '🔒';
                        } else {
                            input.type = 'password';
                            toggleBtn.textContent = '👁️';
                        }
                    });
                }
                var form = document.querySelector('form');
                if (form && input) {
                    form.addEventListener('submit', function() {
                        var val = (input.value || '').trim();
                        if (val.endsWith('%')) {
                            val = val.slice(0, -1).trim();
                        }
                        input.value = val;
                    });
                }
            })();
        </script>
        <div class="tip">
            <strong>💡 如何获取配对码：</strong><br>
            1. <strong>查看配对码文件：</strong> 查看项目根目录下的 <code>sessions/.web_pairing_secret</code> 隐藏文件（在终端执行 <code>cat sessions/.web_pairing_secret</code> 或在文件管理器中显示隐藏文件查看；未来 Docker 部署则位于 <code>compose.yaml</code> 同级 <code>sessions</code> 目录下，宿主机直接查看无需 <code>docker exec</code>）；<br>
            2. <strong>自定义配对密码：</strong> 若配置了环境变量 <code>MS_WEB_PAIRING_SECRET</code>（>= 15 字符），请输入您自定义的密码（该变量优先生效）；<br>
            3. <strong>日常访问无感：</strong> 仅首次需配对一次，后续关闭浏览器或服务重启均免密直达。
        </div>
    </div>
</body>
</html>`
}

const server = http.createServer(async (req, res) => {
    const isHttps = isRequestHttps(req)

    // 1. Host 头校验 (防 DNS Rebinding 攻击与非法端口注入)
    const hostHeader = req.headers.host || ''
    if (!isValidHost(hostHeader, isHttps)) {
        res.writeHead(403, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'forbidden_host', message: '安全拦截 (S1): 非法 Host 请求头 (防 DNS Rebinding)' }))
        return
    }

    // 2. Origin 校验与精准 CORS 配置 (废除通配符 *，严格同源与协议比对)
    const originHeader = req.headers.origin
    if (originHeader) {
        if (!isValidOrigin(originHeader, null, hostHeader, isHttps)) {
            res.writeHead(403, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ error: 'forbidden_origin', message: '安全拦截 (S1): 非信任来源 Origin 请求' }))
            return
        }
        res.setHeader('Access-Control-Allow-Origin', originHeader)
        res.setHeader('Access-Control-Allow-Credentials', 'true')
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS')
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-CSRF-Token, X-Local-Token')
    }

    if (req.method === 'OPTIONS') {
        res.writeHead(204)
        res.end()
        return
    }

    const parsedUrl = new URL(req.url, `http://${req.headers.host || '127.0.0.1'}`)
    const pathname = parsedUrl.pathname

    // 3. 根页面鉴权：未认证时严格返回 401 锁屏页，绝不下发 Cookie 和 CSRF 令牌；禁止通过 URL Query 传递配对凭据
    if (pathname === '/' || pathname === '/index.html') {
        const secFetchSite = req.headers['sec-fetch-site']
        if (secFetchSite === 'cross-site') {
            res.writeHead(403, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ error: 'forbidden_cross_site', message: '安全拦截: 禁止跨站读取主页及凭据' }))
            return
        }

        const auth = checkRequestAuthentication(req, res)
        if (!auth.authenticated) {
            const pairingInitErr = getPairingInitError()
            if (pairingInitErr) {
                res.writeHead(500, {
                    'Content-Type': 'text/html; charset=utf-8',
                    'X-Frame-Options': 'DENY',
                    'Content-Security-Policy': "frame-ancestors 'none';"
                })
                res.end(renderPairingPage(pairingInitErr, { isServerError: true }))
                return
            }

            // 未授权：返回 401 配对锁屏页，绝不下发会话 Cookie 和真实 CSRF Token
            res.writeHead(401, {
                'Content-Type': 'text/html; charset=utf-8',
                'X-Frame-Options': 'DENY',
                'Content-Security-Policy': "frame-ancestors 'none';"
            })
            res.end(renderPairingPage())
            return
        }

        const filePath = path.join(publicDir, 'index.html')
        fs.readFile(filePath, 'utf-8', (err, content) => {
            if (err) {
                res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' })
                res.end('Error loading dashboard')
            } else {
                let activeCsrf = localCsrfToken
                if (auth.deviceSecret) {
                    const csrfSeed = auth.authEpoch || 'device_csrf_seed'
                    activeCsrf = generateDeviceCsrfToken(auth.deviceSecret, csrfSeed)
                }
                let html = content.replace(
                    /<meta\s+name=["']csrf-token["']\s+content=["'][^"']*["']\s*\/?>/i,
                    `<meta name="csrf-token" content="${activeCsrf}">`
                )
                if (!html.includes(`name="csrf-token"`)) {
                    html = html.replace('</head>', `    <meta name="csrf-token" content="${activeCsrf}">\n</head>`)
                }
                const headers = {
                    'Content-Type': 'text/html; charset=utf-8',
                    'X-Frame-Options': 'DENY',
                    'Content-Security-Policy': "frame-ancestors 'none';"
                }
                if (auth.renewalCookie) {
                    headers['Set-Cookie'] = auth.renewalCookie
                }
                res.writeHead(200, headers)
                res.end(html)
            }
        })
        return
    }

    // 3.5 带外配对接口 (POST /api/pair)，支持表单与 JSON 提交
    if (pathname === '/api/pair') {
        if (req.method !== 'POST') {
            res.writeHead(405, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ error: 'method_not_allowed', message: '仅支持 POST 请求' }))
            return
        }

        const clientIp = getClientIp(req)
        const rateCheck = checkPairRateLimit(clientIp)
        if (!rateCheck.allowed) {
            const retrySec = rateCheck.remainingSeconds || 60
            const errJson = {
                error: 'too_many_attempts',
                message: `配对尝试失败次数过多，已被临时锁定，请等待 ${retrySec} 秒后再试`
            }
            const contentType = req.headers['content-type'] || ''
            if (contentType.includes('application/x-www-form-urlencoded')) {
                res.writeHead(429, {
                    'Content-Type': 'text/html; charset=utf-8',
                    'Retry-After': String(retrySec),
                    'X-Frame-Options': 'DENY',
                    'Content-Security-Policy': "frame-ancestors 'none';"
                })
                res.end(renderPairingPage(errJson.message))
                return
            }
            res.writeHead(429, {
                'Content-Type': 'application/json',
                'Retry-After': String(retrySec)
            })
            res.end(JSON.stringify(errJson))
            return
        }

        const pairingInitErr = getPairingInitError()
        if (pairingInitErr) {
            const contentType = req.headers['content-type'] || ''
            if (contentType.includes('application/x-www-form-urlencoded')) {
                res.writeHead(500, {
                    'Content-Type': 'text/html; charset=utf-8',
                    'X-Frame-Options': 'DENY',
                    'Content-Security-Policy': "frame-ancestors 'none';"
                })
                res.end(renderPairingPage(pairingInitErr, { isServerError: true }))
                return
            }
            res.writeHead(500, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ error: 'pairing_service_unavailable', message: pairingInitErr }))
            return
        }

        try {
            // 修复参数错位：传入 res 与 { maxSize: 10 * 1024, timeoutMs: 3000 }
            const bodyStr = await readRequestBody(req, res, { maxSize: 10 * 1024, timeoutMs: 3000 })
            let token = ''
            const contentType = req.headers['content-type'] || ''
            if (contentType.includes('application/json')) {
                try {
                    const parsed = JSON.parse(bodyStr)
                    token = parsed.pairToken || parsed.token || ''
                } catch (_) {}
            } else if (contentType.includes('application/x-www-form-urlencoded')) {
                const params = new URLSearchParams(bodyStr)
                token = params.get('pairToken') || params.get('token') || ''
            } else {
                token = bodyStr
            }

            token = String(token || '').trim()

            const effectivePairingSecret = getLocalPairingSecret()
            if (!effectivePairingSecret) {
                const initErr = getPairingInitError() || '配对服务不可用，请检查服务状态'
                res.writeHead(500, { 'Content-Type': 'application/json' })
                res.end(JSON.stringify({ error: 'pairing_service_unavailable', message: initErr }))
                return
            }

            // 终端复制容错：用户在 macOS/Linux zsh 终端中 cat 无换行文件时，常会将行末的 % 提示标记误选复制
            if (token !== effectivePairingSecret && token.endsWith('%')) {
                const stripped = token.slice(0, -1).trim()
                if (stripped === effectivePairingSecret) {
                    token = stripped
                }
            }

            if (!token || token !== effectivePairingSecret) {
                recordPairFailure(clientIp)
                if (contentType.includes('application/x-www-form-urlencoded')) {
                    res.writeHead(401, {
                        'Content-Type': 'text/html; charset=utf-8',
                        'X-Frame-Options': 'DENY',
                        'Content-Security-Policy': "frame-ancestors 'none';"
                    })
                    res.end(renderPairingPage('配对凭据无效或已失效，请检查后重试'))
                    return
                }
                res.writeHead(401, { 'Content-Type': 'application/json' })
                res.end(JSON.stringify({ error: 'invalid_pairing_token', message: '配对凭据无效或已失效' }))
                return
            }

            // 配对成功：重置该客户端 IP 的失败记录
            resetPairFailure(clientIp)

            // 配对成功：为当前浏览器创建独立高熵长期设备凭证
            const isHttps = isRequestHttps(req)
            let deviceAuth = null
            try {
                const db = getDatabase(false)
                try {
                    deviceAuth = createAuthorizedClient(db, {
                        name: req.headers['user-agent'] || 'Browser'
                    })
                } finally {
                    db.close()
                }
            } catch (authErr) {
                // 阻断点 1 核心修复与安全脱敏：持久授权创建失败必须明确失败，严禁向客户端回显原始底层异常/路径
                const genericErrorMessage = '持久化设备授权创建失败，请检查服务状态后重试'
                if (contentType.includes('application/x-www-form-urlencoded')) {
                    res.writeHead(500, {
                        'Content-Type': 'text/html; charset=utf-8',
                        'X-Frame-Options': 'DENY',
                        'Content-Security-Policy': "frame-ancestors 'none';"
                    })
                    res.end(renderPairingPage(genericErrorMessage))
                    return
                }
                res.writeHead(500, { 'Content-Type': 'application/json' })
                res.end(JSON.stringify({
                    error: 'device_authorization_failed',
                    message: genericErrorMessage
                }))
                return
            }

            if (!deviceAuth?.cookieValue) {
                res.writeHead(500, { 'Content-Type': 'application/json' })
                res.end(JSON.stringify({
                    error: 'device_authorization_failed',
                    message: '无法生成有效的持久设备凭证'
                }))
                return
            }

            // 核心安全原则：浏览器只下发独立高熵长期设备凭证 ms_device_token，绝不下发任何共享全局 token
            const cookieHeaders = [
                buildDeviceCookieHeader(deviceAuth.cookieValue, { isHttps })
            ]

            const csrfSeed = deviceAuth.authEpoch || 'device_csrf_seed'
            const deviceCsrf = generateDeviceCsrfToken(deviceAuth.deviceSecret, csrfSeed)

            if (contentType.includes('application/x-www-form-urlencoded')) {
                res.writeHead(302, {
                    'Location': '/',
                    'Set-Cookie': cookieHeaders,
                    'X-Frame-Options': 'DENY',
                    'Content-Security-Policy': "frame-ancestors 'none';"
                })
                res.end()
                return
            }

            res.writeHead(200, {
                'Content-Type': 'application/json',
                'Set-Cookie': cookieHeaders
            })
            res.end(JSON.stringify({
                success: true,
                message: '设备安全配对成功',
                csrfToken: deviceCsrf,
                deviceId: deviceAuth.deviceId
            }))
            return
        } catch (err) {
            // 超限或超时已由 readRequestBody 发送 HTTP 413/408，若 headersSent 直接退出
            if (res.headersSent) return
            res.writeHead(500, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ error: 'internal_error', message: err.message }))
            return
        }
    }

    // 4. 控制 API 访问控制与写操作 CSRF 防护
    if (pathname.startsWith('/api/')) {
        const auth = checkRequestAuthentication(req, res)

        if (!auth.authenticated) {
            res.writeHead(401, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({
                error: 'unauthorized',
                message: '安全拦截 (S1): 本地控制 API 未授权。请从受信任的控制台页面发起请求'
            }))
            return
        }

        const isWriteMethod = ['POST', 'PUT', 'DELETE', 'PATCH'].includes(req.method)
        if (isWriteMethod) {
            if (!checkRequestCsrf(req, auth)) {
                res.writeHead(403, { 'Content-Type': 'application/json' })
                res.end(JSON.stringify({
                    error: 'csrf_mismatch',
                    message: '安全拦截 (S1): CSRF Token 无效或缺失，写操作已被拒绝'
                }))
                return
            }
        }
    }

    // 4.5 控制台设备授权管理：退出控制台 (撤销当前浏览器)
    if (pathname === '/api/console/logout' && req.method === 'POST') {
        const isHttps = isRequestHttps(req)
        const cookies = parseCookies(req)
        const deviceToken = cookies[DEVICE_COOKIE_NAME]

        if (deviceToken) {
            let revoked = false
            try {
                const db = getDatabase(false)
                try {
                    const parts = deviceToken.split('.')
                    if (parts[0]) {
                        revoked = revokeClient(db, parts[0])
                    }
                } finally {
                    db.close()
                }
            } catch (err) {
                res.writeHead(500, { 'Content-Type': 'application/json' })
                res.end(JSON.stringify({
                    error: 'revoke_failed',
                    message: '无法撤销设备授权凭据，数据库写入失败'
                }))
                return
            }

            if (!revoked) {
                res.writeHead(500, { 'Content-Type': 'application/json' })
                res.end(JSON.stringify({
                    error: 'revoke_failed',
                    message: '无法撤销设备授权凭据，目标设备不存在或已被撤销'
                }))
                return
            }
        }

        // 核心安全修复：仅在持久化撤销成功后才轮换全局 localSessionToken 与 localCsrfToken 并清理凭证
        localSessionToken = crypto.randomBytes(32).toString('hex')
        localCsrfToken = crypto.randomBytes(32).toString('hex')

        const clearCookies = [
            buildClearDeviceCookieHeader({ isHttps }),
            `ms_local_token=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT${isHttps ? '; Secure' : ''}`
        ]

        res.writeHead(200, {
            'Content-Type': 'application/json',
            'Set-Cookie': clearCookies
        })
        res.end(JSON.stringify({
            success: true,
            message: '已撤销此浏览器的控制台配对授权并清理凭证'
        }))
        return
    }

    // 4.6 控制台设备授权管理：撤销所有已配对设备
    if (pathname === '/api/console/revoke-all' && req.method === 'POST') {
        const isHttps = isRequestHttps(req)
        let revokedCount = 0
        try {
            const db = getDatabase(false)
            try {
                revokedCount = revokeAllClients(db)
            } finally {
                db.close()
            }
        } catch (err) {
            res.writeHead(500, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({
                error: 'revoke_all_failed',
                message: '无法撤销所有设备授权，数据库操作失败'
            }))
            return
        }

        localSessionToken = crypto.randomBytes(32).toString('hex')
        localCsrfToken = crypto.randomBytes(32).toString('hex')

        const clearCookies = [
            buildClearDeviceCookieHeader({ isHttps }),
            `ms_local_token=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT${isHttps ? '; Secure' : ''}`
        ]

        res.writeHead(200, {
            'Content-Type': 'application/json',
            'Set-Cookie': clearCookies
        })
        res.end(JSON.stringify({
            success: true,
            count: revokedCount,
            message: '已成功撤销所有设备的控制台配对授权'
        }))
        return
    }

    // 4.7 控制台当前设备授权状态查询
    if (pathname === '/api/console/status' && req.method === 'GET') {
        const auth = checkRequestAuthentication(req, res)
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({
            authenticated: auth.authenticated,
            type: auth.type || null,
            deviceId: auth.deviceId ? maskSecret(auth.deviceId) : null,
            isLongLived: auth.type === 'device'
        }))
        return
    }

    if (pathname === '/api/state') {
        let current = getSavedState()
        const today = new Date().toISOString().slice(0, 10)
        if (
            current.currentDate !== today ||
            current.isNewDay ||
            !current.updatedAt ||
            current.pointsSchemaVersion !== POINTS_SCHEMA_VERSION
        ) {
            try {
                const live = await fetchLiveMicrosoftState()
                if (live) current = saveState(live)
            } catch (_) {}
        }
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify(current))
        return
    }

    if (pathname === '/api/stream') {
        res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive'
        })
        res.write('\n')
        sseClients.add(res)

        // Send initial state
        res.write(`data: ${JSON.stringify({ type: 'state', data: getSavedState() })}\n\n`)
        res.write(`data: ${JSON.stringify({ type: 'mobileState', data: getSavedMobileState() })}\n\n`)
        res.write(`data: ${JSON.stringify({ type: 'runtimeSnapshot', data: runtimeReplay.snapshot() })}\n\n`)
        if (latestBotChallengeAlert) {
            res.write(`data: ${JSON.stringify({ type: 'botChallengeAlert', data: latestBotChallengeAlert })}\n\n`)
        }

        req.on('close', () => {
            sseClients.delete(res)
        })
        return
    }

    if (pathname === '/api/sync' && (req.method === 'GET' || req.method === 'POST')) {
        if (!getSessionAuthorizationStatus().desktop) {
            res.writeHead(401, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ success: false, error: 'desktop_login_required' }))
            return
        }
        const silentSync = parsedUrl.searchParams.get('silent') === '1'
        const retryAfterSeconds = claimManualSync('desktop', silentSync)
        if (retryAfterSeconds > 0) {
            res.writeHead(429, { 'Content-Type': 'application/json', 'Retry-After': String(retryAfterSeconds) })
            res.end(JSON.stringify({ success: false, error: 'desktop_sync_cooldown', retryAfterSeconds }))
            return
        }
        if (!silentSync) broadcast({ type: 'log', platform: 'desktop', time: getTimeStr(), msg: '🔄 收到桌面端手动同步请求，正在连接微软云端 API 拉取最新账户与任务数据...', level: 'highlight' })
        let liveData = null
        try {
            liveData = await fetchLiveMicrosoftState()
        } catch (e) {}

        let state = getSavedState()
        if (liveData) {
            state = saveState(liveData)
            broadcast({ type: 'state', platform: 'desktop', data: state })
            if (!silentSync) {
                const dailyDone = (state.dailySetCards || []).filter(c => c.complete).length
                const dailyTotal = (state.dailySetCards || []).length
                broadcast({ type: 'log', platform: 'desktop', time: getTimeStr(), msg: `☁️ 微软云端响应成功！用户: ${state.account} (${state.level || '等级未知'})`, level: 'info' })
                broadcast({ type: 'log', platform: 'desktop', time: getTimeStr(), msg: `💰 最新可用余额: ${Number(state.totalPoints).toLocaleString()} 分 | 官方今日累计: ${state.dailyEarned}/${state.dailyMax} 分 | PC 任务小计: ${state.pcDailyEarned}/${state.pcDailyMax} 分`, level: 'success' })
                broadcast({ type: 'log', platform: 'desktop', time: getTimeStr(), msg: `📋 任务状态: Daily Set ${dailyDone}/${dailyTotal}, Keep Earning ${state.promotionsQuota || '0/0'}, PC Search ${state.pcSearchQuota || '0/0'}, Edge ${state.streakDetails?.edgeBrowsing || '状态不可用'}`, level: 'info' })
                if (state.hasBotWarning) {
                    broadcast({ type: 'log', platform: 'desktop', time: getTimeStr(), msg: '🛡️ 检测到微软风控/人机质询标记 (Fraud_UserWarning_BotScore_UX)！系统已对高危每日任务打上【风控跳过】标记，自动规避高危交互以保全账号。', level: 'warn' })
                }
            }
        } else {
            broadcast({ type: 'state', platform: 'desktop', data: state })
            if (!silentSync) broadcast({ type: 'log', platform: 'desktop', time: getTimeStr(), msg: `⚠️ PC 云同步失败，保留本地缓存 | 积分余额: ${Number(state.totalPoints).toLocaleString()} 分`, level: 'warn' })
        }
        res.writeHead(liveData ? 200 : 503, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ success: Boolean(liveData), live: Boolean(liveData), state, error: liveData ? null : 'desktop_cloud_unavailable' }))
        return
    }

    if (pathname === '/api/mobile/state' && req.method === 'GET') {
        let current = getSavedMobileState()
        const today = new Date().toISOString().slice(0, 10)
        if (
            !current.updatedAt ||
            current.updatedAt.slice(0, 10) !== today ||
            current.pointsSchemaVersion !== POINTS_SCHEMA_VERSION
        ) {
            try {
                const live = await fetchLiveMobileState()
                if (live) current = saveMobileState(live)
            } catch (_) {}
        }
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify(current))
        return
    }

    if (pathname === '/api/mobile/sync' && (req.method === 'GET' || req.method === 'POST')) {
        if (!getSessionAuthorizationStatus().mobile) {
            res.writeHead(401, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ success: false, error: 'mobile_login_required' }))
            return
        }
        const silentSync = parsedUrl.searchParams.get('silent') === '1'
        const retryAfterSeconds = claimManualSync('mobile', silentSync)
        if (retryAfterSeconds > 0) {
            res.writeHead(429, { 'Content-Type': 'application/json', 'Retry-After': String(retryAfterSeconds) })
            res.end(JSON.stringify({ success: false, error: 'mobile_sync_cooldown', retryAfterSeconds }))
            return
        }
        if (!silentSync) broadcast({ type: 'log', platform: 'mobile', time: getTimeStr(), msg: '📱 正在连接微软官方移动网关 (SAAndroid) 同步手机端数据...', level: 'highlight' })
        let liveData = null
        try {
            liveData = await fetchLiveMobileState()
        } catch (e) {}

        let state = getSavedMobileState()
        if (liveData) {
            state = saveMobileState(liveData)
            broadcast({ type: 'mobileState', platform: 'mobile', data: state })
            if (!silentSync) {
                broadcast({ type: 'log', platform: 'mobile', time: getTimeStr(), msg: `☁️ 移动网关同步成功！App Search: ${state.mobileSearch} | 必应新闻阅读: ${state.readToEarn} | 签到: ${state.checkIn}`, level: 'success' })
                broadcast({ type: 'log', platform: 'mobile', time: getTimeStr(), msg: `📱 Bing App 今日: ${state.todayEarned} / ${state.todayMax} 分 | 可用总余额: ${Number(state.totalPoints).toLocaleString()} 分`, level: 'info' })
            }
        } else {
            broadcast({ type: 'mobileState', platform: 'mobile', data: state })
            if (!silentSync) broadcast({ type: 'log', platform: 'mobile', time: getTimeStr(), msg: `⚠️ 移动网关同步失败，保留本地缓存 | App Search: ${state.mobileSearch}`, level: 'warn' })
        }
        res.writeHead(liveData ? 200 : 503, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ success: Boolean(liveData), live: Boolean(liveData), state, error: liveData ? null : 'mobile_cloud_unavailable' }))
        return
    }

    if (pathname === '/api/mobile/run' && req.method === 'POST') {
        if (!getSessionAuthorizationStatus().mobile) {
            res.writeHead(401, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ success: false, error: 'mobile_login_required' }))
            return
        }
        if (activeBotProcess) {
            res.writeHead(409, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ success: false, error: 'automation_already_running' }))
            return
        }
        const live = await fetchLiveMobileState().catch(() => null)
        if (!live) {
            res.writeHead(503, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ success: false, error: 'mobile_preflight_unavailable' }))
            return
        }
        const state = saveMobileState(live)
        broadcast({ type: 'mobileState', platform: 'mobile', data: state })
        runBotProcess('mobile', state)
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ success: true, message: 'Mobile automation started' }))
        return
    }

    if (pathname === '/api/run' && req.method === 'POST') {
        if (!getSessionAuthorizationStatus().desktop) {
            res.writeHead(401, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ success: false, error: 'desktop_login_required' }))
            return
        }
        if (activeBotProcess) {
            res.writeHead(409, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ success: false, error: 'automation_already_running' }))
            return
        }
        const live = await fetchLiveMicrosoftState().catch(() => null)
        if (!live) {
            res.writeHead(503, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ success: false, error: 'desktop_preflight_unavailable' }))
            return
        }
        const state = saveState(live)
        broadcast({ type: 'state', platform: 'desktop', data: state })
        runBotProcess('desktop', state)
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ success: true, message: 'Desktop automation started' }))
        return
    }

    if (pathname === '/api/unified/state' && req.method === 'GET') {
        let activeProfile = null
        try {
            const db = getDatabase(false)
            activeProfile = getActiveProfile(db)
            db.close()
        } catch (_) {}

        const desktopState = getSavedState(activeProfile?.id)
        const mobileState = getSavedMobileState(activeProfile?.id)
        const auth = getSessionAuthorizationStatus()
        
        const dsCards = (desktopState.dailySetCards && desktopState.dailySetCards.length) 
            ? desktopState.dailySetCards 
            : (mobileState.dailySetCards || [])
        const dsDone = dsCards.filter(c => c.complete).length
        const dsTotal = dsCards.length
        
        const parseFraction = (str) => {
            if (!str || typeof str !== 'string' || !str.includes('/')) return { earned: 0, max: 0, complete: false }
            const [e, m] = str.split('/').map(v => Number(v) || 0)
            return { earned: e, max: m, complete: m > 0 && e >= m }
        }
        
        const promoCards = desktopState.promoCards || []
        const pointCards = promoCards.filter(c => (c.points || 0) > 0)
        const pointComplete = pointCards.length > 0 && pointCards.every(c => c.complete)
        const keParsed = parseFraction(desktopState.promotionsQuota)

        const punchCards = desktopState.punchCards || []
        const punchDone = punchCards.filter(c => c.complete).length
        const punchTotal = punchCards.length
        const punchComplete = punchTotal > 0 ? punchDone === punchTotal : Boolean(desktopState.tasks?.punchCards?.status === 'DONE')

        const mobilePromos = (mobileState.promoCards || []).map(c => ({
            ...c,
            source: 'mobile',
            platformBadge: 'App专属'
        }))
        const desktopPromos = (desktopState.promoCards || []).map(c => ({
            ...c,
            source: 'desktop',
            platformBadge: 'Web专属'
        }))
        const rawExploreCards = mobilePromos.filter(c => c.isExploreOnBing)
        const exploreDoneCount = rawExploreCards.filter(c => c.complete).length
        const exploreQuotaReached = exploreDoneCount >= 4
        const exploreCards = rawExploreCards.map(c => {
            if (c.complete) return c
            if (exploreQuotaReached || c.isLockedTomorrow || c.exploreStatus === 'tomorrow_locked') {
                return {
                    ...c,
                    exploreStatus: 'tomorrow_locked',
                    isLockedTomorrow: true
                }
            }
            if (c.exploreStatus === 'activated' || c.isActivated) {
                return {
                    ...c,
                    exploreStatus: 'activated',
                    isActivated: true
                }
            }
            return c
        })
        const seenOffers = new Map()
        for (const p of desktopPromos) {
            const key = p.offerId || p.destinationUrl || p.title
            if (key) seenOffers.set(key, { ...p, platformBadge: 'Web专属' })
        }
        for (const p of mobilePromos.filter(c => !c.isExploreOnBing)) {
            const key = p.offerId || p.destinationUrl || p.title
            if (!key) continue
            if (seenOffers.has(key)) {
                const existing = seenOffers.get(key)
                seenOffers.set(key, {
                    ...existing,
                    complete: existing.complete || p.complete,
                    platformBadge: 'Web通用'
                })
            } else {
                seenOffers.set(key, { ...p, platformBadge: 'App专属' })
            }
        }
        const generalPromos = Array.from(seenOffers.values())

        const todayIso = new Date().toISOString().slice(0, 10)
        const desktopDate = normalizeDate(desktopState.currentDate || desktopState.date || desktopState.dailySetDate)
        const mobileDate = normalizeDate(mobileState.currentDate || mobileState.dailySetDate || mobileState.taskRefresh?.accountDate)

        const isDesktopToday = (desktopDate === todayIso || !desktopDate)
        const isMobileToday = (mobileDate === todayIso)

        const dsEarned = dsCards.reduce((sum, c) => sum + (c.complete ? (c.points || 10) : 0), 0)
        const dsMax = dsCards.reduce((sum, c) => sum + (c.points || 10), 0) || 30

        const shared = {
            dailySet: {
                cards: dsCards,
                done: dsDone,
                total: dsTotal,
                complete: dsTotal > 0 ? dsDone === dsTotal : false,
                earned: dsEarned,
                max: dsMax
            },
            keepEarning: {
                quota: desktopState.promotionsQuota || '0/0',
                earned: keParsed.earned,
                max: keParsed.max,
                complete: pointComplete || keParsed.complete,
                cards: generalPromos
            },
            explore: {
                cards: exploreCards,
                done: exploreCards.filter(c => c.complete).length,
                total: exploreCards.length
            },
            punchCards: {
                cards: punchCards,
                done: punchDone,
                total: punchTotal,
                complete: punchComplete
            }
        }
        
        const desktop = {
            search: {
                quota: isDesktopToday ? (desktopState.pcSearchQuota || '0/0') : '0/0',
                earned: isDesktopToday ? (desktopState.pcDailyEarned || 0) : 0,
                max: isDesktopToday ? (desktopState.pcDailyMax || 0) : 0,
                ...parseFraction(isDesktopToday ? (desktopState.pcSearchQuota || '0/0') : '0/0')
            },
            edgeBrowsing: {
                status: desktopState.streakDetails?.edgeBrowsing || '就绪'
            }
        }
        
        const mobile = {
            checkIn: {
                status: isMobileToday ? (mobileState.checkIn || '未签到') : '0/1 今日待签到 (5分)',
                streak: mobileState.checkInStreak || 0,
                complete: isMobileToday ? Boolean(mobileState.checkInDone || (mobileState.checkIn && (/✔|完成|已签到/.test(mobileState.checkIn)))) : false
            },
            readToEarn: {
                progress: isMobileToday ? (mobileState.readToEarn || '0/30') : '0/30',
                ...parseFraction(isMobileToday ? (mobileState.readToEarn || '0/30') : '0/30')
            },
            search: {
                quota: isMobileToday ? (mobileState.mobileSearch || '0/0') : `0/${mobileState.mobileSearchMax || 200}`,
                ...parseFraction(isMobileToday ? (mobileState.mobileSearch || '0/0') : `0/${mobileState.mobileSearchMax || 200}`)
            }
        }
        
        const desktopTodayEarned = isDesktopToday ? (Number(desktopState.dailyEarned) || 0) : 0
        const mobileTodayEarned = isMobileToday ? (Number(mobileState.todayEarned) || 0) : 0
        const desktopTodayMax = isDesktopToday ? (Number(desktopState.dailyMax) || 0) : 0
        const mobileTodayMax = isMobileToday ? (Number(mobileState.todayMax) || 0) : 0

        const totalPoints = Math.max(Number(desktopState.totalPoints) || 0, Number(mobileState.totalPoints) || 0)
        const todayEarned = Math.max(desktopTodayEarned, mobileTodayEarned)
        const todayMax = Math.max(desktopTodayMax, mobileTodayMax)
        
        const region = (activeProfile?.region && activeProfile.region !== 'AUTO')
            ? activeProfile.region
            : (desktopState.region || mobileState.region || getResolvedAccountRegion(desktopState.account || mobileState.account) || 'US')
        const taskRefresh = desktopState.taskRefresh || mobileState.taskRefresh || {
            taskDate: desktopState.accountDate || mobileState.accountDate || '',
            officialResetAt: null,
            nextResetAt: computeRegionNextResetAt(region)
        }

        const unified = {
            account: activeProfile?.email || desktopState.account || mobileState.account || getSavedAccount().email || '未登录',
            level: desktopState.level || mobileState.level || 'Level 2',
            region,
            taskRefresh,
            accountDate: desktopState.accountDate || mobileState.accountDate || '',
            totalPoints,
            todayEarned,
            todayMax,
            shared,
            desktop,
            mobile,
            session: auth,
            running: Boolean(activeBotProcess),
            activeMode: activeRunPlatform || (activeBotProcess ? 'running' : null),
            activeProfile: activeProfile ? { id: activeProfile.id, name: activeProfile.name, email: activeProfile.email, region } : null
        }
        
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify(unified))
        return
    }

    if (pathname === '/api/unified/sync' && (req.method === 'GET' || req.method === 'POST')) {
        const silentSync = parsedUrl.searchParams.get('silent') === '1'
        if (!silentSync) broadcast({ type: 'log', platform: 'all', time: getTimeStr(), msg: '🔄 正在同步双端（PC微内核 + 移动原生网关）最新数据...', level: 'highlight' })
        
        const [dtRes, mbRes] = await Promise.allSettled([
            fetchLiveMicrosoftState(),
            fetchLiveMobileState()
        ])
        
        let desktopState = getSavedState()
        let mobileState = getSavedMobileState()
        
        if (dtRes.status === 'fulfilled' && dtRes.value) {
            desktopState = saveState(dtRes.value)
            broadcast({ type: 'state', platform: 'desktop', data: desktopState })
        }
        if (mbRes.status === 'fulfilled' && mbRes.value) {
            mobileState = saveMobileState(mbRes.value)
            broadcast({ type: 'mobileState', platform: 'mobile', data: mobileState })
        }
        
        const currentPoints = Math.max(Number(desktopState.totalPoints) || 0, Number(mobileState.totalPoints) || 0)
        if (!silentSync) {
            broadcast({ type: 'log', platform: 'all', time: getTimeStr(), msg: `☁️ 双端同步完成！当前总可用余额: ${currentPoints.toLocaleString()} 分`, level: 'success' })
        }
        
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({
            success: Boolean(dtRes.value || mbRes.value),
            desktopOk: Boolean(dtRes.value),
            mobileOk: Boolean(mbRes.value),
            totalPoints: currentPoints
        }))
        return
    }

    if (pathname === '/api/unified/run' && req.method === 'POST') {
        let body
        try {
            body = await readRequestBody(req, res)
        } catch {
            return
        }
        let mode = 'all'
        try {
            if (body) {
                const parsed = JSON.parse(body)
                if (parsed.mode) mode = parsed.mode
            }
        } catch (_) {}
        
        if (activeBotProcess) {
            res.writeHead(409, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ success: false, error: 'automation_already_running' }))
            return
        }
        
        const auth = getSessionAuthorizationStatus()
        if (mode === 'mobile' && !auth.mobile) {
            res.writeHead(401, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ success: false, error: 'mobile_login_required' }))
            return
        }
        if ((mode === 'desktop' || mode === 'shared') && !auth.desktop) {
            res.writeHead(401, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ success: false, error: 'desktop_login_required' }))
            return
        }
        if (mode === 'all' && !auth.desktop && !auth.mobile) {
            res.writeHead(401, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ success: false, error: 'session_login_required' }))
            return
        }
        
        let preflightState = null
        if (mode === 'mobile') {
            const live = await fetchLiveMobileState().catch(() => null)
            if (live) preflightState = saveMobileState(live)
        } else {
            const live = await fetchLiveMicrosoftState().catch(() => null)
            if (live) preflightState = saveState(live)
        }
        
        runBotProcess(mode, preflightState)
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ success: true, message: `Unified automation started (${mode})`, mode }))
        return
    }

    if (pathname === '/api/stop' && req.method === 'POST') {
        stopBotProcess()
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ success: true, message: 'Automation stopped' }))
        return
    }

    if (pathname === '/api/about' && req.method === 'GET') {
        let pkg = { name: 'ms-rewards-enhanced', version: '0.1.1', license: 'GPL-3.0-or-later' }
        try {
            pkg = JSON.parse(fs.readFileSync(path.join(__dirname, 'package.json'), 'utf-8'))
        } catch (_) {}
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({
            name: pkg.name || 'ms-rewards-enhanced',
            version: pkg.version || '0.1.1',
            description: pkg.description || 'Microsoft Rewards Automation Enhanced Edition with Fluent Web UI & Adaptive Agent',
            license: pkg.license || 'GPL-3.0-or-later',
            upstream: 'https://github.com/TheNetsky/Microsoft-Rewards-Script',
            repository: 'https://github.com/sellength/ms-rewards-enhanced',
            dockerImage: `ghcr.io/sellength/ms-rewards-enhanced:${pkg.version || '0.1.1'}`,
            changelogUrl: 'https://github.com/sellength/ms-rewards-enhanced/blob/dev/CUSTOM_CHANGELOG.md',
            releasesUrl: 'https://github.com/sellength/ms-rewards-enhanced/releases',
            currentRelease: {
                version: `v${pkg.version || '0.1.1'}`,
                date: '2026-10-08',
                title: '跨天状态隔离重置、Daily Set计分修正与关于面板',
                highlights: [
                    '⚡️ 跨天日历隔离与缓存自动重置：修复新的一天到来时移动端状态未自动归零、导致残留上一日 260/380 分缓存的问题',
                    '🎯 Daily Set 独立计分修正：修复 /api/unified/state 中每日三连任务展示的已得积分被全天总分污染的问题',
                    'ℹ️ 全新“关于项目”面板：侧边栏与主区域新增 Fluent 风格关于页面，实时展示系统版本与最新更新亮点',
                    '📖 历史更新日志直达：全量历史版本记录一键跳转至 GitHub 仓库查阅，保持 Web 控制台轻量利落'
                ]
            }
        }))
        return
    }

    if (pathname === '/api/config' && req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify(getSavedConfig()))
        return
    }

    if (pathname === '/api/config' && req.method === 'POST') {
        let body
        try {
            body = await readRequestBody(req, res)
        } catch {
            return
        }
        try {
            const newConf = JSON.parse(body)
            const ok = saveConfig(newConf)
            res.writeHead(200, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ success: ok }))
        } catch (e) {
            res.writeHead(400, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ success: false, error: e.message }))
        }
        return
    }

    if (pathname === '/api/test-webhook' && req.method === 'POST') {
        let body
        try {
            body = await readRequestBody(req, res)
        } catch {
            return
        }
        try {
            const conf = JSON.parse(body)
            const result = await sendTestWebhook(conf)
            res.writeHead(200, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify(result))
        } catch (e) {
            res.writeHead(500, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ success: false, error: e.message }))
        }
        return
    }

    if (pathname === '/api/doctor' && req.method === 'POST') {
        broadcast({ type: 'log', platform: 'desktop', time: getTimeStr(), msg: '🩺 正在启动 PC 端运行环境与网络全方位健康自检...', level: 'highlight' })
        const doctor = spawn('node', ['doctor.mjs'], { cwd: __dirname })
        let output = ''
        doctor.stdout.on('data', (d) => {
            const text = d.toString()
            output += text
            const lines = text.split('\n').filter(Boolean)
            for (const line of lines) {
                const clean = line.replace(/\x1b\[[0-9;]*m/g, '').trim()
                if (clean && !clean.startsWith('=')) {
                    broadcast({ type: 'log', platform: 'desktop', time: getTimeStr(), msg: clean, level: clean.includes('✔') ? 'success' : (clean.includes('✘') ? 'err' : 'info') })
                }
            }
        })
        doctor.stderr.on('data', (d) => output += d.toString())
        doctor.on('close', (code) => {
            broadcast({ type: 'log', platform: 'desktop', time: getTimeStr(), msg: code === 0 ? '🎉 PC 端自检通过！环境与网络状态处于最佳状态，可随时运行！' : '⚠️ PC 端自检发现异常项目，请检查配置！', level: code === 0 ? 'success' : 'warn' })
            res.writeHead(200, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ healthy: code === 0, log: output }))
        })
        return
    }

    if (pathname === '/api/mobile/doctor' && req.method === 'POST') {
        broadcast({ type: 'log', platform: 'mobile', time: getTimeStr(), msg: '🩺 正在启动 移动端 (SAAndroid) 专属运行环境健康自检...', level: 'highlight' })
        const doctor = spawn('node', ['mobile-doctor.mjs'], { cwd: __dirname })
        let output = ''
        doctor.stdout.on('data', (d) => {
            const text = d.toString()
            output += text
            const lines = text.split('\n').filter(Boolean)
            for (const line of lines) {
                const clean = line.replace(/\x1b\[[0-9;]*m/g, '').trim()
                if (clean && !clean.startsWith('=')) {
                    broadcast({ type: 'log', platform: 'mobile', time: getTimeStr(), msg: clean, level: clean.includes('✔') ? 'success' : (clean.includes('✘') ? 'err' : 'info') })
                }
            }
        })
        doctor.stderr.on('data', (d) => output += d.toString())
        doctor.on('close', (code) => {
            broadcast({ type: 'log', platform: 'mobile', time: getTimeStr(), msg: code === 0 ? '🎉 移动端自检通过！移动端仿真引擎与 SAAndroid 网关状态完美！' : '⚠️ 移动端自检发现异常项目，请检查配置！', level: code === 0 ? 'success' : 'warn' })
            res.writeHead(200, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ healthy: code === 0, log: output }))
        })
        return
    }

    if (pathname === '/api/cache/clear' && req.method === 'POST') {
        const platform = parsedUrl.searchParams.get('platform') || 'all'
        const broadcastPlatform = platform === 'mobile' ? 'mobile' : (platform === 'desktop' ? 'desktop' : 'all')
        broadcast({ type: 'log', platform: broadcastPlatform, time: getTimeStr(), msg: '🧹 正在执行会话缓存深度净化与脏 Cookie 清除...', level: 'highlight' })

        let cleanedSummary = { desktop: 0, mobile: 0 }
        try {
            const dbPath = getSessionDbPath()
            if (fs.existsSync(dbPath)) {
                const db = new DatabaseSync(dbPath)
                const platformsToClean = platform === 'all' ? ['desktop', 'mobile'] : [platform]
                for (const p of platformsToClean) {
                    const row = db.prepare('SELECT storage_state FROM sessions WHERE platform = ? LIMIT 1').get(p)
                    if (row && row.storage_state) {
                        try {
                            const storage = JSON.parse(row.storage_state)
                            if (Array.isArray(storage.cookies)) {
                                const origLen = storage.cookies.length
                                storage.cookies = sanitizeAllDirtyCookies(storage.cookies)
                                const removed = origLen - storage.cookies.length
                                cleanedSummary[p] = removed
                                db.prepare('UPDATE sessions SET storage_state = ? WHERE platform = ?').run(JSON.stringify(storage), p)
                            }
                        } catch (_) {}
                    }
                }
            }

            broadcast({
                type: 'log',
                platform: broadcastPlatform,
                time: getTimeStr(),
                msg: `✅ 会话净化完成！已清理 PC 端 ${cleanedSummary.desktop} 个、移动端 ${cleanedSummary.mobile} 个受污染/冷却标记 Cookie (_RwBf/ispd)，有效授权凭证已完好保留。`,
                level: 'success'
            })

            broadcast({ type: 'log', platform: broadcastPlatform, time: getTimeStr(), msg: '🔄 正在以纯净会话重新连接微软云端 API 握手同步...', level: 'info' })
            let liveDesktop = null
            let liveMobile = null
            try { liveDesktop = await fetchLiveMicrosoftState() } catch (_) {}
            try { liveMobile = await fetchLiveMobileState() } catch (_) {}

            let desktopState = getSavedState()
            if (liveDesktop) {
                desktopState = saveState(liveDesktop)
                broadcast({ type: 'state', platform: 'desktop', data: desktopState })
            }
            let mobileState = getSavedMobileState()
            if (liveMobile) {
                mobileState = saveMobileState(liveMobile)
                broadcast({ type: 'state', platform: 'mobile', data: mobileState })
            }

            const currentRegion = desktopState.region || mobileState.region || 'US'
            broadcast({
                type: 'log',
                platform: broadcastPlatform,
                time: getTimeStr(),
                msg: `🌐 微软云端连接验证成功！微软识别业务区域: ${currentRegion} | 账号: ${desktopState.account} | 当前可用积分: ${Number(desktopState.totalPoints).toLocaleString()} 分`,
                level: 'success'
            })

            res.writeHead(200, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({
                success: true,
                live: Boolean(liveDesktop || liveMobile),
                cleaned: cleanedSummary,
                desktopState,
                mobileState
            }))
        } catch (err) {
            broadcast({ type: 'log', platform: broadcastPlatform, time: getTimeStr(), msg: `❌ 会话净化异常: ${err.message}`, level: 'err' })
            res.writeHead(500, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ success: false, error: err.message }))
        }
        return
    }

    if (pathname === '/api/account' && req.method === 'GET') {
        const acc = getSavedAccount()
        const authorization = getSessionAuthorizationStatus()
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({
            success: true,
            authorization,
            account: {
                email: acc.email,
                hasPassword: Boolean(acc.password),
                passwordMasked: acc.password ? '••••••••••••' : '',
                totpSecret: acc.totpSecret || '',
                recoveryEmail: acc.recoveryEmail || '',
                geoLocale: acc.geoLocale || 'auto',
                langCode: acc.langCode || 'en'
            }
        }))
        return
    }

    if (pathname === '/api/account/status' && req.method === 'GET') {
        const authorization = getSessionAuthorizationStatus()
        const account = getSavedAccount()
        const accountMatches =
            (!authorization.desktopEmail || authorization.desktopEmail.toLowerCase() === account.email.toLowerCase()) &&
            (!authorization.mobileEmail || authorization.mobileEmail.toLowerCase() === account.email.toLowerCase()) &&
            (!authorization.desktopEmail || !authorization.mobileEmail ||
                authorization.desktopEmail.toLowerCase() === authorization.mobileEmail.toLowerCase())
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({
            success: true,
            configured: Boolean(account.email),
            desktop: authorization.desktop && accountMatches,
            mobile: authorization.mobile && accountMatches,
            accountMatches,
            email: account.email || ''
        }))
        return
    }

    if (pathname === '/api/account/logout' && req.method === 'POST') {
        if (activeBotProcess || scheduledSyncRunning || activeCloudReads > 0) {
            res.writeHead(409, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ success: false, error: 'logout_busy' }))
            return
        }
        try {
            const account = getSavedAccount()
            const dbPath = typeof getSessionDbPath === 'function' ? getSessionDbPath() : path.join(__dirname, 'sessions', 'sessions.db')
            let cleared = 0
            if (fs.existsSync(dbPath)) {
                const db = new DatabaseSync(dbPath)
                try { cleared = clearAccountSessionStorage(db, account.email) }
                finally { db.close() }
            }
            clearAccountLoginFiles(envFilePath, [stateFilePath, mobileStateFilePath])
            runtimeReplay.reset()
            dailySetProbeState.clear()
            activeProbeAccount = null
            res.writeHead(200, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ success: true, cleared }))
            broadcast({ type: 'accountLoggedOut' })
        } catch {
            res.writeHead(500, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ success: false, error: 'logout_cleanup_failed' }))
        }
        return
    }

    if (pathname === '/api/account' && req.method === 'POST') {
        let body
        try {
            body = await readRequestBody(req, res)
        } catch {
            return
        }
        try {
            const parsed = JSON.parse(body)
            const current = getSavedAccount()
            const toSave = {
                email: parsed.email !== undefined ? parsed.email : current.email,
                password: parsed.password !== undefined && parsed.password !== '' && parsed.password !== '••••••••••••' ? parsed.password : current.password,
                totpSecret: parsed.totpSecret !== undefined ? parsed.totpSecret : current.totpSecret,
                recoveryEmail: parsed.recoveryEmail !== undefined ? parsed.recoveryEmail : current.recoveryEmail,
                geoLocale: parsed.geoLocale || 'auto',
                langCode: parsed.langCode || 'en'
            }
            const ok = saveAccount(toSave)
            res.writeHead(200, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ success: ok }))
        } catch (e) {
            res.writeHead(400, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ success: false, error: e.message }))
        }
        return
    }

    if (pathname === '/api/account/login' && req.method === 'POST') {
        broadcast({ type: 'log', platform: 'desktop', time: getTimeStr(), msg: '🔑 正在启动微软官方登录窗口...', level: 'highlight' })
        runBotProcess('login')
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ success: true, message: '登录流程已启动，请在弹出的窗口中完成登录' }))
        return
    }

    if (pathname === '/api/profiles' && req.method === 'GET') {
        let db = null
        try {
            db = getDatabase(false)
            const profiles = listProfiles(db)
            const active = getActiveProfile(db)
            res.writeHead(200, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ success: true, profiles, activeProfileId: active?.id || null }))
        } catch (err) {
            res.writeHead(500, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ success: false, error: err.message }))
        } finally {
            try { db?.close() } catch (_) {}
        }
        return
    }

    if (pathname === '/api/profiles/active' && req.method === 'POST') {
        let body
        try {
            body = await readRequestBody(req, res)
        } catch {
            return
        }
        let db = null
        try {
            const { id } = JSON.parse(body || '{}')
            if (!id) {
                res.writeHead(400, { 'Content-Type': 'application/json' })
                res.end(JSON.stringify({ success: false, error: 'profile_id_required' }))
                return
            }
            db = getDatabase(false)
            const ok = setActiveProfile(db, id)
            const updatedActive = getActiveProfile(db)
            if (!ok) {
                res.writeHead(404, { 'Content-Type': 'application/json' })
                res.end(JSON.stringify({ success: false, error: 'profile_not_found' }))
                return
            }

            runtimeReplay.reset()
            dailySetProbeState.clear()
            activeProbeAccount = updatedActive?.email || null

            broadcast({ type: 'profileSwitched', profile: updatedActive })

            const currentDt = getSavedState(id)
            const currentMb = getSavedMobileState(id)
            broadcast({ type: 'state', platform: 'desktop', data: currentDt })
            broadcast({ type: 'mobileState', platform: 'mobile', data: currentMb })

            try {
                const liveDesktop = await fetchLiveMicrosoftState()
                if (liveDesktop) {
                    const saved = saveState(liveDesktop, id)
                    broadcast({ type: 'state', platform: 'desktop', data: saved })
                }
                const liveMobile = await fetchLiveMobileState()
                if (liveMobile) {
                    const savedMb = saveMobileState(liveMobile, id)
                    broadcast({ type: 'mobileState', platform: 'mobile', data: savedMb })
                }
            } catch (_) {}

            res.writeHead(200, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ success: true, activeProfile: updatedActive }))
        } catch (err) {
            res.writeHead(500, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ success: false, error: err.message }))
        } finally {
            try { db?.close() } catch (_) {}
        }
        return
    }

    if (pathname === '/api/profiles/save' && req.method === 'POST') {
        let body
        try {
            body = await readRequestBody(req, res)
        } catch {
            return
        }
        let db = null
        try {
            const parsed = JSON.parse(body || '{}')
            db = getDatabase(false)
            const saved = saveProfile(db, parsed)
            broadcast({ type: 'profileUpdated', profile: saved })
            res.writeHead(200, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ success: true, profile: saved }))
        } catch (err) {
            res.writeHead(400, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ success: false, error: err.message }))
        } finally {
            try { db?.close() } catch (_) {}
        }
        return
    }

    if (pathname.startsWith('/api/profiles/') && pathname.endsWith('/ai-config') && req.method === 'GET') {
        const match = pathname.match(/^\/api\/profiles\/([^/]+)\/ai-config$/)
        const profileId = match ? match[1] : null
        let db = null
        try {
            db = getDatabase(false)
            const cfg = getDecryptedAiConfig(db, profileId)
            if (!cfg) {
                res.writeHead(200, { 'Content-Type': 'application/json' })
                res.end(JSON.stringify({ success: true, aiConfig: null }))
                return
            }
            res.writeHead(200, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({
                success: true,
                aiConfig: {
                    enabled: Boolean(cfg.enabled),
                    provider: cfg.provider || 'openai',
                    baseUrl: cfg.baseUrl || 'https://api.openai.com/v1',
                    model: cfg.model || 'gpt-4o-mini',
                    temperature: cfg.temperature ?? 0.7,
                    apiKeyMasked: maskSecret(cfg.apiKey || ''),
                    hasKey: Boolean(cfg.apiKey && cfg.apiKey.trim())
                }
            }))
        } catch (err) {
            res.writeHead(500, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ success: false, error: err.message }))
        } finally {
            try { db?.close() } catch (_) {}
        }
        return
    }

    if (pathname.startsWith('/api/profiles/') && req.method === 'DELETE') {
        const match = pathname.match(/^\/api\/profiles\/([^/]+)$/)
        const profileId = match ? match[1] : null
        let db = null
        try {
            db = getDatabase(false)
            const ok = deleteProfile(db, profileId)
            const newActive = getActiveProfile(db)
            if (ok) {
                broadcast({ type: 'profileDeleted', profileId, activeProfile: newActive })
                res.writeHead(200, { 'Content-Type': 'application/json' })
                res.end(JSON.stringify({ success: true, activeProfile: newActive }))
            } else {
                res.writeHead(404, { 'Content-Type': 'application/json' })
                res.end(JSON.stringify({ success: false, error: 'profile_not_found' }))
            }
        } catch (err) {
            res.writeHead(500, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ success: false, error: err.message }))
        } finally {
            try { db?.close() } catch (_) {}
        }
        return
    }

    if (pathname === '/api/ai/test' && req.method === 'POST') {
        let body
        try {
            body = await readRequestBody(req, res)
        } catch {
            return
        }
        let db = null
        try {
            const { profileId, baseUrl, apiKey, model, provider } = JSON.parse(body || '{}')
            let stored = null
            if (profileId) {
                db = getDatabase(false)
                stored = getDecryptedAiConfig(db, profileId)
            }

            // S2 核心安全防御：校验目标地址与已保存密钥的绑定关系
            const { finalKey, targetUrl } = verifyAiUrlTargetBinding({
                requestUrl: baseUrl,
                requestProvider: provider,
                inputKey: apiKey,
                storedAiConfig: stored
            })

            const result = await testAiConnection({
                baseUrl: targetUrl || baseUrl || 'https://api.openai.com/v1',
                apiKey: finalKey,
                model: model || 'gpt-4o-mini',
                provider: provider || 'openai'
            })

            res.writeHead(200, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify(result))
        } catch (err) {
            res.writeHead(400, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ success: false, error: sanitizeErrorKey(err.message) }))
        } finally {
            try { db?.close() } catch (_) {}
        }
        return
    }

    if (pathname === '/api/ai/providers' && req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({
            success: true,
            providers: AI_PROVIDERS,
            categorized: getCategorizedProviders()
        }))
        return
    }

    if (pathname === '/api/ai/fetch-models' && req.method === 'POST') {
        let body
        try {
            body = await readRequestBody(req, res)
        } catch {
            return
        }
        let db = null
        try {
            const { profileId, baseUrl, apiKey, provider } = JSON.parse(body || '{}')
            let stored = null
            if (profileId) {
                db = getDatabase(false)
                stored = getDecryptedAiConfig(db, profileId)
            }

            let targetKey = (apiKey || '').trim()
            let targetBaseUrl = baseUrl || 'https://api.openai.com/v1'
            if (provider !== 'ollama' && provider !== 'lmstudio') {
                // S2 核心安全防御：校验目标地址与已保存密钥的绑定关系
                const verified = verifyAiUrlTargetBinding({
                    requestUrl: baseUrl,
                    requestProvider: provider,
                    inputKey: apiKey,
                    storedAiConfig: stored
                })
                targetKey = verified.finalKey
                if (verified.targetUrl) targetBaseUrl = verified.targetUrl
            }

            const result = await fetchAiModels({
                baseUrl: targetBaseUrl,
                apiKey: targetKey || 'local-key',
                provider: provider || 'openai'
            })

            res.writeHead(200, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify(result))
        } catch (err) {
            res.writeHead(400, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ success: false, error: sanitizeErrorKey(err.message) }))
        } finally {
            try { db?.close() } catch (_) {}
        }
        return
    }

    res.writeHead(404, { 'Content-Type': 'text/plain' })
    res.end('Not Found')
})

const envFilePath = path.join(__dirname, '.env')

function getSavedAccount() {
    try {
        if (fs.existsSync(envFilePath)) {
            const raw = fs.readFileSync(envFilePath, 'utf-8')
            const lines = raw.split('\n')
            const acc = {
                email: '',
                password: '',
                totpSecret: '',
                recoveryEmail: '',
                geoLocale: 'auto',
                langCode: 'en'
            }
            lines.forEach(l => {
                const match = l.match(/^\s*ACCOUNT_1_([A-Z_]+)\s*=\s*(.*)$/)
                if (match) {
                    const key = match[1]
                    const val = match[2].trim()
                    if (key === 'EMAIL') acc.email = val
                    if (key === 'PASSWORD') acc.password = val
                    if (key === 'TOTP_SECRET') acc.totpSecret = val
                    if (key === 'RECOVERY_EMAIL') acc.recoveryEmail = val
                    if (key === 'GEO_LOCALE') acc.geoLocale = val
                    if (key === 'LANG_CODE') acc.langCode = val
                }
            })
            return acc
        }
    } catch (e) {}
    return { email: '', password: '', totpSecret: '', recoveryEmail: '', geoLocale: 'auto', langCode: 'en' }
}

function getResolvedAccountRegion(email) {
    try {
        const savedAccount = getSavedAccount()
        if (savedAccount.geoLocale && savedAccount.geoLocale !== 'auto') {
            return savedAccount.geoLocale.toUpperCase()
        }
        const dbPath = getSessionDbPath()
        if (fs.existsSync(dbPath)) {
            const db = new DatabaseSync(dbPath)
            const targetEmail = email || savedAccount.email
            if (targetEmail) {
                const row = db.prepare('SELECT resolved_region FROM account_metadata WHERE email = ? LIMIT 1').get(targetEmail)
                if (row?.resolved_region) return row.resolved_region.toUpperCase()
            }
        }
    } catch (_) {}
    return 'US'
}

function saveAccount(acc) {
    try {
        const lines = [
            '# Microsoft Rewards Account Configuration',
            `ACCOUNT_1_EMAIL=${acc.email || ''}`,
            `ACCOUNT_1_PASSWORD=${acc.password || ''}`,
            `ACCOUNT_1_TOTP_SECRET=${acc.totpSecret || ''}`,
            `ACCOUNT_1_RECOVERY_EMAIL=${acc.recoveryEmail || ''}`,
            `ACCOUNT_1_GEO_LOCALE=${acc.geoLocale || 'auto'}`,
            `ACCOUNT_1_LANG_CODE=${acc.langCode || 'en'}`
        ]
        fs.writeFileSync(envFilePath, lines.join('\n') + '\n', 'utf-8')
        return true
    } catch (e) {
        return false
    }
}

const configFilePath = path.join(__dirname, 'config.json')

function getSavedConfig() {
    try {
        if (fs.existsSync(configFilePath)) {
            return JSON.parse(fs.readFileSync(configFilePath, 'utf-8'))
        }
    } catch (e) {}
    return {}
}

function isValidTimeZonePreference(timeZone) {
    if (timeZone === 'auto') return true
    if (typeof timeZone !== 'string' || !timeZone.trim()) return false
    try {
        new Intl.DateTimeFormat('en-US', { timeZone }).format(new Date())
        return true
    } catch {
        return false
    }
}

function saveConfig(newConf) {
    try {
        if (newConf?.display?.timeZone !== undefined && !isValidTimeZonePreference(newConf.display.timeZone)) return false
        const current = getSavedConfig()
        const merged = { ...current, ...newConf }
        fs.writeFileSync(configFilePath, JSON.stringify(merged, null, 4), 'utf-8')
        return true
    } catch (e) {
        return false
    }
}

async function sendTestWebhook(conf) {
    const testTitle = '🌟 Microsoft Rewards 测试推送通知'
    const account = getSavedAccount()
    const displayEmail = account.email ? account.email.replace(/^(.{1,2}).*(@.*)$/, '$1***$2') : 'user@example.com'
    const testContent = `恭喜！您的机器人推送通道已成功配置且连接畅通！\n账号: ${displayEmail}\n测试时间: ${new Date().toLocaleString()}`

    // 1. Discord Webhook
    if (conf.type === 'discord' && conf.url) {
        const res = await fetch(conf.url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                username: 'Microsoft Rewards Bot',
                avatar_url: 'https://img-prod-cms-rt-microsoft-com.akamaized.net/cms/api/am/imageFileData/RE1Mu3b?ver=5c31',
                embeds: [{
                    title: testTitle,
                    description: testContent,
                    color: 3447003,
                    timestamp: new Date().toISOString()
                }]
            })
        })
        return { success: res.ok, status: res.status }
    }

    // 2. Telegram Bot
    if (conf.type === 'telegram' && conf.botToken && conf.chatId) {
        const url = `https://api.telegram.org/bot${conf.botToken}/sendMessage`
        const res = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                chat_id: conf.chatId,
                text: `*${testTitle}*\n\n${testContent}`,
                parse_mode: 'Markdown'
            })
        })
        return { success: res.ok, status: res.status }
    }

    // 3. ServerChan / PushPlus / DingTalk / WeCom / Custom HTTP Webhook
    if (conf.url) {
        const res = await fetch(conf.url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                title: testTitle,
                desp: testContent,
                text: testContent,
                msgtype: 'text',
                content: { text: testContent }
            })
        })
        return { success: res.ok, status: res.status }
    }

    return { success: false, error: '未提供有效的 Webhook URL 或 Bot 配置' }
}

async function dispatchHitlWebhookAlert(notification) {
    if (!notification) return
    try {
        const conf = getSavedConfig()
        const webhook = conf.webhook
        if (!webhook) return

        // 1. Discord Webhook
        if (webhook.discord?.enabled && webhook.discord?.url) {
            const payload = formatHitlWebhookPayload({ type: 'discord' }, notification)
            if (payload) {
                await fetch(webhook.discord.url, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(payload)
                }).catch(() => {})
            }
        }

        // 2. Telegram Bot
        if (webhook.telegram?.enabled && webhook.telegram?.botToken && webhook.telegram?.chatId) {
            const payload = formatHitlWebhookPayload({
                type: 'telegram',
                chatId: webhook.telegram.chatId
            }, notification)
            if (payload) {
                const url = `https://api.telegram.org/bot${webhook.telegram.botToken}/sendMessage`
                await fetch(url, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(payload)
                }).catch(() => {})
            }
        }
    } catch (_) {}
}

export { server, readRequestBody }

const isDirectRun = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)

if (isDirectRun && process.env.NODE_ENV !== 'test' && !process.env.MS_DISABLE_AUTO_LISTEN) {
    server.listen(PORT, HOST, () => {
        console.log(`\n🌟 Microsoft Rewards Fluent Web 控制台已启动: http://${HOST}:${PORT}`)
        console.log(`🔒 控制台已启用带外安全配对保护`)
        console.log(`💡 首次连接请在配对页面输入 sessions/.web_pairing_secret 中的配对凭据完成授权`)
        console.log(`📱 正在监听浏览器连接...\n`)
        scheduleBackgroundSync()
    })
}
