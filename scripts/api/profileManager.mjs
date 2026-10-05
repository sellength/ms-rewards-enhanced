import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import https from 'node:https'
import http from 'node:http'
import net from 'node:net'
import { encryptSecret, decryptSecret, decryptSecretWithMeta, maskSecret } from './profileCrypto.mjs'
import { validateAndNormalizeAiUrl, sanitizeErrorKey, verifyDnsResolutionSecurity, secureFetchWithPinnedDns } from './aiUrlSecurity.mjs'

async function probePort(port, host = '127.0.0.1', timeout = 100) {
    return new Promise((resolve) => {
        const socket = new net.Socket()
        socket.setTimeout(timeout)
        socket.once('connect', () => { socket.destroy(); resolve(true) })
        socket.once('timeout', () => { socket.destroy(); resolve(false) })
        socket.once('error', () => { socket.destroy(); resolve(false) })
        socket.connect(port, host)
    })
}

/**
 * 自动感知并挂载本地科学上网代理环境变量 (针对境外端点如 Google Gemini、OpenAI 等)
 */
export async function ensureProxyEnvironment() {
    if (process.env.HTTPS_PROXY || process.env.https_proxy || process.env.ALL_PROXY || process.env.all_proxy) {
        return process.env.HTTPS_PROXY || process.env.https_proxy || process.env.ALL_PROXY || process.env.all_proxy
    }
    // 常见代理客户端本地端口: 7891 (Surge), 7890 (Clash), 10808 (v2rayN), 1087 (Shadowsocks)
    for (const port of [7891, 7890, 10808, 1087]) {
        if (await probePort(port)) {
            const proxyUrl = `http://127.0.0.1:${port}`
            process.env.https_proxy = proxyUrl
            process.env.http_proxy = proxyUrl
            return proxyUrl
        }
    }
    return null
}

/**
 * 初始化 profiles 数据表与历史数据平滑迁移
 * @param {import('node:sqlite').DatabaseSync} db
 */
export function initProfileSchema(db) {
    db.exec(`
        CREATE TABLE IF NOT EXISTS user_profiles (
            id              TEXT PRIMARY KEY,
            name            TEXT NOT NULL,
            email           TEXT UNIQUE COLLATE NOCASE,
            region          TEXT DEFAULT 'US',
            ai_config_enc   TEXT,
            proxy_config    TEXT,
            preferences     TEXT,
            is_active       INTEGER DEFAULT 0,
            created_at      INTEGER NOT NULL,
            updated_at      INTEGER NOT NULL
        );
    `)

    try {
        const cols = db.prepare("PRAGMA table_info(user_profiles)").all() || []
        const hasRegion = cols.some(c => c.name === 'region')
        if (!hasRegion) {
            db.exec("ALTER TABLE user_profiles ADD COLUMN region TEXT DEFAULT 'US'")
        }
    } catch (_) {}

    // 检查是否存在 profile，若为空则从已有 sessions 表平滑迁移
    const countRow = db.prepare('SELECT count(*) as count FROM user_profiles').get()
    if (!countRow || Number(countRow.count) === 0) {
        let existingEmail = null
        try {
            const sessionRow = db.prepare("SELECT email FROM sessions WHERE email IS NOT NULL AND email != '' LIMIT 1").get()
            if (sessionRow?.email) {
                existingEmail = sessionRow.email
            }
        } catch (_) {}

        const now = Date.now()
        const defaultEmail = existingEmail || null
        const defaultName = defaultEmail ? defaultEmail.split('@')[0] : '默认主账号'
        let defaultRegion = 'US'
        if (defaultEmail) {
            try {
                const meta = db.prepare("SELECT resolved_region FROM account_metadata WHERE email = ?").get(defaultEmail)
                if (meta?.resolved_region) defaultRegion = meta.resolved_region
            } catch (_) {}
        }

        db.prepare(`
            INSERT INTO user_profiles (id, name, email, region, ai_config_enc, proxy_config, preferences, is_active, created_at, updated_at)
            VALUES (?, ?, ?, ?, NULL, NULL, NULL, 1, ?, ?)
        `).run('profile_default', defaultName, defaultEmail, defaultRegion, now, now)
    }

    // 自愈检查：若已有 profile 但未绑定 email（例如历史创建的 profile_default），且 sessions 表中已有有效会话，自动关联补全
    try {
        const unbound = db.prepare("SELECT id, name FROM user_profiles WHERE (email IS NULL OR email = '') AND is_active = 1 LIMIT 1").get()
            || (Number(countRow?.count) === 1 ? db.prepare("SELECT id, name FROM user_profiles WHERE (email IS NULL OR email = '') LIMIT 1").get() : null)
        if (unbound) {
            const sessionRow = db.prepare("SELECT email FROM sessions WHERE email IS NOT NULL AND email != '' ORDER BY updated_at DESC LIMIT 1").get()
            if (sessionRow?.email) {
                const autoEmail = sessionRow.email
                let autoRegion = 'US'
                try {
                    const meta = db.prepare("SELECT resolved_region FROM account_metadata WHERE email = ?").get(autoEmail)
                    if (meta?.resolved_region) autoRegion = meta.resolved_region
                } catch (_) {}
                const newName = (!unbound.name || unbound.name === '新建账号' || unbound.name === '默认主账号')
                    ? autoEmail.split('@')[0]
                    : unbound.name
                db.prepare(`
                    UPDATE user_profiles
                    SET email = ?, name = ?, region = ?, updated_at = ?
                    WHERE id = ?
                `).run(autoEmail, newName, autoRegion, Date.now(), unbound.id)
            }
        }
    } catch (_) {}
}

/**
 * 获取所有 Profiles 列表 (带授权状态与脱敏 AI 配置及区域)
 * @param {import('node:sqlite').DatabaseSync} db
 */
export function listProfiles(db) {
    initProfileSchema(db)
    const rows = db.prepare('SELECT * FROM user_profiles ORDER BY is_active DESC, updated_at DESC').all() || []
    
    return rows.map(row => {
        let aiConfig = null
        let hasAiKey = false
        if (row.ai_config_enc) {
            try {
                const dec = decryptSecret(row.ai_config_enc)
                if (dec) {
                    const parsed = JSON.parse(dec)
                    hasAiKey = Boolean(parsed.apiKey && String(parsed.apiKey).trim())
                    aiConfig = {
                        enabled: Boolean(parsed.enabled),
                        provider: parsed.provider || 'openai',
                        baseUrl: parsed.baseUrl || 'https://api.openai.com/v1',
                        model: parsed.model || 'gpt-4o-mini',
                        temperature: typeof parsed.temperature === 'number' ? parsed.temperature : 0.7,
                        apiKeyMasked: maskSecret(parsed.apiKey || '')
                    }
                }
            } catch (_) {}
        }

        // 检查 sessions 表中该 profile 的登录有效性
        let desktopAuthed = false
        let mobileAuthed = false
        let effectiveEmail = row.email
        if (!effectiveEmail && (row.is_active || rows.length === 1)) {
            try {
                const sRow = db.prepare("SELECT email FROM sessions WHERE email IS NOT NULL AND email != '' ORDER BY updated_at DESC LIMIT 1").get()
                if (sRow?.email) effectiveEmail = sRow.email
            } catch (_) {}
        }

        if (effectiveEmail) {
            try {
                const dRow = db.prepare("SELECT storage_state FROM sessions WHERE platform = 'desktop' AND email = ?").get(effectiveEmail)
                if (dRow?.storage_state) {
                    const storage = JSON.parse(dRow.storage_state)
                    desktopAuthed = Array.isArray(storage.cookies) && storage.cookies.length > 0
                }
                const mRow = db.prepare("SELECT storage_state FROM sessions WHERE platform = 'mobile' AND email = ?").get(effectiveEmail)
                if (mRow?.storage_state) {
                    const storage = JSON.parse(mRow.storage_state)
                    mobileAuthed = Array.isArray(storage.cookies) && storage.cookies.length > 0
                }
            } catch (_) {}
        }

        let region = row.region || null
        if (!region && effectiveEmail) {
            try {
                const meta = db.prepare("SELECT resolved_region FROM account_metadata WHERE email = ?").get(effectiveEmail)
                if (meta?.resolved_region) region = meta.resolved_region
            } catch (_) {}
        }
        if (!region) region = 'US'

        let preferences = null
        if (row.preferences) {
            try { preferences = JSON.parse(row.preferences) } catch (_) {}
        }

        return {
            id: row.id,
            name: row.name,
            email: row.email,
            region,
            isActive: Boolean(row.is_active),
            hasAiConfig: hasAiKey,
            aiConfig,
            desktopAuthed,
            mobileAuthed,
            proxyConfig: row.proxy_config || null,
            preferences,
            createdAt: row.created_at,
            updatedAt: row.updated_at
        }
    })
}

/**
 * 获取当前活跃的 Profile
 * @param {import('node:sqlite').DatabaseSync} db
 */
export function getActiveProfile(db) {
    initProfileSchema(db)
    const active = db.prepare('SELECT * FROM user_profiles WHERE is_active = 1 LIMIT 1').get()
    if (active) return active
    return db.prepare('SELECT * FROM user_profiles ORDER BY updated_at DESC LIMIT 1').get() || null
}

/**
 * 切换活跃 Profile
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} profileId
 */
export function setActiveProfile(db, profileId) {
    initProfileSchema(db)
    const target = db.prepare('SELECT id FROM user_profiles WHERE id = ?').get(profileId)
    if (!target) return false

    db.exec('BEGIN TRANSACTION')
    try {
        db.prepare('UPDATE user_profiles SET is_active = 0').run()
        db.prepare('UPDATE user_profiles SET is_active = 1, updated_at = ? WHERE id = ?').run(Date.now(), profileId)
        db.exec('COMMIT')
        return true
    } catch (_) {
        try { db.exec('ROLLBACK') } catch (_) {}
        return false
    }
}

/**
 * 保存或更新 Profile (包含 AI API 加密存储与区域绑定)
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {Object} data
 */
export function saveProfile(db, data) {
    initProfileSchema(db)
    const now = Date.now()
    const id = data.id || `profile_${crypto.randomUUID().slice(0, 8)}`
    const name = (data.name || '').trim() || (data.email ? data.email.split('@')[0] : '新建账号')
    const email = data.email ? data.email.trim() : null
    let region = (data.region || '').trim().toUpperCase()

    // 查询旧 profile 用于保留未修改的加密字段
    const existing = db.prepare('SELECT * FROM user_profiles WHERE id = ?').get(id)
    if (!region) {
        region = existing?.region || 'US'
    }

    let aiConfigEnc = existing?.ai_config_enc || null
    if (data.aiConfig) {
        let existingDecrypted = {}
        if (existing?.ai_config_enc) {
            try {
                existingDecrypted = JSON.parse(decryptSecret(existing.ai_config_enc))
            } catch (_) {}
        }

        const inputKey = (data.aiConfig.apiKey || '').trim()
        let finalApiKey = existingDecrypted.apiKey || ''
        // 只有当传入的新 key 不是脱敏掩码，且非空时才更新
        if (inputKey && !inputKey.includes('••••')) {
            finalApiKey = inputKey
        }

        const toEncrypt = {
            enabled: data.aiConfig.enabled !== undefined ? Boolean(data.aiConfig.enabled) : (existingDecrypted.enabled ?? true),
            provider: data.aiConfig.provider || existingDecrypted.provider || 'openai',
            baseUrl: data.aiConfig.baseUrl || existingDecrypted.baseUrl || 'https://api.openai.com/v1',
            model: data.aiConfig.model || existingDecrypted.model || 'gpt-4o-mini',
            temperature: typeof data.aiConfig.temperature === 'number' ? data.aiConfig.temperature : (existingDecrypted.temperature ?? 0.7),
            apiKey: finalApiKey
        }

        aiConfigEnc = encryptSecret(JSON.stringify(toEncrypt))
    }

    const proxyConfig = data.proxyConfig !== undefined ? (typeof data.proxyConfig === 'string' ? data.proxyConfig : JSON.stringify(data.proxyConfig)) : (existing?.proxy_config ?? null)
    const preferences = data.preferences !== undefined ? (typeof data.preferences === 'string' ? data.preferences : JSON.stringify(data.preferences)) : (existing?.preferences ?? null)

    const isFirstProfile = Number(db.prepare('SELECT count(*) as count FROM user_profiles').get()?.count || 0) === 0
    const isActive = existing ? existing.is_active : (isFirstProfile ? 1 : 0)

    db.prepare(`
        INSERT INTO user_profiles (id, name, email, region, ai_config_enc, proxy_config, preferences, is_active, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
            name = excluded.name,
            email = excluded.email,
            region = excluded.region,
            ai_config_enc = excluded.ai_config_enc,
            proxy_config = excluded.proxy_config,
            preferences = excluded.preferences,
            updated_at = excluded.updated_at
    `).run(
        id,
        name,
        email,
        region,
        aiConfigEnc,
        proxyConfig,
        preferences,
        isActive,
        existing ? existing.created_at : now,
        now
    )

    if (email && region) {
        try {
            db.prepare(`
                INSERT INTO account_metadata (email, resolved_region, updated_at)
                VALUES (?, ?, ?)
                ON CONFLICT(email)
                DO UPDATE SET resolved_region = excluded.resolved_region, updated_at = excluded.updated_at
            `).run(email, region, now)
        } catch (_) {}
    }

    return db.prepare('SELECT * FROM user_profiles WHERE id = ?').get(id)
}

/**
 * 删除 Profile
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} profileId
 */
export function deleteProfile(db, profileId) {
    initProfileSchema(db)
    const target = db.prepare('SELECT * FROM user_profiles WHERE id = ?').get(profileId)
    if (!target) return false

    db.exec('BEGIN TRANSACTION')
    try {
        if (target.email) {
            const hasOther = db.prepare('SELECT id FROM user_profiles WHERE email = ? AND id != ?').get(target.email, profileId)
            if (!hasOther) {
                db.prepare('DELETE FROM sessions WHERE email = ?').run(target.email)
                db.prepare('DELETE FROM account_metadata WHERE email = ?').run(target.email)
            }
        }
        db.prepare('DELETE FROM user_profiles WHERE id = ?').run(profileId)

        if (target.is_active === 1) {
            const next = db.prepare('SELECT id FROM user_profiles ORDER BY updated_at DESC LIMIT 1').get()
            if (next?.id) {
                db.prepare('UPDATE user_profiles SET is_active = 1 WHERE id = ?').run(next.id)
            }
        }
        db.exec('COMMIT')

        // 彻底删除该 Profile 关联的本地任务状态与进度缓存文件
        try {
            const projectRoot = path.resolve('.')
            const sessionDir = path.join(projectRoot, 'sessions')
            const p1 = path.join(sessionDir, `daily_state_${profileId}.json`)
            const p2 = path.join(sessionDir, `mobile_state_${profileId}.json`)
            if (fs.existsSync(p1)) fs.unlinkSync(p1)
            if (fs.existsSync(p2)) fs.unlinkSync(p2)
        } catch (_) {}

        return true
    } catch (_) {
        try { db.exec('ROLLBACK') } catch (_) {}
        return false
    }
}

/**
 * 获取指定 Profile 解密后的完整 AI 配置 (用于执行引擎调用或测试)
 * 安全与幂等设计：
 * - 正常读取属于只读操作，使用当前主密钥解密成功时绝不触发任何 UPDATE 与写操作。
 * - 仅当且仅当密文为历史旧格式或历史候选旧密钥解密成功时，才触发一次性平滑迁移。
 * - 解密失败直接返回 null，绝不覆盖或损坏原有密文。
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} profileId
 */
export function getDecryptedAiConfig(db, profileId) {
    initProfileSchema(db)
    const row = db.prepare('SELECT ai_config_enc FROM user_profiles WHERE id = ?').get(profileId)
    if (!row?.ai_config_enc) return null
    try {
        const { plaintext, needsMigration } = decryptSecretWithMeta(row.ai_config_enc)
        if (!plaintext) return null

        // 仅在确认旧格式/旧密钥时做一次平滑升级迁移；正常读完全只读
        if (needsMigration) {
            try {
                const reEnc = encryptSecret(plaintext)
                if (reEnc) {
                    db.prepare('UPDATE user_profiles SET ai_config_enc = ?, updated_at = ? WHERE id = ?').run(reEnc, Date.now(), profileId)
                }
            } catch (_) {}
        }

        return JSON.parse(plaintext)
    } catch (_) {
        return null
    }
}

/**
 * 测试 AI API 连通性
 * @param {Object} params
 * @param {string} params.baseUrl
 * @param {string} params.apiKey
 * @param {string} [params.model]
 * @param {string} [params.provider]
 * @returns {Promise<{ success: boolean, latencyMs?: number, model?: string, error?: string }>}
 */
export async function testAiConnection({ baseUrl, apiKey, model = 'gpt-4o-mini', provider }) {
    if (!baseUrl || !apiKey) {
        return { success: false, error: '缺少 API Base URL 或 API Key' }
    }

    let validatedBaseUrl
    try {
        validatedBaseUrl = validateAndNormalizeAiUrl(baseUrl, provider)
    } catch (urlErr) {
        return { success: false, error: urlErr.message }
    }

    await ensureProxyEnvironment()

    let urlStr = validatedBaseUrl.replace(/\/+$/, '')
    if (!urlStr.endsWith('/chat/completions')) {
        urlStr += '/chat/completions'
    }

    const payload = JSON.stringify({
        model: model || 'gpt-4o-mini',
        messages: [{ role: 'user', content: 'Ping' }],
        max_tokens: 5
    })

    const startTime = Date.now()
    try {
        const headers = {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${apiKey}`
        }
        if (provider === 'openrouter' || urlStr.includes('openrouter.ai')) {
            headers['HTTP-Referer'] = 'https://github.com/TheNetsky/Microsoft-Rewards-Script'
            headers['X-Title'] = 'Microsoft Rewards Bot'
        }
        if (provider === 'azure' || urlStr.includes('openai.azure.com')) {
            headers['api-key'] = apiKey
        }

        const res = await secureFetchWithPinnedDns(urlStr, {
            method: 'POST',
            headers,
            body: payload,
            timeout: 12000
        })

        const latencyMs = Date.now() - startTime

        // S2 核心防御：检测到 3xx 重定向，禁止跟随以防跨主机窃取凭据
        if (res.status >= 300 && res.status < 400) {
            return {
                success: false,
                error: `安全防护拦截 (S2): 目标端点返回了重定向 (HTTP ${res.status})。为防止 API Key 跨域泄露，系统禁止跟随跨站重定向，请检查 Base URL 配置`
            }
        }

        const responseBody = await res.text()

        if (res.ok) {
            try {
                const parsed = JSON.parse(responseBody)
                const usedModel = parsed.model || model
                return { success: true, latencyMs, model: usedModel }
            } catch (_) {
                return { success: true, latencyMs, model }
            }
        } else {
            let errMsg = `HTTP ${res.status}`
            if (res.status === 401) {
                errMsg = 'API Key 无效或未授权 (HTTP 401)'
            } else if (res.status === 403) {
                errMsg = '服务商拒绝访问或当前区域受限 (HTTP 403)'
            } else if (res.status === 404) {
                errMsg = '未找到端点或模型不存在 (HTTP 404)，请检查 Base URL 与模型名称'
            } else if (res.status === 429) {
                errMsg = '请求频率超限或账户配额/余额已耗尽 (HTTP 429 Rate Limit)'
            }
            try {
                const parsed = JSON.parse(responseBody)
                const errorObj = Array.isArray(parsed) ? parsed[0]?.error : parsed?.error
                const detail = errorObj?.message || errorObj?.code || (typeof errorObj === 'string' ? errorObj : '')
                if (detail) {
                    errMsg += `: ${detail}`
                }
            } catch (_) {
                if (responseBody && !errMsg.includes(':')) {
                    errMsg += `: ${responseBody.slice(0, 100)}`
                }
            }
            return { success: false, error: sanitizeErrorKey(errMsg, apiKey), latencyMs }
        }
    } catch (err) {
        if (err.message && (err.message.includes('安全拦截') || err.message.includes('DNS 解析'))) {
            return {
                success: false,
                error: sanitizeErrorKey(err.message, apiKey)
            }
        }
        const isTimeout = err.name === 'TimeoutError' || err.message.includes('timeout')
        let hint = ''
        if (urlStr.includes('googleapis.com') || urlStr.includes('openai.com') || urlStr.includes('openrouter.ai')) {
            hint = ' (若在中国大陆网络，请开启科学上网代理客户端如 Surge 开启增强模式或配置本地代理)'
        }
        const rawErr = isTimeout ? `请求超时 (超过 12 秒无响应)${hint}` : `网络连接异常: ${err.message}${hint}`
        return {
            success: false,
            error: sanitizeErrorKey(rawErr, apiKey)
        }
    }
}

/**
 * 动态从服务商获取支持的模型列表 (遵循标准 GET /models 规范)
 * @param {object} params
 * @param {string} params.baseUrl
 * @param {string} params.apiKey
 * @param {string} [params.provider]
 * @returns {Promise<{ success: boolean, models?: string[], error?: string }>}
 */
export async function fetchAiModels({ baseUrl, apiKey, provider }) {
    if (!baseUrl || !apiKey) {
        return { success: false, error: '请先提供有效的 Base URL 和 API Key' }
    }

    let validatedBaseUrl
    try {
        validatedBaseUrl = validateAndNormalizeAiUrl(baseUrl, provider)
    } catch (urlErr) {
        return { success: false, error: urlErr.message }
    }

    await ensureProxyEnvironment()

    let urlStr = validatedBaseUrl.trim().replace(/\/+$/, '')
    urlStr = urlStr.replace(/\/chat\/completions$/, '')
    if (!urlStr.endsWith('/models')) {
        urlStr += '/models'
    }

    try {
        const headers = {
            'Authorization': `Bearer ${apiKey}`,
            'Accept': 'application/json'
        }
        if (provider === 'openrouter' || urlStr.includes('openrouter.ai')) {
            headers['HTTP-Referer'] = 'https://github.com/TheNetsky/Microsoft-Rewards-Script'
            headers['X-Title'] = 'Microsoft Rewards Bot'
        }
        if (provider === 'azure' || urlStr.includes('openai.azure.com')) {
            headers['api-key'] = apiKey
        }

        const res = await secureFetchWithPinnedDns(urlStr, {
            method: 'GET',
            headers,
            timeout: 10000
        })

        // S2 核心防御：检测到 3xx 重定向，禁止跟随以防跨主机窃取凭据
        if (res.status >= 300 && res.status < 400) {
            return {
                success: false,
                error: `安全防护拦截 (S2): 目标端点返回了重定向 (HTTP ${res.status})。为防止 API Key 跨域泄露，系统禁止跟随跨站重定向`
            }
        }

        const responseBody = await res.text()
        if (res.ok) {
            try {
                const parsed = JSON.parse(responseBody)
                const list = parsed.data || parsed.models || (Array.isArray(parsed) ? parsed : [])
                const rawIds = list
                    .map(item => (typeof item === 'string' ? item : item?.id || item?.name))
                    .filter(Boolean)
                const modelIds = Array.from(new Set(rawIds.flatMap(id => {
                    const clean = id.replace(/^models\//, '')
                    return clean !== id ? [clean, id] : [id]
                })))
                return { success: true, models: modelIds }
            } catch (e) {
                return { success: false, error: `解析服务商模型返回失败: ${e.message}` }
            }
        } else {
            let errMsg = `拉取模型失败 (HTTP ${res.status})`
            if (res.status === 401) errMsg = 'API Key 无效，无法拉取模型列表 (HTTP 401)'
            else if (res.status === 404) errMsg = '该服务商未开放 /models 接口或端点错误 (HTTP 404)'
            return { success: false, error: sanitizeErrorKey(errMsg, apiKey) }
        }
    } catch (err) {
        if (err.message && (err.message.includes('安全拦截') || err.message.includes('DNS 解析'))) {
            return {
                success: false,
                error: sanitizeErrorKey(err.message, apiKey)
            }
        }
        const isTimeout = err.name === 'TimeoutError' || err.message.includes('timeout')
        let hint = ''
        if (urlStr.includes('googleapis.com') || urlStr.includes('openai.com') || urlStr.includes('openrouter.ai')) {
            hint = ' (若在中国大陆网络，请开启科学上网代理客户端如 Surge 开启增强模式或配置本地代理)'
        }
        const rawErr = isTimeout ? `获取模型列表超时 (10秒)${hint}` : `网络异常: ${err.message}${hint}`
        return {
            success: false,
            error: sanitizeErrorKey(rawErr, apiKey)
        }
    }
}

