import crypto from 'node:crypto'

export const DEVICE_COOKIE_NAME = 'ms_device_token'
export const DEFAULT_DEVICE_COOKIE_MAX_AGE = 90 * 24 * 3600 // 90 天
export const DEFAULT_DEVICE_TTL_MS = 90 * 24 * 3600 * 1000 // 服务端长期凭证寿命：90 天
export const SLIDING_RENEW_INTERVAL_MS = 24 * 3600 * 1000 // 滑动续期间隔：1 天防抖

/**
 * 净化客户端设备名称 (User-Agent)，阻断 XSS 注入与异常控制字符
 * @param {string} rawName
 * @returns {string}
 */
export function sanitizeDeviceName(rawName) {
    if (!rawName || typeof rawName !== 'string') return 'Browser'
    // 剔除不可见控制字符与 ASCII 控制字符
    let clean = rawName.replace(/[\x00-\x1F\x7F-\x9F]/g, '')
    // 剥离完整 HTML 标签
    clean = clean.replace(/<[^>]*>/g, '')
    // 过滤可能导致 HTML 属性逃逸或注入的危险字符
    clean = clean.replace(/[<>"'&/\\`]/g, '')
    clean = clean.trim()
    if (!clean) return 'Browser'
    return clean.slice(0, 64)
}

/**
 * 获取或初始化全局随机时代版本 (auth_epoch)
 * auth_epoch 存储于 web_auth_meta，为 32 字节高熵随机 Hex，与用户人类密码无任何数学关联。
 * 即使数据库泄露，攻击者也绝对无法通过彩虹表或字典猜测用户配对密码。
 * @param {import('node:sqlite').DatabaseSync} db
 * @returns {string}
 */
export function getOrCreateAuthEpoch(db) {
    db.exec(`
        CREATE TABLE IF NOT EXISTS web_auth_meta (
            key   TEXT PRIMARY KEY,
            value TEXT NOT NULL
        );
    `)

    let row = null
    try {
        row = db.prepare("SELECT value FROM web_auth_meta WHERE key = 'auth_epoch'").get()
    } catch (_) {}

    if (row?.value) {
        return row.value
    }

    const newEpoch = crypto.randomBytes(32).toString('hex')
    try {
        db.prepare("INSERT INTO web_auth_meta (key, value) VALUES ('auth_epoch', ?)").run(newEpoch)
        return newEpoch
    } catch (insertErr) {
        // 并发写入时重新查询已由并发事务写入的值
        try {
            const retry = db.prepare("SELECT value FROM web_auth_meta WHERE key = 'auth_epoch'").get()
            if (retry?.value) return retry.value
        } catch (_) {}
        // 核心安全防御：若持久化失败且重读依然无值，坚决 fail closed 抛出异常，绝不返回未持久化的内存伪值
        throw new Error(`认证版本标识 (auth_epoch) 持久化失败: ${insertErr?.message || '数据库写入异常'}`)
    }
}

/**
 * 轮换全局随机时代版本 (auth_epoch)
 * 当执行全设备撤销或管理端重置时调用，瞬时使所有既往历史设备凭证全量失效
 * @param {import('node:sqlite').DatabaseSync} db
 * @returns {string} 新的 auth_epoch
 */
export function rotateAuthEpoch(db) {
    const newEpoch = crypto.randomBytes(32).toString('hex')
    db.prepare(`
        INSERT INTO web_auth_meta (key, value) VALUES ('auth_epoch', ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `).run(newEpoch)
    return newEpoch
}

/**
 * 初始化已授权 Web 客户端设备数据表并安全平滑升级既有结构
 * 核心安全保证：
 * 1. 绝不将用户自设配对密码的哈希写入任何表或字段
 * 2. 包含 auth_epoch（随机版本）与 expires_at（服务端强制过期校验）
 * @param {import('node:sqlite').DatabaseSync} db
 */
export function initClientAuthSchema(db) {
    getOrCreateAuthEpoch(db)

    // 检测既有表结构
    let columns = []
    try {
        columns = db.prepare("PRAGMA table_info(authorized_web_clients)").all()
    } catch (_) {}

    const colNames = new Set(columns.map(c => c.name))

    // 若包含已废弃的 pairing_secret_hash，无损迁移并物理剔除该字段，杜绝弱密码离线哈希爆破风险
    if (colNames.has('pairing_secret_hash')) {
        const currentEpoch = getOrCreateAuthEpoch(db)
        const now = Date.now()
        const defaultExpires = now + DEFAULT_DEVICE_TTL_MS

        db.exec(`
            CREATE TABLE authorized_web_clients_new (
                device_id           TEXT PRIMARY KEY,
                secret_hash         TEXT NOT NULL,
                auth_epoch          TEXT NOT NULL,
                name                TEXT,
                created_at          INTEGER NOT NULL,
                expires_at          INTEGER NOT NULL,
                last_used_at        INTEGER NOT NULL,
                revoked_at          INTEGER DEFAULT NULL
            );
        `)

        const oldRows = db.prepare('SELECT device_id, secret_hash, name, created_at, last_used_at, revoked_at FROM authorized_web_clients').all()
        const insertStmt = db.prepare(`
            INSERT INTO authorized_web_clients_new (device_id, secret_hash, auth_epoch, name, created_at, expires_at, last_used_at, revoked_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `)
        for (const r of oldRows) {
            insertStmt.run(r.device_id, r.secret_hash, currentEpoch, r.name, r.created_at, defaultExpires, r.last_used_at, r.revoked_at)
        }

        db.exec(`
            DROP TABLE authorized_web_clients;
            ALTER TABLE authorized_web_clients_new RENAME TO authorized_web_clients;
            CREATE INDEX idx_authorized_web_clients_revoked ON authorized_web_clients (revoked_at);
            CREATE INDEX idx_authorized_web_clients_expires ON authorized_web_clients (expires_at);
        `)
        return
    }

    db.exec(`
        CREATE TABLE IF NOT EXISTS authorized_web_clients (
            device_id           TEXT PRIMARY KEY,
            secret_hash         TEXT NOT NULL,
            auth_epoch          TEXT NOT NULL,
            name                TEXT,
            created_at          INTEGER NOT NULL,
            expires_at          INTEGER NOT NULL,
            last_used_at        INTEGER NOT NULL,
            revoked_at          INTEGER DEFAULT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_authorized_web_clients_revoked ON authorized_web_clients (revoked_at);
        CREATE INDEX IF NOT EXISTS idx_authorized_web_clients_expires ON authorized_web_clients (expires_at);
    `)

    // 若缺少 auth_epoch 或 expires_at 列，平滑增列
    if (columns.length > 0) {
        if (!colNames.has('auth_epoch')) {
            const epoch = getOrCreateAuthEpoch(db)
            db.exec(`ALTER TABLE authorized_web_clients ADD COLUMN auth_epoch TEXT DEFAULT '${epoch}'`)
        }
        if (!colNames.has('expires_at')) {
            const defExp = Date.now() + DEFAULT_DEVICE_TTL_MS
            db.exec(`ALTER TABLE authorized_web_clients ADD COLUMN expires_at INTEGER DEFAULT ${defExp}`)
        }
    }
}

/**
 * 为成功配对的客户端浏览器创建高熵独立长期凭证
 * 凭证由客户端通过 HttpOnly Cookie 保留，数据库仅持久化其 SHA-256 摘要与服务端过期时间
 * 绝不在数据库存储任何与配对密码相关的哈希值
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string|object} pairingSecretOrMeta 密码参数或元数据对象 (向下兼容)
 * @param {object} [maybeMeta] 设备辅助信息 (如名称/User-Agent标识)
 * @param {object} [options] 配置选项 (如 ttlMs)
 * @returns {{ deviceId: string, deviceSecret: string, cookieValue: string, expiresAt: number }}
 */
export function createAuthorizedClient(db, pairingSecretOrMeta = {}, maybeMeta = {}, options = {}) {
    initClientAuthSchema(db)

    let metadata = {}
    let opt = {}
    if (typeof pairingSecretOrMeta === 'object' && pairingSecretOrMeta !== null) {
        metadata = pairingSecretOrMeta
        opt = maybeMeta || {}
    } else {
        metadata = maybeMeta || {}
        opt = options || {}
    }

    const deviceId = `dev_${crypto.randomBytes(16).toString('hex')}`
    const deviceSecret = crypto.randomBytes(32).toString('hex')
    const secretHash = crypto.createHash('sha256').update(deviceSecret).digest('hex')
    const authEpoch = getOrCreateAuthEpoch(db)
    const sanitizedName = sanitizeDeviceName(metadata.name)
    const now = Date.now()
    const ttlMs = Number(opt.ttlMs) > 0 ? Number(opt.ttlMs) : DEFAULT_DEVICE_TTL_MS
    const expiresAt = now + ttlMs

    db.prepare(`
        INSERT INTO authorized_web_clients (device_id, secret_hash, auth_epoch, name, created_at, expires_at, last_used_at, revoked_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, NULL)
    `).run(
        deviceId,
        secretHash,
        authEpoch,
        sanitizedName,
        now,
        expiresAt,
        now
    )

    return {
        deviceId,
        deviceSecret,
        cookieValue: `${deviceId}.${deviceSecret}`,
        expiresAt,
        authEpoch
    }
}

/**
 * 校验客户端提交的长期设备凭证
 * 核心安全机制：
 * 1. 严格格式与字符集校验 (dev_32位hex.64位hex)，快速阻断非法探测
 * 2. 检查 revoked_at 状态，已撤销设备立即拒绝
 * 3. 检查服务端过期时间 expires_at，杜绝泄露 Cookie 长期无限制重放
 * 4. 检查当前随机时代版本 auth_epoch，全设备撤销或版本轮换时瞬时失效
 * 5. 常量时间比较 (timingSafeEqual) 凭证 SHA-256 摘要，杜绝时序攻击
 * 6. 滑动窗口自动续期：正常活跃访问且超过间隔时防抖更新 last_used_at 与顺延 expires_at
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} credentialString Cookie 中传入的凭证字符串
 * @param {string} [_legacySecretParam] 旧参数 (保留向后兼容，但库中已解耦密码)
 * @returns {{ valid: boolean, deviceId?: string, deviceSecret?: string, expiresAt?: number, reason?: string }}
 */
export function validateClientCredential(db, credentialString, _legacySecretParam = null) {
    if (!credentialString || typeof credentialString !== 'string') {
        return { valid: false, reason: 'missing_credential' }
    }

    const parts = credentialString.trim().split('.')
    if (parts.length !== 2) {
        return { valid: false, reason: 'malformed_token' }
    }

    const [deviceId, deviceSecret] = parts
    // 字符集与长度白名单安全校验
    if (!deviceId.startsWith('dev_') || deviceId.length !== 36 || !/^dev_[0-9a-f]{32}$/i.test(deviceId)) {
        return { valid: false, reason: 'invalid_format' }
    }
    if (deviceSecret.length !== 64 || !/^[0-9a-f]{64}$/i.test(deviceSecret)) {
        return { valid: false, reason: 'invalid_format' }
    }

    initClientAuthSchema(db)

    let row = null
    try {
        row = db.prepare('SELECT * FROM authorized_web_clients WHERE device_id = ? AND revoked_at IS NULL').get(deviceId)
    } catch (_) {
        return { valid: false, reason: 'database_error' }
    }

    if (!row) {
        return { valid: false, reason: 'device_not_found_or_revoked' }
    }

    const now = Date.now()

    // 服务端有效期校验：过期则坚决拒绝，杜绝长期抓包重放
    if (row.expires_at && now > Number(row.expires_at)) {
        return { valid: false, reason: 'expired' }
    }

    // 随机时代版本 (auth_epoch) 校验：管理端重置或全设备撤销时瞬时阻断
    const currentEpoch = getOrCreateAuthEpoch(db)
    if (row.auth_epoch !== currentEpoch) {
        return { valid: false, reason: 'epoch_mismatch' }
    }

    // 常量时间校验客户端凭证摘要，杜绝时序攻击
    const givenHash = crypto.createHash('sha256').update(deviceSecret).digest('hex')
    const expectedBuf = Buffer.from(row.secret_hash, 'utf8')
    const givenBuf = Buffer.from(givenHash, 'utf8')

    if (expectedBuf.length !== givenBuf.length || !crypto.timingSafeEqual(expectedBuf, givenBuf)) {
        return { valid: false, reason: 'secret_mismatch' }
    }

    // 滑动窗口防抖更新与续期 (间隔大于 SLIDING_RENEW_INTERVAL_MS 才顺延，降低磁盘 IO)
    let renewed = false
    if (now - (row.last_used_at || 0) > SLIDING_RENEW_INTERVAL_MS) {
        try {
            const nextExpires = now + DEFAULT_DEVICE_TTL_MS
            db.prepare('UPDATE authorized_web_clients SET last_used_at = ?, expires_at = ? WHERE device_id = ?').run(now, nextExpires, deviceId)
            row.expires_at = nextExpires
            renewed = true
        } catch (_) {}
    }

    return {
        valid: true,
        deviceId,
        deviceSecret,
        createdAt: row.created_at,
        expiresAt: row.expires_at,
        authEpoch: currentEpoch,
        renewed
    }
}

/**
 * 撤销指定客户端设备的授权 (退出当前浏览器)
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} deviceId
 * @returns {boolean}
 */
export function revokeClient(db, deviceId) {
    if (!deviceId || typeof deviceId !== 'string') return false
    initClientAuthSchema(db)
    const result = db.prepare('UPDATE authorized_web_clients SET revoked_at = ? WHERE device_id = ? AND revoked_at IS NULL').run(Date.now(), deviceId)
    return Number(result.changes || 0) > 0
}

/**
 * 撤销所有已授权客户端设备 (管理端重置全部设备)
 * 1. 轮换全新独立随机 auth_epoch，使所有旧凭证在版本比对时即刻失效
 * 2. 批量将已授权记录更新 revoked_at
 * 数据库操作异常直接向外抛出 (fail closed)，严禁吞错虚假宣称成功
 * @param {import('node:sqlite').DatabaseSync} db
 * @returns {number} 撤销的设备数量
 */
export function revokeAllClients(db) {
    initClientAuthSchema(db)
    rotateAuthEpoch(db)
    const result = db.prepare('UPDATE authorized_web_clients SET revoked_at = ? WHERE revoked_at IS NULL').run(Date.now())
    return Number(result.changes || 0)
}

/**
 * 为已授权设备派生专属 CSRF 令牌
 * 基于设备专属私钥 deviceSecret (存于 HttpOnly Cookie) 与可选的 salt 派生 HMAC
 * 跨站恶意脚本无法读取 HttpOnly Cookie，因此绝对无法构造出合法 CSRF 令牌
 * @param {string} deviceSecret
 * @param {string} [saltOrEpoch='ms_device_csrf']
 * @returns {string}
 */
export function generateDeviceCsrfToken(deviceSecret, saltOrEpoch = 'ms_device_csrf') {
    if (!deviceSecret || typeof deviceSecret !== 'string') return ''
    const salt = String(saltOrEpoch || 'ms_device_csrf')
    return crypto
        .createHmac('sha256', deviceSecret)
        .update(salt)
        .digest('hex')
}

/**
 * 校验设备 CSRF 令牌有效性 (常量时间比较)
 * @param {string} deviceSecret
 * @param {string} saltOrToken
 * @param {string} [maybeToken]
 * @returns {boolean}
 */
export function verifyDeviceCsrfToken(deviceSecret, saltOrToken, maybeToken) {
    let salt = 'ms_device_csrf'
    let token = ''
    if (arguments.length >= 3) {
        salt = String(saltOrToken || 'ms_device_csrf')
        token = String(maybeToken || '')
    } else {
        token = String(saltOrToken || '')
    }

    if (!token || !deviceSecret) return false
    const expected = generateDeviceCsrfToken(deviceSecret, salt)
    const expectedBuf = Buffer.from(expected, 'utf8')
    const givenBuf = Buffer.from(token.trim(), 'utf8')
    if (expectedBuf.length !== givenBuf.length) return false
    return crypto.timingSafeEqual(expectedBuf, givenBuf)
}

/**
 * 组装持久化设备凭据 Cookie 响应头
 * 遵循 HttpOnly、SameSite=Strict、Max-Age，普通 LAN/HTTP 环境不设 Secure，HTTPS 环境自动添加 Secure
 * @param {string} cookieValue
 * @param {object} [options]
 * @param {boolean} [options.isHttps=false]
 * @param {number} [options.maxAge=7776000] 默认 90 天
 * @param {string} [options.path='/']
 * @returns {string}
 */
export function buildDeviceCookieHeader(cookieValue, { isHttps = false, maxAge = DEFAULT_DEVICE_COOKIE_MAX_AGE, path = '/' } = {}) {
    let header = `${DEVICE_COOKIE_NAME}=${cookieValue}; Path=${path}; HttpOnly; SameSite=Strict; Max-Age=${maxAge}`
    if (isHttps) {
        header += '; Secure'
    }
    return header
}

/**
 * 组装清理设备凭据 Cookie 响应头 (用于退出控制台/撤销授权)
 * @param {object} [options]
 * @param {boolean} [options.isHttps=false]
 * @param {string} [options.path='/']
 * @returns {string}
 */
export function buildClearDeviceCookieHeader({ isHttps = false, path = '/' } = {}) {
    let header = `${DEVICE_COOKIE_NAME}=; Path=${path}; HttpOnly; SameSite=Strict; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT`
    if (isHttps) {
        header += '; Secure'
    }
    return header
}
