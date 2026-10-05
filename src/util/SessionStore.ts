import { DatabaseSync } from 'node:sqlite'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

import type { BrowserContext } from 'patchright'
import type { BrowserFingerprintWithHeaders } from 'fingerprint-generator'

export type StorageState = Awaited<ReturnType<BrowserContext['storageState']>>

export interface LoadedSession {
    storageState: StorageState | null
    fingerprint: BrowserFingerprintWithHeaders | null
    updatedAt: number
}

interface SessionRow {
    storage_state: string | null
    fingerprint: string | null
    updated_at: number
}

let db: DatabaseSync | null = null

function platformOf(isMobile: boolean): 'mobile' | 'desktop' {
    return isMobile ? 'mobile' : 'desktop'
}

function getDb(sessionPath: string): DatabaseSync {
    if (db) return db

    const dir = path.resolve(process.cwd(), sessionPath)
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
    try {
        fs.chmodSync(dir, 0o700)
    } catch {}

    const dbPath = path.join(dir, 'sessions.db')
    db = new DatabaseSync(dbPath)
    try {
        fs.chmodSync(dbPath, 0o600)
    } catch {}

    db.exec('PRAGMA journal_mode = WAL')
    db.exec('PRAGMA busy_timeout = 5000')
    db.exec('PRAGMA synchronous = NORMAL')
    db.exec(`
        CREATE TABLE IF NOT EXISTS sessions (
            email         TEXT NOT NULL,
            platform      TEXT NOT NULL,
            storage_state TEXT,
            fingerprint   TEXT,
            updated_at    INTEGER NOT NULL,
            PRIMARY KEY (email, platform)
        )
    `)
    db.exec(`
        CREATE TABLE IF NOT EXISTS account_metadata (
            email           TEXT PRIMARY KEY COLLATE NOCASE,
            resolved_region TEXT,
            mobile_device_id TEXT,
            mobile_sapphire_id TEXT,
            updated_at      INTEGER NOT NULL
        )
    `)
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
        )
    `)
    const profileColumns = db.prepare('PRAGMA table_info(user_profiles)').all() as Array<{ name: string }>
    if (!profileColumns.some(column => column.name === 'region')) {
        try {
            db.exec("ALTER TABLE user_profiles ADD COLUMN region TEXT DEFAULT 'US'")
        } catch (error) {
            if (!/duplicate column name/i.test(error instanceof Error ? error.message : String(error))) throw error
        }
    }
    const metadataColumns = db.prepare('PRAGMA table_info(account_metadata)').all() as Array<{ name: string }>
    if (!metadataColumns.some(column => column.name === 'mobile_device_id')) {
        try {
            db.exec('ALTER TABLE account_metadata ADD COLUMN mobile_device_id TEXT')
        } catch (error) {
            if (!/duplicate column name/i.test(error instanceof Error ? error.message : String(error))) throw error
        }
    }
    if (!metadataColumns.some(column => column.name === 'mobile_sapphire_id')) {
        try {
            db.exec('ALTER TABLE account_metadata ADD COLUMN mobile_sapphire_id TEXT')
        } catch (error) {
            if (!/duplicate column name/i.test(error instanceof Error ? error.message : String(error))) throw error
        }
    }

    // 自动无损初始化迁移：如果已有会话存在但 profiles 为空，自动迁移已有主账号
    const profileCount = (db.prepare('SELECT COUNT(*) as count FROM user_profiles').get() as { count: number })?.count || 0
    if (profileCount === 0) {
        const existingSession = db.prepare("SELECT email FROM sessions WHERE email IS NOT NULL AND email != '' LIMIT 1").get() as { email: string } | undefined
        if (existingSession?.email) {
            const now = Date.now()
            let defaultRegion = 'US'
            try {
                const meta = db.prepare('SELECT resolved_region FROM account_metadata WHERE email = ?').get(existingSession.email) as { resolved_region: string } | undefined
                if (meta?.resolved_region) defaultRegion = meta.resolved_region
            } catch (_) {}
            db.prepare(`
                INSERT OR IGNORE INTO user_profiles (id, name, email, region, ai_config_enc, proxy_config, preferences, is_active, created_at, updated_at)
                VALUES (?, ?, ?, ?, NULL, NULL, NULL, 1, ?, ?)
            `).run('profile_default', existingSession.email.split('@')[0] || '默认主账号', existingSession.email, defaultRegion, now, now)
        }
    }

    return db
}

export function loadSession(
    sessionPath: string,
    email: string,
    isMobile: boolean,
    maxAgeMs?: number
): LoadedSession | null {
    const row = getDb(sessionPath)
        .prepare('SELECT storage_state, fingerprint, updated_at FROM sessions WHERE email = ? AND platform = ?')
        .get(email, platformOf(isMobile)) as SessionRow | undefined

    if (!row) return null

    if (maxAgeMs && Date.now() - row.updated_at > maxAgeMs) {
        return null
    }

    return {
        storageState: row.storage_state ? (JSON.parse(row.storage_state) as StorageState) : null,
        fingerprint: row.fingerprint ? (JSON.parse(row.fingerprint) as BrowserFingerprintWithHeaders) : null,
        updatedAt: row.updated_at
    }
}

/**
 * 保存浏览器会话状态 (包含敏感认证 Cookie 与 localStorage)
 * 安全边界说明：
 * - storageState 包含微软官方认证 Cookie 等高权限凭据。
 * - 该凭据在 SQLite 中以 JSON 字符串形式持久化，依靠目录权限 (0700) 与数据库文件权限 (0600)
 *   进行本地系统用户级访问控制隔离保护。
 * - 此凭据存储不同于 AI API Key (后者经过 AES-256-GCM 设备密钥对称加密)。
 * - 严禁在日志、异常堆栈或诊断导出中回显 storageState 内容。
 */
export function saveStorageState(
    sessionPath: string,
    email: string,
    isMobile: boolean,
    storageState: StorageState
): void {
    getDb(sessionPath)
        .prepare(
            `INSERT INTO sessions (email, platform, storage_state, updated_at)
             VALUES (?, ?, ?, ?)
             ON CONFLICT(email, platform)
             DO UPDATE SET storage_state = excluded.storage_state, updated_at = excluded.updated_at`
        )
        .run(email, platformOf(isMobile), JSON.stringify(storageState), Date.now())
}

export function clearStorageState(sessionPath: string, email: string, isMobile: boolean): void {
    getDb(sessionPath)
        .prepare(
            `UPDATE sessions
             SET storage_state = NULL, updated_at = ?
             WHERE email = ? AND platform = ?`
        )
        .run(Date.now(), email, platformOf(isMobile))
}

export function saveFingerprint(
    sessionPath: string,
    email: string,
    isMobile: boolean,
    fingerprint: BrowserFingerprintWithHeaders
): void {
    getDb(sessionPath)
        .prepare(
            `INSERT INTO sessions (email, platform, fingerprint, updated_at)
             VALUES (?, ?, ?, ?)
             ON CONFLICT(email, platform)
             DO UPDATE SET fingerprint = excluded.fingerprint, updated_at = excluded.updated_at`
        )
        .run(email, platformOf(isMobile), JSON.stringify(fingerprint), Date.now())
}

export function loadResolvedRegion(sessionPath: string, email: string): string | undefined {
    const row = getDb(sessionPath)
        .prepare('SELECT resolved_region FROM account_metadata WHERE email = ?')
        .get(email) as { resolved_region?: string | null } | undefined

    return row?.resolved_region ?? undefined
}

export function saveResolvedRegion(sessionPath: string, email: string, region: string): void {
    if (!/^[A-Z]{2}$/.test(region)) {
        throw new Error(`Invalid resolved account region: ${region}`)
    }

    getDb(sessionPath)
        .prepare(
            `INSERT INTO account_metadata (email, resolved_region, updated_at)
             VALUES (?, ?, ?)
             ON CONFLICT(email)
             DO UPDATE SET resolved_region = excluded.resolved_region, updated_at = excluded.updated_at`
        )
        .run(email, region, Date.now())
}

function getOrCreateAccountUuid(
    sessionPath: string,
    email: string,
    column: 'mobile_device_id' | 'mobile_sapphire_id'
): string {
    const database = getDb(sessionPath)
    const existing = database
        .prepare(`SELECT ${column} AS value FROM account_metadata WHERE email = ?`)
        .get(email) as { value?: string | null } | undefined
    const current = existing?.value ?? ''
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(current)) {
        return current
    }

    const generated = randomUUID()
    database.prepare(
        `INSERT INTO account_metadata (email, ${column}, updated_at)
         VALUES (?, ?, ?)
         ON CONFLICT(email)
         DO UPDATE SET ${column} = excluded.${column}, updated_at = excluded.updated_at`
    ).run(email, generated, Date.now())
    return generated
}

export function getOrCreateMobileDeviceId(sessionPath: string, email: string): string {
    return getOrCreateAccountUuid(sessionPath, email, 'mobile_device_id')
}

export function getOrCreateMobileSapphireId(sessionPath: string, email: string): string {
    return getOrCreateAccountUuid(sessionPath, email, 'mobile_sapphire_id')
}

export interface UserProfile {
    id: string
    name: string
    email: string | null
    region: string | null
    ai_config_enc: string | null
    proxy_config: string | null
    preferences: string | null
    is_active: number
    created_at: number
    updated_at: number
}

export function listProfiles(sessionPath: string): UserProfile[] {
    const database = getDb(sessionPath)
    return (database.prepare('SELECT * FROM user_profiles ORDER BY is_active DESC, updated_at DESC').all() || []) as unknown as UserProfile[]
}

export function getActiveProfile(sessionPath: string): UserProfile | null {
    const database = getDb(sessionPath)
    const active = database.prepare('SELECT * FROM user_profiles WHERE is_active = 1 LIMIT 1').get() as unknown as UserProfile | undefined
    if (active) return active
    const first = database.prepare('SELECT * FROM user_profiles ORDER BY updated_at DESC LIMIT 1').get() as unknown as UserProfile | undefined
    return first || null
}

export function setActiveProfile(sessionPath: string, profileId: string): boolean {
    const database = getDb(sessionPath)
    database.exec('BEGIN TRANSACTION')
    try {
        database.prepare('UPDATE user_profiles SET is_active = 0').run()
        database.prepare('UPDATE user_profiles SET is_active = 1, updated_at = ? WHERE id = ?').run(Date.now(), profileId)
        database.exec('COMMIT')
        return true
    } catch (e) {
        database.exec('ROLLBACK')
        return false
    }
}

export function saveProfile(
    sessionPath: string,
    profile: { id?: string; name: string; email?: string; region?: string | null; ai_config_enc?: string | null; proxy_config?: string | null; preferences?: string | null }
): UserProfile {
    const database = getDb(sessionPath)
    const now = Date.now()
    const id = profile.id || `profile_${randomUUID().slice(0, 8)}`
    const region = (profile.region || 'US').trim().toUpperCase()
    database.prepare(`
        INSERT INTO user_profiles (id, name, email, region, ai_config_enc, proxy_config, preferences, is_active, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
            name = excluded.name,
            email = excluded.email,
            region = excluded.region,
            ai_config_enc = coalesce(excluded.ai_config_enc, user_profiles.ai_config_enc),
            proxy_config = excluded.proxy_config,
            preferences = excluded.preferences,
            updated_at = excluded.updated_at
    `).run(
        id,
        profile.name,
        profile.email || null,
        region,
        profile.ai_config_enc ?? null,
        profile.proxy_config ?? null,
        profile.preferences ?? null,
        now,
        now
    )

    if (profile.email && region) {
        try {
            database.prepare(`
                INSERT INTO account_metadata (email, resolved_region, updated_at)
                VALUES (?, ?, ?)
                ON CONFLICT(email)
                DO UPDATE SET resolved_region = excluded.resolved_region, updated_at = excluded.updated_at
            `).run(profile.email, region, now)
        } catch (_) {}
    }

    return database.prepare('SELECT * FROM user_profiles WHERE id = ?').get(id) as unknown as UserProfile
}

export function deleteProfile(sessionPath: string, profileId: string): boolean {
    const database = getDb(sessionPath)
    const target = database.prepare('SELECT * FROM user_profiles WHERE id = ?').get(profileId) as unknown as UserProfile | undefined
    if (!target) return false

    database.exec('BEGIN TRANSACTION')
    try {
        if (target.email) {
            database.prepare('DELETE FROM sessions WHERE email = ?').run(target.email)
            database.prepare('DELETE FROM account_metadata WHERE email = ?').run(target.email)
        }
        database.prepare('DELETE FROM user_profiles WHERE id = ?').run(profileId)
        // 若删除的是活跃 profile，自动提升最近的一个
        if (target.is_active === 1) {
            const next = database.prepare('SELECT id FROM user_profiles ORDER BY updated_at DESC LIMIT 1').get() as { id: string } | undefined
            if (next?.id) {
                database.prepare('UPDATE user_profiles SET is_active = 1 WHERE id = ?').run(next.id)
            }
        }
        database.exec('COMMIT')
        return true
    } catch (e) {
        database.exec('ROLLBACK')
        return false
    }
}

export function closeSessionStore(): void {
    if (!db) return
    try {
        db.exec('PRAGMA wal_checkpoint(TRUNCATE)')
        db.close()
    } catch {}
    db = null
}

