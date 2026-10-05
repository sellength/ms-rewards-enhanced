import crypto from 'node:crypto'
import os from 'node:os'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ALGORITHM = 'aes-256-gcm'
const IV_LENGTH = 12
const TAG_LENGTH = 16

const __cryptoFilename = fileURLToPath(import.meta.url)
const __cryptoDirname = path.dirname(__cryptoFilename)
const DEFAULT_PROJECT_ROOT = path.resolve(__cryptoDirname, '../../')

/**
 * 统一定位 sessions 数据目录绝对路径（支持环境变量覆盖与跨平台绝对路径）
 */
export function resolveSessionDir() {
    if (process.env.MS_SESSION_DIR && process.env.MS_SESSION_DIR.trim()) {
        return path.resolve(process.env.MS_SESSION_DIR.trim())
    }
    if (process.env.MS_SESSION_DB_PATH && process.env.MS_SESSION_DB_PATH.trim()) {
        return path.resolve(path.dirname(process.env.MS_SESSION_DB_PATH.trim()))
    }
    return path.join(DEFAULT_PROJECT_ROOT, 'sessions')
}

export function resolveDeviceKeyPath() {
    return path.join(resolveSessionDir(), '.device_key')
}

/**
 * 安全获取系统用户名（多平台兼容，防 OpenWrt / Alpine 等系统 os.userInfo() ENOENT 崩溃）
 */
function getSafeUsername() {
    try {
        const u = os.userInfo()?.username
        if (u) return u
    } catch (_) {}
    return process.env.USER || process.env.USERNAME || 'default_user'
}

/**
 * 安全获取系统主目录（多平台兼容）
 */
function getSafeHomedir() {
    try {
        const h = os.homedir()
        if (h) return h
    } catch (_) {}
    return process.env.HOME || process.env.USERPROFILE || '.'
}

/**
 * 派生本机安全环境特征密钥 (保底机制)
 */
function getSafeMachineEntropyKey(salt = 'antigravity-ms-rewards-device-salt-2026-v2', hostname = '') {
    const parts = [
        getSafeUsername(),
        getSafeHomedir(),
        process.platform || 'darwin',
        process.arch || 'arm64',
        salt
    ]
    if (hostname) parts.unshift(hostname)
    return crypto.createHash('sha256').update(parts.join(':')).digest()
}

/**
 * 安全生成或读取数据目录主密钥 sessions/.device_key
 * 跨 Docker 容器挂载卷、Windows、macOS、Linux、OpenWrt 稳定通用
 * 严格防静默降级：读取/写入失败时显式抛出异常，绝不静默降级为弱熵可预测的机器特征密钥
 * 严格防凭据混淆：环境变量密钥 MS_ENCRYPTION_SECRET 绝不写入数据卷磁盘，保证密钥与存储卷的物理隔离
 */
function readExistingDeviceKey(keyPath) {
    try {
        const raw = fs.readFileSync(keyPath, 'utf8').trim()
        if (raw.length === 64 && /^[0-9a-fA-F]+$/.test(raw)) {
            return Buffer.from(raw, 'hex')
        }
        throw new Error(`设备密钥文件内容已损坏或格式非法 (期望 64 位 Hex): ${keyPath}`)
    } catch (readErr) {
        // 读取失败绝不悄然降级！必须抛出明确错误！
        throw new Error(`读取设备密钥失败 (${keyPath}): ${readErr.message}`)
    }
}

/**
 * 安全生成或读取数据目录主密钥 sessions/.device_key
 * 跨 Docker 容器挂载卷、Windows、macOS、Linux、OpenWrt 稳定通用
 * 严格防静默降级：读取/写入失败时显式抛出异常，绝不静默降级为弱熵可预测的机器特征密钥
 * 严格防凭据混淆：环境变量密钥 MS_ENCRYPTION_SECRET 绝不写入数据卷磁盘，保证密钥与存储卷的物理隔离
 * 严格防并发覆盖：首次创建使用 flag: 'wx' (O_CREAT | O_EXCL) 原子独占创建，捕获 EEXIST 安全复用已存在密钥
 */
function getOrCreateDeviceKey() {
    // 优先级 1: 环境变量显式配置 (适合 Docker Compose / 多机器统一指定，密钥仅留存内存)
    const envSecret = (process.env.MS_ENCRYPTION_SECRET || process.env.ENCRYPTION_SECRET || '').trim()
    if (envSecret) {
        return crypto.createHash('sha256').update(envSecret).digest()
    }

    // 优先级 2: 数据目录持久化主密钥 sessions/.device_key
    const keyPath = resolveDeviceKeyPath()
    if (fs.existsSync(keyPath)) {
        return readExistingDeviceKey(keyPath)
    }

    // 首次创建：独占原子创建 (flag: 'wx')，杜绝并发多进程启动时的竞争覆盖
    const newKey = crypto.randomBytes(32)
    const newKeyHex = newKey.toString('hex')
    const dir = path.dirname(keyPath)
    try {
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
        try { fs.chmodSync(dir, 0o700) } catch (_) {}
    } catch (_) {}

    try {
        fs.writeFileSync(keyPath, newKeyHex, { mode: 0o600, flag: 'wx' })
        try { fs.chmodSync(keyPath, 0o600) } catch (_) {}
        return newKey
    } catch (writeErr) {
        // 若遇到 EEXIST，说明另一进程并发抢先创建了密钥文件，立即安全复用已创建的密钥，绝不覆盖
        if (writeErr && (writeErr.code === 'EEXIST' || writeErr.message?.includes('file already exists'))) {
            return readExistingDeviceKey(keyPath)
        }
        // 若为权限不足或只读文件系统等不可恢复错误，绝不静默降级为弱机器特征！
        throw new Error(`无法独占创建设备密钥文件 (${keyPath}): ${writeErr.message}。请检查目录权限或配置 MS_ENCRYPTION_SECRET 环境变量。`)
    }
}

export function getDerivedDeviceKey() {
    return getOrCreateDeviceKey()
}

export function getDeviceKey() {
    return getOrCreateDeviceKey()
}

export { getOrCreateDeviceKey }

/**
 * 获取磁盘上现有的 .device_key 文件持久密钥（若存在）
 * @returns {Buffer|null}
 */
export function getPersistentDeviceKey() {
    try {
        const keyPath = resolveDeviceKeyPath()
        if (fs.existsSync(keyPath)) {
            const raw = fs.readFileSync(keyPath, 'utf8').trim()
            if (raw.length === 64 && /^[0-9a-fA-F]+$/.test(raw)) {
                return Buffer.from(raw, 'hex')
            }
        }
    } catch (_) {}
    return null
}

/**
 * 历史机器特征弱密钥候选（v2 与 v1）
 * 仅用于旧版本平滑升级，解密成功后必须触发单次迁移
 */
export function getLegacyMachineEntropyKeys() {
    const keys = []
    const seen = new Set()
    const addKey = (buf) => {
        if (!buf || !Buffer.isBuffer(buf) || buf.length !== 32) return
        const hex = buf.toString('hex')
        if (!seen.has(hex)) {
            seen.add(hex)
            keys.push(buf)
        }
    }

    // 1. v2 稳定机器特征（无 hostname）
    addKey(getSafeMachineEntropyKey('antigravity-ms-rewards-device-salt-2026-v2'))

    // 2. v1 历史动态 hostname 候选
    let curHost = ''
    try { curHost = os.hostname() || '' } catch (_) {}
    const hostnames = new Set([
        curHost,
        curHost ? curHost.replace(/\.(local|lan)$/i, '') : '',
        curHost ? `${curHost.replace(/\.(local|lan)$/i, '')}.local` : '',
        curHost ? `${curHost.replace(/\.(local|lan)$/i, '')}.lan` : '',
        'Mac.lan',
        'zjMacBook-Pro.local',
        'zjMacBook-Pro',
        'MacBook-Pro.local',
        'MacBook-Pro',
        'localhost',
        'localhost.localdomain',
        ''
    ])

    for (const h of hostnames) {
        addKey(getSafeMachineEntropyKey('antigravity-ms-rewards-device-salt-2026-v1', h))
    }

    return keys
}

/**
 * 兼容多来源候选解密密钥（仅内存查询，不写盘）
 * - 支持当前环境变量 MS_ENCRYPTION_SECRET
 * - 支持前置显式迁移密钥 MS_PREVIOUS_ENCRYPTION_SECRET / MS_LEGACY_ENCRYPTION_SECRETS
 * - 支持数据卷中现有的 .device_key 文件
 * - 支持多平台历史机器特征弱密钥（v2 与 v1）
 */
export function getLegacyCandidateKeys() {
    const keys = []
    const seen = new Set()

    const addKey = (buf) => {
        if (!buf || !Buffer.isBuffer(buf) || buf.length !== 32) return
        const hex = buf.toString('hex')
        if (!seen.has(hex)) {
            seen.add(hex)
            keys.push(buf)
        }
    }

    // 1. 尝试当前环境变量（若配置）
    const envSecret = (process.env.MS_ENCRYPTION_SECRET || process.env.ENCRYPTION_SECRET || '').trim()
    if (envSecret) {
        addKey(crypto.createHash('sha256').update(envSecret).digest())
    }

    // 2. 尝试显式配置的历史/前置密钥（例如从旧环境变量切换时提供平滑迁移）
    const prevSecrets = [
        process.env.MS_PREVIOUS_ENCRYPTION_SECRET,
        process.env.PREVIOUS_ENCRYPTION_SECRET,
        ...(process.env.MS_LEGACY_ENCRYPTION_SECRETS || '').split(',')
    ]
    for (const sec of prevSecrets) {
        if (sec && typeof sec === 'string' && sec.trim()) {
            addKey(crypto.createHash('sha256').update(sec.trim()).digest())
        }
    }

    // 3. 尝试当前数据卷上的 .device_key 文件（若存在且有效）
    const persistentKey = getPersistentDeviceKey()
    if (persistentKey) addKey(persistentKey)

    // 4. 尝试历史机器特征弱密钥
    for (const mk of getLegacyMachineEntropyKeys()) {
        addKey(mk)
    }

    return keys
}


/**
 * 本地 AES-256-GCM 高强度加密
 * @param {string} plainText 待加密明文字符串
 * @returns {string} 密文字符串 (格式: enc:v1:<iv_hex>:<tag_hex>:<ciphertext_hex>)
 */
export function encryptSecret(plainText) {
    if (!plainText || typeof plainText !== 'string') return ''
    const key = getDerivedDeviceKey()
    const iv = crypto.randomBytes(IV_LENGTH)
    const cipher = crypto.createCipheriv(ALGORITHM, key, iv)

    let encrypted = cipher.update(plainText, 'utf8', 'hex')
    encrypted += cipher.final('hex')
    const authTag = cipher.getAuthTag().toString('hex')

    return `enc:v1:${iv.toString('hex')}:${authTag}:${encrypted}`
}

/**
 * 检查当前是否处于环境变量主密钥覆盖模式中
 * @returns {boolean}
 */
export function isTemporaryEnvSecretActive() {
    return Boolean((process.env.MS_ENCRYPTION_SECRET || process.env.ENCRYPTION_SECRET || '').trim())
}

/**
 * 解密密文字符串并返回元数据（用于读操作判断是否需要迁移）
 * 严格只读与持久性原则：
 * - 由当前主密钥解密成功：只读，needsMigration: false。
 * - 由数据卷持久化 .device_key 解密成功（例如临时设置了 MS_ENCRYPTION_SECRET）：
 *   密文原本就是持久设备密钥加密，读取期间绝不能自动改写为临时 env 密文！
 *   保持纯只读（needsMigration: false），确保临时 env 移除后凭据无需任何历史 env 仍可解密！
 * - 由用户显式配置的前置轮换密钥 MS_PREVIOUS_ENCRYPTION_SECRET 解密成功：needsMigration: true。
 * - 由历史动态机器特征弱密钥或旧明文解密成功：
 *   仅当当前目标密钥为磁盘持久化的稳定 .device_key 时才允许单次升级迁移；
 *   若当前处于临时 env 覆盖中，读取严格保持纯只读 (needsMigration: false)！
 *   绝不将旧特征/旧明文用临时 env 覆盖重写，确保移除临时 env 后无需额外凭据仍可恢复！
 * - 解密失败：needsMigration: false，绝不覆盖原密文。
 * @param {string} cipherText 加密字符串
 * @returns {{ plaintext: string, needsMigration: boolean }}
 */
export function decryptSecretWithMeta(cipherText) {
    if (!cipherText || typeof cipherText !== 'string') {
        return { plaintext: '', needsMigration: false }
    }

    const hasEnvOverride = isTemporaryEnvSecretActive()

    if (!cipherText.startsWith('enc:v1:')) {
        // 兼容非加密历史字符串或明文：
        // 仅在当前为主密钥稳定持久模式时允许升级迁移；若在临时 env 下读取，保持只读零修改
        return { plaintext: cipherText, needsMigration: !hasEnvOverride }
    }

    try {
        const parts = cipherText.split(':')
        if (parts.length !== 5) return { plaintext: '', needsMigration: false }

        const ivHex = parts[2]
        const authTagHex = parts[3]
        const encryptedHex = parts[4]
        if (!ivHex || !authTagHex || !encryptedHex) return { plaintext: '', needsMigration: false }

        const iv = Buffer.from(ivHex, 'hex')
        const authTag = Buffer.from(authTagHex, 'hex')

        const tryDecrypt = (key) => {
            if (!key || !Buffer.isBuffer(key) || key.length !== 32) return null
            try {
                const decipher = crypto.createDecipheriv(ALGORITHM, key, iv)
                decipher.setAuthTag(authTag)
                let decrypted = decipher.update(encryptedHex, 'hex', 'utf8')
                decrypted += decipher.final('utf8')
                return decrypted
            } catch (_) {
                return null
            }
        }

        // 1. 优先使用当前生效的主密钥解密
        let primaryKey = null
        try {
            primaryKey = getDerivedDeviceKey()
        } catch (_) {}

        if (primaryKey) {
            const decrypted = tryDecrypt(primaryKey)
            if (decrypted !== null) {
                // 成功由主密钥解密：最新状态，纯只读，绝对不需要迁移！
                return { plaintext: decrypted, needsMigration: false }
            }
        }

        // 2. 检查持久化 .device_key 文件
        // 若当前处于临时 MS_ENCRYPTION_SECRET 覆盖中，原密文可能由磁盘 .device_key 加密。
        // 持久设备密钥解密成功属于长期合法凭据，读取操作绝不能自动改写为临时 env 密文！
        // 保持纯只读，确保临时 env 移除后凭据无需额外历史 env 仍可解密！
        const persistentKey = getPersistentDeviceKey()
        if (persistentKey && (!primaryKey || !persistentKey.equals(primaryKey))) {
            const decrypted = tryDecrypt(persistentKey)
            if (decrypted !== null) {
                return { plaintext: decrypted, needsMigration: false }
            }
        }

        // 3. 检查用户显式配置的历史/前置迁移密钥 (MS_PREVIOUS_ENCRYPTION_SECRET 等显式轮换)
        const prevSecrets = [
            process.env.MS_PREVIOUS_ENCRYPTION_SECRET,
            process.env.PREVIOUS_ENCRYPTION_SECRET,
            ...(process.env.MS_LEGACY_ENCRYPTION_SECRETS || '').split(',')
        ]
        for (const sec of prevSecrets) {
            if (sec && typeof sec === 'string' && sec.trim()) {
                const candidateKey = crypto.createHash('sha256').update(sec.trim()).digest()
                const decrypted = tryDecrypt(candidateKey)
                if (decrypted !== null) {
                    return { plaintext: decrypted, needsMigration: true }
                }
            }
        }

        // 4. 尝试历史动态机器特征弱密钥 (v2 / v1)
        // 关键防护：仅当当前为磁盘持久稳定密钥 (无临时 env 覆盖) 时才触发单次升级迁移；
        // 若处于临时 env 覆盖中，读取保持只读 (needsMigration: false)，确保临时 env 移除后依然能恢复！
        for (const machineKey of getLegacyMachineEntropyKeys()) {
            const decrypted = tryDecrypt(machineKey)
            if (decrypted !== null) {
                return { plaintext: decrypted, needsMigration: !hasEnvOverride }
            }
        }

        // 解密失败：严禁迁移，绝不覆盖原密文
        return { plaintext: '', needsMigration: false }
    } catch (_) {
        return { plaintext: '', needsMigration: false }
    }
}

/**
 * 本地 AES-256-GCM 解密
 * @param {string} cipherText 加密字符串
 * @returns {string} 解密后的明文字符串 (解密失败或格式不符返回空字符串)
 */
export function decryptSecret(cipherText) {
    return decryptSecretWithMeta(cipherText).plaintext
}

/**
 * 敏感字符串脱敏 (用于前端安全回显，例如 sk-1234567890abcdef -> sk-••••••••cdef)
 * @param {string} secret 
 * @returns {string}
 */
export function maskSecret(secret) {
    if (!secret || typeof secret !== 'string') return ''
    const trimmed = secret.trim()
    if (trimmed.length <= 6) return '••••••'
    if (trimmed.startsWith('sk-') && trimmed.length > 10) {
        return `sk-••••••••${trimmed.slice(-4)}`
    }
    const visibleStart = Math.min(3, Math.floor(trimmed.length / 4))
    const visibleEnd = Math.min(4, Math.floor(trimmed.length / 4))
    return `${trimmed.slice(0, visibleStart)}••••••••${trimmed.slice(-visibleEnd)}`
}
