import test from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'

// =========================================================================
// 测试隔离前移：在模块使用前无条件预设独立临时隔离环境，绝不触碰真实 sessions 或外部目录
// =========================================================================
const origPreEnvSessionDir = process.env.MS_SESSION_DIR
const origPreEnvSessionDbPath = process.env.MS_SESSION_DB_PATH
const origPreEnvPairingSecret = process.env.MS_WEB_PAIRING_SECRET
const origPreEnvEncryptionSecret = process.env.MS_ENCRYPTION_SECRET

const preImportTempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ms-rewards-profile-test-'))
process.env.MS_SESSION_DIR = preImportTempDir
process.env.MS_SESSION_DB_PATH = path.join(preImportTempDir, 'sessions.db')
process.env.MS_WEB_PAIRING_SECRET = 'fictional-profile-test-pairing-secret-2026!'
delete process.env.MS_ENCRYPTION_SECRET

const {
    initProfileSchema,
    listProfiles,
    getActiveProfile,
    setActiveProfile,
    saveProfile,
    deleteProfile,
    getDecryptedAiConfig,
    testAiConnection,
    fetchAiModels
} = await import('./profileManager.mjs')

const { AI_PROVIDERS, getCategorizedProviders } = await import('./aiProviders.mjs')
const { encryptSecret, decryptSecret, maskSecret } = await import('./profileCrypto.mjs')

test('profileCrypto: encryptSecret, decryptSecret, and maskSecret work properly', () => {
    const rawKey = 'sk-test-1234567890abcdefghijklmn'
    const encrypted = encryptSecret(rawKey)

    assert.ok(encrypted.startsWith('enc:v1:'), 'Encrypted string must start with enc:v1:')
    assert.equal(encrypted.split(':').length, 5, 'Encrypted format must have 5 parts')

    const decrypted = decryptSecret(encrypted)
    assert.equal(decrypted, rawKey, 'Decrypted key must match original')

    const masked = maskSecret(rawKey)
    assert.ok(masked.startsWith('sk-••••••••'), 'Masked key must start with sk-••••••••')
    assert.ok(!masked.includes('abcdef'), 'Masked key must not contain middle secrets')
    assert.equal(masked.slice(-4), rawKey.slice(-4), 'Masked key must reveal only last 4 chars')

    // Edge cases
    assert.equal(encryptSecret(''), '')
    assert.equal(decryptSecret(''), '')
    assert.equal(decryptSecret('legacy_plain_key'), 'legacy_plain_key')
    assert.equal(maskSecret(''), '')
    assert.equal(maskSecret('123'), '••••••')
})

test('profileCrypto: decryptSecret handles legacy dynamic hostname ciphertexts and auto-migrates', () => {
    const legacyPlain = 'sk-legacy-dynamic-hostname-secret'
    const baseEntropy = [
        process.env.USER || 'junzhuang',
        process.env.HOME || '/Users/junzhuang',
        process.platform,
        process.arch,
        'antigravity-ms-rewards-device-salt-2026-v1'
    ].join(':')
    const legacyKey = crypto.createHash('sha256').update(`Mac.lan:${baseEntropy}`).digest()
    const iv = crypto.randomBytes(12)
    const cipher = crypto.createCipheriv('aes-256-gcm', legacyKey, iv)
    let enc = cipher.update(legacyPlain, 'utf8', 'hex')
    enc += cipher.final('hex')
    const authTag = cipher.getAuthTag().toString('hex')
    const legacyCipher = `enc:v1:${iv.toString('hex')}:${authTag}:${enc}`

    const decrypted = decryptSecret(legacyCipher)
    assert.equal(decrypted, legacyPlain, 'Legacy ciphertext with Mac.lan must be successfully decrypted')
})

test('profileCrypto: supports multi-platform MS_ENCRYPTION_SECRET custom override', () => {
    const originalEnv = process.env.MS_ENCRYPTION_SECRET
    try {
        process.env.MS_ENCRYPTION_SECRET = 'cluster-shared-master-password-12345'
        const secretText = 'sk-multi-platform-shared-key'
        const enc = encryptSecret(secretText)
        assert.ok(enc.startsWith('enc:v1:'))
        const dec = decryptSecret(enc)
        assert.equal(dec, secretText, 'Decryption with custom MS_ENCRYPTION_SECRET must match')
    } finally {
        if (originalEnv !== undefined) {
            process.env.MS_ENCRYPTION_SECRET = originalEnv
        } else {
            delete process.env.MS_ENCRYPTION_SECRET
        }
    }
})

test('profileManager: initProfileSchema creates user_profiles and auto-seeds default profile', () => {
    const db = new DatabaseSync(':memory:')
    // 创建 sessions 表并注入历史账号
    db.exec(`
        CREATE TABLE sessions (
            email TEXT,
            platform TEXT,
            storage_state TEXT,
            fingerprint TEXT,
            updated_at INTEGER,
            PRIMARY KEY(email, platform)
        );
        INSERT INTO sessions (email, platform, storage_state, updated_at)
        VALUES ('legacy_user@outlook.com', 'desktop', '{"cookies":[{"name":"_U","value":"xyz"}]}', 1000);
    `)

    initProfileSchema(db)

    const profiles = listProfiles(db)
    assert.equal(profiles.length, 1)
    assert.equal(profiles[0].id, 'profile_default')
    assert.equal(profiles[0].email, 'legacy_user@outlook.com')
    assert.equal(profiles[0].name, 'legacy_user')
    assert.equal(profiles[0].isActive, true)
    assert.equal(profiles[0].desktopAuthed, true)
    assert.equal(profiles[0].mobileAuthed, false)
})

test('profileManager: saveProfile encrypts AI configuration and masks API key on retrieval', () => {
    const db = new DatabaseSync(':memory:')
    initProfileSchema(db)

    const saved = saveProfile(db, {
        name: '工作主号',
        email: 'worker@outlook.com',
        aiConfig: {
            enabled: true,
            provider: 'openai',
            baseUrl: 'https://api.openai.com/v1',
            model: 'gpt-4o-mini',
            temperature: 0.5,
            apiKey: 'sk-proj-9876543210abcdef9876543210'
        }
    })

    assert.ok(saved.id.startsWith('profile_'))

    const profiles = listProfiles(db)
    const workerProfile = profiles.find(p => p.email === 'worker@outlook.com')
    assert.ok(workerProfile)
    assert.equal(workerProfile.name, '工作主号')
    assert.equal(workerProfile.hasAiConfig, true)
    assert.ok(workerProfile.aiConfig.apiKeyMasked.startsWith('sk-••••••••'))
    assert.ok(!workerProfile.aiConfig.apiKeyMasked.includes('abcdef'))

    // 检查底层数据库中存的是密文
    const rawRow = db.prepare('SELECT ai_config_enc FROM user_profiles WHERE id = ?').get(workerProfile.id)
    assert.ok(rawRow.ai_config_enc.startsWith('enc:v1:'))
    assert.ok(!rawRow.ai_config_enc.includes('sk-proj-9876543210'))

    // 内部解密可获取明文
    const decrypted = getDecryptedAiConfig(db, workerProfile.id)
    assert.equal(decrypted.apiKey, 'sk-proj-9876543210abcdef9876543210')
    assert.equal(decrypted.model, 'gpt-4o-mini')

    // 更新时若传入脱敏掩码，原加密 key 必须得到无损保留
    saveProfile(db, {
        id: workerProfile.id,
        name: '工作主号(已改名)',
        aiConfig: {
            apiKey: workerProfile.aiConfig.apiKeyMasked, // 模拟前端把脱敏字符传回
            model: 'deepseek-chat'
        }
    })

    const preserved = getDecryptedAiConfig(db, workerProfile.id)
    assert.equal(preserved.apiKey, 'sk-proj-9876543210abcdef9876543210', 'API Key must be safely preserved!')
    assert.equal(preserved.model, 'deepseek-chat')
})

test('profileManager: setActiveProfile switches active status cleanly', () => {
    const db = new DatabaseSync(':memory:')
    initProfileSchema(db)

    const p1 = saveProfile(db, { name: '账号1', email: 'acc1@test.com' })
    const p2 = saveProfile(db, { name: '账号2', email: 'acc2@test.com' })

    setActiveProfile(db, p1.id)
    assert.equal(getActiveProfile(db).id, p1.id)

    setActiveProfile(db, p2.id)
    assert.equal(getActiveProfile(db).id, p2.id)

    const list = listProfiles(db)
    const p2InList = list.find(p => p.id === p2.id)
    const p1InList = list.find(p => p.id === p1.id)
    assert.equal(p2InList.isActive, true)
    assert.equal(p1InList.isActive, false)
})

test('profileManager: deleteProfile cascades session deletion and promotes next profile', () => {
    const db = new DatabaseSync(':memory:')
    db.exec(`
        CREATE TABLE sessions (
            email TEXT,
            platform TEXT,
            storage_state TEXT,
            fingerprint TEXT,
            updated_at INTEGER,
            PRIMARY KEY(email, platform)
        );
        CREATE TABLE account_metadata (
            email TEXT PRIMARY KEY,
            resolved_region TEXT,
            updated_at INTEGER
        );
    `)
    initProfileSchema(db)

    const p1 = saveProfile(db, { name: '待删账号', email: 'delete_me@test.com' })
    db.prepare("INSERT INTO sessions (email, platform, storage_state, updated_at) VALUES (?, 'desktop', '{}', 100)").run(p1.email)
    db.prepare("INSERT INTO account_metadata (email, resolved_region, updated_at) VALUES (?, 'US', 100) ON CONFLICT(email) DO UPDATE SET updated_at = 100").run(p1.email)

    setActiveProfile(db, p1.id)
    assert.equal(getActiveProfile(db).id, p1.id)

    const success = deleteProfile(db, p1.id)
    assert.equal(success, true)

    // 验证账号本身及其关联数据被清除
    assert.equal(db.prepare('SELECT count(*) as count FROM user_profiles WHERE id = ?').get(p1.id).count, 0)
    assert.equal(db.prepare('SELECT count(*) as count FROM sessions WHERE email = ?').get(p1.email).count, 0)
    assert.equal(db.prepare('SELECT count(*) as count FROM account_metadata WHERE email = ?').get(p1.email).count, 0)

    // 活跃 profile 自动提升
    const active = getActiveProfile(db)
    assert.ok(active)
    assert.notEqual(active.id, p1.id)
})

test('profileManager: testAiConnection handles missing credentials and invalid endpoints', async () => {
    const missing = await testAiConnection({ baseUrl: '', apiKey: '' })
    assert.equal(missing.success, false)
    assert.match(missing.error, /缺少 API Base URL/)

    const invalid = await testAiConnection({
        baseUrl: 'http://127.0.0.1:54321/v1',
        apiKey: 'sk-dummy'
    })
    assert.equal(invalid.success, false)
    assert.match(invalid.error, /ECONNREFUSED|网络连接异常/)
})

test('profileManager: saves region and synchronizes with account_metadata', () => {
    const db = new DatabaseSync(':memory:')
    db.exec(`
        CREATE TABLE sessions (
            email TEXT,
            platform TEXT,
            storage_state TEXT,
            fingerprint TEXT,
            updated_at INTEGER,
            PRIMARY KEY(email, platform)
        );
        CREATE TABLE account_metadata (
            email TEXT PRIMARY KEY,
            resolved_region TEXT,
            updated_at INTEGER
        );
    `)
    initProfileSchema(db)

    const saved = saveProfile(db, {
        name: '英国账号',
        email: 'uk_user@outlook.com',
        region: 'GB'
    })
    assert.equal(saved.region, 'GB')

    const listed = listProfiles(db).find(p => p.id === saved.id)
    assert.equal(listed.region, 'GB')

    const meta = db.prepare('SELECT resolved_region FROM account_metadata WHERE email = ?').get('uk_user@outlook.com')
    assert.equal(meta.resolved_region, 'GB')
})

test('profileManager: AI credentials strictly isolated per profile without global fallback', () => {
    const db = new DatabaseSync(':memory:')
    initProfileSchema(db)

    const p1 = saveProfile(db, {
        name: 'User 1',
        email: 'user1@outlook.com',
        aiConfig: {
            enabled: true,
            provider: 'deepseek',
            baseUrl: 'https://api.deepseek.com/v1',
            model: 'deepseek-chat',
            apiKey: 'sk-user1-secret-key-12345'
        }
    })

    const p2 = saveProfile(db, {
        name: 'User 2',
        email: 'user2@outlook.com'
    })

    const p1Decrypted = getDecryptedAiConfig(db, p1.id)
    assert.ok(p1Decrypted)
    assert.equal(p1Decrypted.apiKey, 'sk-user1-secret-key-12345')
    assert.equal(p1Decrypted.model, 'deepseek-chat')

    const p2Decrypted = getDecryptedAiConfig(db, p2.id)
    assert.equal(p2Decrypted, null, 'User 2 严禁回退获取 User 1 的配置或全局配置')
})

test('aiProviders: catalog includes standard global providers (OpenRouter, Gemini, OpenAI, Groq) and categories', () => {
    assert.ok(AI_PROVIDERS.openrouter, 'OpenRouter must be present')
    assert.equal(AI_PROVIDERS.openrouter.baseUrl, 'https://openrouter.ai/api/v1')
    assert.ok(AI_PROVIDERS.openrouter.recommendedModels.length > 3)

    assert.ok(AI_PROVIDERS.gemini, 'Google Gemini must be present')
    assert.equal(AI_PROVIDERS.gemini.baseUrl, 'https://generativelanguage.googleapis.com/v1beta/openai')

    assert.ok(AI_PROVIDERS.openai, 'OpenAI official must be present')
    assert.ok(AI_PROVIDERS.groq, 'Groq must be present')
    assert.ok(AI_PROVIDERS.deepseek, 'DeepSeek must be present')

    const categorized = getCategorizedProviders()
    assert.ok(categorized.global.some(p => p.id === 'openrouter'))
    assert.ok(categorized.global.some(p => p.id === 'gemini'))
    assert.ok(categorized.china.some(p => p.id === 'deepseek'))
    assert.ok(categorized.gateway.some(p => p.id === 'ollama'))
})

test('profileManager: fetchAiModels handles missing credentials and invalid endpoints', async () => {
    const missing = await fetchAiModels({ baseUrl: '', apiKey: '' })
    assert.equal(missing.success, false)
    assert.match(missing.error, /请先提供有效的 Base URL 和 API Key/)

    const invalid = await fetchAiModels({
        baseUrl: 'http://127.0.0.1:54321/v1',
        apiKey: 'sk-dummy'
    })
    assert.equal(invalid.success, false)
    assert.match(invalid.error, /ECONNREFUSED|网络异常/)
})

test.after(() => {
    if (origPreEnvEncryptionSecret !== undefined) process.env.MS_ENCRYPTION_SECRET = origPreEnvEncryptionSecret
    else delete process.env.MS_ENCRYPTION_SECRET

    if (origPreEnvSessionDir !== undefined) process.env.MS_SESSION_DIR = origPreEnvSessionDir
    else delete process.env.MS_SESSION_DIR

    if (origPreEnvSessionDbPath !== undefined) process.env.MS_SESSION_DB_PATH = origPreEnvSessionDbPath
    else delete process.env.MS_SESSION_DB_PATH

    if (origPreEnvPairingSecret !== undefined) process.env.MS_WEB_PAIRING_SECRET = origPreEnvPairingSecret
    else delete process.env.MS_WEB_PAIRING_SECRET

    try { fs.rmSync(preImportTempDir, { recursive: true, force: true }) } catch (_) {}
})

