import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import dns from 'node:dns'
import http from 'node:http'
import { DatabaseSync } from 'node:sqlite'

// =========================================================================
// 测试隔离前移：在模块使用前无条件预设独立临时隔离环境，绝不触碰真实 sessions 或外部目录
// =========================================================================
const origPreEnvSessionDir = process.env.MS_SESSION_DIR
const origPreEnvSessionDbPath = process.env.MS_SESSION_DB_PATH
const origPreEnvPairingSecret = process.env.MS_WEB_PAIRING_SECRET
const origPreEnvEncryptionSecret = process.env.MS_ENCRYPTION_SECRET

const preImportTempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ms-rewards-account-audit-preimport-'))
process.env.MS_SESSION_DIR = preImportTempDir
process.env.MS_SESSION_DB_PATH = path.join(preImportTempDir, 'sessions.db')
process.env.MS_WEB_PAIRING_SECRET = 'fictional-preimport-secret-account-audit-12345'
delete process.env.MS_ENCRYPTION_SECRET

const {
    encryptSecret,
    decryptSecret,
    decryptSecretWithMeta,
    maskSecret,
    resolveSessionDir,
    resolveDeviceKeyPath,
    getDeviceKey,
    getPersistentDeviceKey,
    getLegacyCandidateKeys,
    getLegacyMachineEntropyKeys
} = await import('./profileCrypto.mjs')

const {
    initProfileSchema,
    saveProfile,
    getDecryptedAiConfig,
    deleteProfile,
    testAiConnection
} = await import('./profileManager.mjs')

const {
    validateAndNormalizeAiUrl,
    verifyAiUrlTargetBinding,
    isPrivateOrBlockedHost,
    verifyDnsResolutionSecurity,
    resolveAndPinSafeHost,
    secureFetchWithPinnedDns
} = await import('./aiUrlSecurity.mjs')

// =========================================================================
// =========================================================================
// 问题 1 验证：运行页账号数量真值与状态展示逻辑 (提取并执行 public/index.html 真实函数)
// =========================================================================

test('问题 1 验证: index.html 真实 loadProfilesList 执行验证 (隔离 DOM 环境: 401/网络故障/0账号/获取失败)', async () => {
    const htmlPath = path.resolve('public/index.html')
    const htmlContent = fs.readFileSync(htmlPath, 'utf8')

    // 1. 验证静态 HTML 初值绝不再写死为 "1 个账号"
    assert.ok(
        htmlContent.includes('<span class="profile-count-pill" id="profileCountBadge">加载中...</span>'),
        'profileCountBadge 初始状态必须为 加载中...'
    )
    assert.ok(
        htmlContent.includes('<span class="profile-count-pill" id="accountPageProfileCountBadge">加载中...</span>'),
        'accountPageProfileCountBadge 初始状态必须为 加载中...'
    )
    assert.ok(
        !htmlContent.includes('<span class="profile-count-pill" id="profileCountBadge">1 个账号</span>'),
        '严禁在 HTML 模板中硬编码 1 个账号假状态'
    )

    // 2. 从 public/index.html 提取真实的 loadProfilesList 及其辅助函数源码
    const updateBadgesCode = htmlContent.slice(
        htmlContent.indexOf('function updateProfileCountBadges(text) {'),
        htmlContent.indexOf('async function loadProfilesList() {')
    )
    const loadProfilesCode = htmlContent.slice(
        htmlContent.indexOf('async function loadProfilesList() {'),
        htmlContent.indexOf('function editProfileDirectly(profileId) {')
    )
    assert.ok(updateBadgesCode.length > 0, '必须成功提取真实 updateProfileCountBadges 源码')
    assert.ok(loadProfilesCode.length > 0, '必须成功提取真实 loadProfilesList 源码')

    // 3. 构建隔离微型 DOM 执行沙盒
    function createPageDomHarness(mockFetch) {
        const domMap = new Map()
        const getEl = (id) => {
            if (!domMap.has(id)) {
                domMap.set(id, { id, textContent: '', innerHTML: '' })
            }
            return domMap.get(id)
        }

        const document = {
            getElementById: id => getEl(id),
            querySelectorAll: () => []
        }

        const escapeHtml = str => String(str || '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
        let allProfilesList = []
        let activeProfileId = null
        const renderProfileDropdownList = () => {}
        const renderAccountPageProfiles = () => {}
        const loadAiConfiguration = () => {}

        // 在包含真实提取源码的沙箱闭包中执行
        const runner = new Function(
            'document',
            'fetch',
            'escapeHtml',
            'allProfilesList',
            'activeProfileId',
            'renderProfileDropdownList',
            'renderAccountPageProfiles',
            'loadAiConfiguration',
            `
            ${updateBadgesCode}
            ${loadProfilesCode}
            return loadProfilesList();
            `
        )

        return {
            run: () => runner(
                document,
                mockFetch,
                escapeHtml,
                allProfilesList,
                activeProfileId,
                renderProfileDropdownList,
                renderAccountPageProfiles,
                loadAiConfiguration
            ),
            getEl
        }
    }

    // 状态 A: 真实执行 401 响应处理
    const harness401 = createPageDomHarness(async () => ({
        status: 401,
        ok: false
    }))
    await harness401.run()
    assert.equal(harness401.getEl('profileCountBadge').textContent, '待配对')
    assert.equal(harness401.getEl('accountPageProfileCountBadge').textContent, '待配对')
    assert.ok(harness401.getEl('accountPageProfileGrid').innerHTML.includes('未授权访问 (HTTP 401)'))
    assert.ok(harness401.getEl('accountPageProfileGrid').innerHTML.includes('当前尚未完成控制台配对授权'))
    assert.ok(harness401.getEl('profileListContainer').innerHTML.includes('待配对授权'))

    // 状态 B: 真实执行网络异常 (fetch 抛错)
    const harnessNetErr = createPageDomHarness(async () => {
        throw new TypeError('fetch failed: Connection refused')
    })
    await harnessNetErr.run()
    assert.equal(harnessNetErr.getEl('profileCountBadge').textContent, '网络异常')
    assert.equal(harnessNetErr.getEl('accountPageProfileCountBadge').textContent, '网络异常')
    assert.ok(harnessNetErr.getEl('accountPageProfileGrid').innerHTML.includes('无法连接到控制服务'))
    assert.ok(harnessNetErr.getEl('accountPageProfileGrid').innerHTML.includes('重新连接'))
    assert.ok(harnessNetErr.getEl('profileListContainer').innerHTML.includes('无法连接到服务'))

    // 状态 C: 真实执行服务端 500 异常
    const harness500 = createPageDomHarness(async () => ({
        status: 500,
        ok: false
    }))
    await harness500.run()
    assert.equal(harness500.getEl('profileCountBadge').textContent, '获取失败')
    assert.equal(harness500.getEl('accountPageProfileCountBadge').textContent, '获取失败')
    assert.ok(harness500.getEl('accountPageProfileGrid').innerHTML.includes('HTTP 500'))

    // 状态 D: 真实执行成功响应但账号数为 0 (严禁显示 1 个账号假初值)
    const harnessZero = createPageDomHarness(async () => ({
        status: 200,
        ok: true,
        json: async () => ({ success: true, profiles: [] })
    }))
    await harnessZero.run()
    assert.equal(harnessZero.getEl('profileCountBadge').textContent, '0 个账号')
    assert.equal(harnessZero.getEl('accountPageProfileCountBadge').textContent, '0 个账号')
    assert.equal(harnessZero.getEl('topProfileName').textContent, '暂无账号')

    // 状态 E: 真实执行成功响应且拥有 2 个账号
    const harnessTwo = createPageDomHarness(async () => ({
        status: 200,
        ok: true,
        json: async () => ({
            success: true,
            profiles: [
                { id: 'p1', name: '账号1', email: 'a1@test.com', isActive: true },
                { id: 'p2', name: '账号2', email: 'a2@test.com', isActive: false }
            ]
        })
    }))
    await harnessTwo.run()
    assert.equal(harnessTwo.getEl('profileCountBadge').textContent, '2 个账号')
    assert.equal(harnessTwo.getEl('accountPageProfileCountBadge').textContent, '2 个账号')
    assert.equal(harnessTwo.getEl('topProfileName').textContent, '账号1')
})

// =========================================================================
// 问题 2 验证：敏感凭据文案修正与会话存储边界
// =========================================================================

test('问题 2 验证: index.html 彻底移除“零敏感数据留存”等虚假文案并明确 Cookie 存储边界', () => {
    const htmlPath = path.resolve('public/index.html')
    const htmlContent = fs.readFileSync(htmlPath, 'utf8')

    // 确认已彻底消除虚假断言
    assert.ok(
        !htmlContent.includes('零敏感数据留存'),
        '已彻底移除“零敏感数据留存”不实陈述'
    )
    assert.ok(
        !htmlContent.includes('零敏感信息留存与自动捕获'),
        '已彻底移除 FAQ 中的“零敏感信息留存”陈述'
    )

    // 确认已替换为准确客观的存储描述
    assert.ok(
        htmlContent.includes('本地会话隔离存储'),
        '登录面板应明确说明为“本地会话隔离存储”'
    )
    assert.ok(
        htmlContent.includes('免明文密码与本地会话存储'),
        'FAQ 中应诚实阐明“免明文密码与本地会话存储”'
    )
    assert.ok(
        htmlContent.includes('会话 Cookie 属于高权限登录凭据，请妥善保护本机数据目录'),
        'FAQ 必须向用户警示会话 Cookie 的敏感凭据性质'
    )
})

// =========================================================================
// 问题 3 验证：getDecryptedAiConfig 连续读取幂等性 (只读、零UPDATE) 与单次迁移
// =========================================================================

test('问题 3 验证: getDecryptedAiConfig 对当前密钥连续读取绝不执行 UPDATE，旧密文仅迁移一次', () => {
    const db = new DatabaseSync(':memory:')
    initProfileSchema(db)

    const testSecret = 'sk-read-idempotency-test-key-9999'
    const profile = saveProfile(db, {
        name: '读取测试用户',
        email: 'read_test@example.com',
        aiConfig: {
            enabled: true,
            provider: 'openai',
            baseUrl: 'https://api.openai.com/v1',
            apiKey: testSecret
        }
    })

    // 1. 获取初始存储状态
    const rowInitial = db.prepare('SELECT ai_config_enc, updated_at FROM user_profiles WHERE id = ?').get(profile.id)
    const initialEnc = rowInitial.ai_config_enc
    const initialUpdatedAt = rowInitial.updated_at
    assert.ok(initialEnc.startsWith('enc:v1:'))

    // 2. 连续读取 5 次，验证每次返回正确明文，且数据库密文与 updated_at 绝对保持不变（零写操作）
    for (let i = 0; i < 5; i++) {
        const decryptedConfig = getDecryptedAiConfig(db, profile.id)
        assert.equal(decryptedConfig?.apiKey, testSecret)

        const rowCurrent = db.prepare('SELECT ai_config_enc, updated_at FROM user_profiles WHERE id = ?').get(profile.id)
        assert.equal(rowCurrent.ai_config_enc, initialEnc, `第 ${i + 1} 次读取密文不得发生变化`)
        assert.equal(rowCurrent.updated_at, initialUpdatedAt, `第 ${i + 1} 次读取 updated_at 不得被刷新`)
    }

    // 3. 验证历史明文/旧格式单次迁移
    const rawPlainConfig = JSON.stringify({ provider: 'custom', baseUrl: 'https://gateway.example.com/v1', apiKey: 'sk-legacy-unencrypted' })
    const legacyTime = 1000000000000
    db.prepare('UPDATE user_profiles SET ai_config_enc = ?, updated_at = ? WHERE id = ?').run(rawPlainConfig, legacyTime, profile.id)

    // 第一次读取：触发单次平滑迁移
    const migrated1 = getDecryptedAiConfig(db, profile.id)
    assert.equal(migrated1?.apiKey, 'sk-legacy-unencrypted')

    const rowAfterMigration = db.prepare('SELECT ai_config_enc, updated_at FROM user_profiles WHERE id = ?').get(profile.id)
    assert.ok(rowAfterMigration.ai_config_enc.startsWith('enc:v1:'), '历史明文已被升级为标准加密密文')
    assert.notEqual(rowAfterMigration.updated_at, legacyTime, '迁移时记录更新时间戳')

    const stableEnc = rowAfterMigration.ai_config_enc
    const stableUpdatedAt = rowAfterMigration.updated_at

    // 后续连续读取 5 次：已是当前主密钥加密，转为严格只读，密文与 updated_at 不再改变
    for (let i = 0; i < 5; i++) {
        const decLoop = getDecryptedAiConfig(db, profile.id)
        assert.equal(decLoop?.apiKey, 'sk-legacy-unencrypted')

        const rowLoop = db.prepare('SELECT ai_config_enc, updated_at FROM user_profiles WHERE id = ?').get(profile.id)
        assert.equal(rowLoop.ai_config_enc, stableEnc, `迁移后第 ${i + 1} 次读取密文保持恒定`)
        assert.equal(rowLoop.updated_at, stableUpdatedAt, `迁移后第 ${i + 1} 次读取 updated_at 保持恒定`)
    }

    // 4. 验证解密失败时绝不覆盖损坏原有密文
    const corruptCipher = 'enc:v1:badbadbadbadbadbad:badbadbadbadbadbadbadbadbadbad:badbadbadbad'
    const corruptTime = 2000000000000
    db.prepare('UPDATE user_profiles SET ai_config_enc = ?, updated_at = ? WHERE id = ?').run(corruptCipher, corruptTime, profile.id)

    const failedResult = getDecryptedAiConfig(db, profile.id)
    assert.equal(failedResult, null, '解密失败应返回 null')

    const rowCorruptCheck = db.prepare('SELECT ai_config_enc, updated_at FROM user_profiles WHERE id = ?').get(profile.id)
    assert.equal(rowCorruptCheck.ai_config_enc, corruptCipher, '解密失败绝不能覆盖原密文')
    assert.equal(rowCorruptCheck.updated_at, corruptTime, '解密失败绝不能更改时间戳')
})

// =========================================================================
// 问题 4 验证：密钥生命周期、环境变量独立性、绝不写盘与防静默降级
// =========================================================================

// =========================================================================
// 问题 4 验证：密钥生命周期、环境变量独立性、绝不写盘与防静默降级
// =========================================================================

test('问题 4 验证: MS_ENCRYPTION_SECRET 独立于数据卷绝不写盘，.device_key 原子写入且无静默降级', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ms-rewards-crypto-test-'))
    const oldSessionDir = process.env.MS_SESSION_DIR
    const oldEnvSecret = process.env.MS_ENCRYPTION_SECRET
    const oldPrevSecret = process.env.MS_PREVIOUS_ENCRYPTION_SECRET

    try {
        process.env.MS_SESSION_DIR = tempDir
        delete process.env.MS_ENCRYPTION_SECRET
        delete process.env.MS_PREVIOUS_ENCRYPTION_SECRET

        // 1. 无环境变量时：首次自动在 tempDir 原子创建 .device_key，权限为 0600
        const testSecret = 'sk-device-key-isolation-test-1122'
        const enc1 = encryptSecret(testSecret)
        assert.ok(enc1.startsWith('enc:v1:'))

        const keyPath = resolveDeviceKeyPath()
        assert.ok(fs.existsSync(keyPath), '.device_key 文件必须已创建')
        const deviceKeyHex = fs.readFileSync(keyPath, 'utf8').trim()
        assert.equal(deviceKeyHex.length, 64, '.device_key 必须为 64 位 Hex 字符串')

        // 验证绝对没有生成 .device_key_history 历史文件
        assert.ok(
            !fs.existsSync(path.join(tempDir, '.device_key_history')),
            '严禁在磁盘上生成任何 .device_key_history 明文密钥历史文件'
        )

        // 2. 设置临时环境变量 MS_ENCRYPTION_SECRET
        const fictionalEnvSecret = 'fictional-super-secure-token-887766'
        process.env.MS_ENCRYPTION_SECRET = fictionalEnvSecret

        const envEncrypted = encryptSecret(testSecret)
        assert.ok(envEncrypted.startsWith('enc:v1:'))

        // 核心安全断言：环境变量密钥绝不能被写入 .device_key 文件！.device_key 内容保持完全未被篡改！
        const deviceKeyAfterEnv = fs.readFileSync(keyPath, 'utf8').trim()
        assert.equal(deviceKeyAfterEnv, deviceKeyHex, '设置 MS_ENCRYPTION_SECRET 绝不能覆盖磁盘上的 .device_key')
        assert.ok(
            !fs.existsSync(path.join(tempDir, '.device_key_history')),
            '设置环境变量后仍严禁生成 .device_key_history 文件'
        )

        // 3. 显式提供原密钥 MS_PREVIOUS_ENCRYPTION_SECRET：能够成功解密并平滑迁移！
        delete process.env.MS_ENCRYPTION_SECRET
        process.env.MS_PREVIOUS_ENCRYPTION_SECRET = fictionalEnvSecret
        const decWithPrev = decryptSecretWithMeta(envEncrypted)
        assert.equal(decWithPrev.plaintext, testSecret, '通过 MS_PREVIOUS_ENCRYPTION_SECRET 成功完成跨密钥解密')
        assert.equal(decWithPrev.needsMigration, true, '标记需要迁移回当前主密钥')

        // 4. 防静默降级断言：当 .device_key 存在但损坏（非法字符或长度不足）时，必须显式抛错，绝不降级为弱熵特征密钥
        delete process.env.MS_PREVIOUS_ENCRYPTION_SECRET
        fs.writeFileSync(keyPath, 'corrupted_invalid_hex_content', { mode: 0o600 })
        assert.throws(() => {
            encryptSecret('any-data')
        }, /设备密钥文件内容已损坏或格式非法/, '设备密钥损坏时必须显式抛出异常阻断，禁止悄然降级')

    } finally {
        if (oldSessionDir !== undefined) process.env.MS_SESSION_DIR = oldSessionDir
        else delete process.env.MS_SESSION_DIR
        if (oldEnvSecret !== undefined) process.env.MS_ENCRYPTION_SECRET = oldEnvSecret
        else delete process.env.MS_ENCRYPTION_SECRET
        if (oldPrevSecret !== undefined) process.env.MS_PREVIOUS_ENCRYPTION_SECRET = oldPrevSecret
        else delete process.env.MS_PREVIOUS_ENCRYPTION_SECRET
        try { fs.rmSync(tempDir, { recursive: true, force: true }) } catch (_) {}
    }
})

// =========================================================================
// 端到端临时 DB 回归：.device_key 密文在临时 env 覆盖期间读取绝不迁移，移除 env 凭据依然可用
// =========================================================================

test('问题 4 端到端回归: 先用 .device_key 保存配置→设置临时 env→GET读取零修改→移除 env 仍可解密', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ms-rewards-e2e-crypto-'))
    const oldSessionDir = process.env.MS_SESSION_DIR
    const oldEnvSecret = process.env.MS_ENCRYPTION_SECRET
    const oldPrevSecret = process.env.MS_PREVIOUS_ENCRYPTION_SECRET

    try {
        process.env.MS_SESSION_DIR = tempDir
        delete process.env.MS_ENCRYPTION_SECRET
        delete process.env.MS_PREVIOUS_ENCRYPTION_SECRET

        const dbPath = path.join(tempDir, 'sessions.db')
        const db = new DatabaseSync(dbPath)
        initProfileSchema(db)

        // 1. 无环境变量时：先用磁盘 .device_key 保存 AI 配置
        const originalApiKey = 'sk-device-key-e2e-persistent-key-9988'
        const profile = saveProfile(db, {
            name: '设备密钥持久化测试',
            email: 'persistent@example.com',
            aiConfig: {
                enabled: true,
                provider: 'openai',
                baseUrl: 'https://api.openai.com/v1',
                apiKey: originalApiKey
            }
        })

        // 记录初始保存状态
        const initialRow = db.prepare('SELECT ai_config_enc, updated_at FROM user_profiles WHERE id = ?').get(profile.id)
        assert.ok(initialRow.ai_config_enc.startsWith('enc:v1:'))
        const savedEnc = initialRow.ai_config_enc
        const savedUpdatedAt = initialRow.updated_at

        // 2. 临时设置环境变量 MS_ENCRYPTION_SECRET 覆盖
        const temporaryEnvSecret = 'temp-temporary-env-secret-9999'
        process.env.MS_ENCRYPTION_SECRET = temporaryEnvSecret

        // 3. 执行 getDecryptedAiConfig / GET 纯读操作多次
        for (let i = 0; i < 3; i++) {
            const readConfig = getDecryptedAiConfig(db, profile.id)
            assert.equal(readConfig?.apiKey, originalApiKey, `临时 env 覆盖下第 ${i + 1} 次读取明文必须正确`)

            // 核心断言：读取期间密文和 updated_at 必须保持完全不变！绝不能被自动迁移成 env 密钥加密！
            const rowDuringEnv = db.prepare('SELECT ai_config_enc, updated_at FROM user_profiles WHERE id = ?').get(profile.id)
            assert.equal(rowDuringEnv.ai_config_enc, savedEnc, `临时 env 覆盖下第 ${i + 1} 次读取密文不得发生变化`)
            assert.equal(rowDuringEnv.updated_at, savedUpdatedAt, `临时 env 覆盖下第 ${i + 1} 次读取 updated_at 不得被更新`)
        }

        // 4. 移除临时环境变量 MS_ENCRYPTION_SECRET
        delete process.env.MS_ENCRYPTION_SECRET

        // 5. 核心终检验收：无需任何额外历史 env，移除临时 env 后直接读取仍可解密！且密文与时间戳仍恒定！
        const readAfterEnvRemoved = getDecryptedAiConfig(db, profile.id)
        assert.equal(readAfterEnvRemoved?.apiKey, originalApiKey, '移除临时 env 后必须无需额外历史 env 即可成功解密')

        const rowFinal = db.prepare('SELECT ai_config_enc, updated_at FROM user_profiles WHERE id = ?').get(profile.id)
        assert.equal(rowFinal.ai_config_enc, savedEnc, '整个流程中密文始终未被篡改')
        assert.equal(rowFinal.updated_at, savedUpdatedAt, '整个流程中 updated_at 始终未被篡改')

        db.close()
    } finally {
        if (oldSessionDir !== undefined) process.env.MS_SESSION_DIR = oldSessionDir
        else delete process.env.MS_SESSION_DIR
        if (oldEnvSecret !== undefined) process.env.MS_ENCRYPTION_SECRET = oldEnvSecret
        else delete process.env.MS_ENCRYPTION_SECRET
        if (oldPrevSecret !== undefined) process.env.MS_PREVIOUS_ENCRYPTION_SECRET = oldPrevSecret
        else delete process.env.MS_PREVIOUS_ENCRYPTION_SECRET
        try { fs.rmSync(tempDir, { recursive: true, force: true }) } catch (_) {}
    }
})

// =========================================================================
// 深度回归：旧机器特征密钥密文与旧明文在临时 env 覆盖下读取绝不写库，移除 env 后完好解密
// =========================================================================

test('问题 4 深度回归: 旧机器特征与旧明文在临时 env 覆盖下零写库，移除 env 后无损恢复并向 .device_key 迁移', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ms-rewards-legacy-env-'))
    const oldSessionDir = process.env.MS_SESSION_DIR
    const oldEnvSecret = process.env.MS_ENCRYPTION_SECRET
    const oldPrevSecret = process.env.MS_PREVIOUS_ENCRYPTION_SECRET

    try {
        process.env.MS_SESSION_DIR = tempDir
        delete process.env.MS_ENCRYPTION_SECRET
        delete process.env.MS_PREVIOUS_ENCRYPTION_SECRET

        const db = new DatabaseSync(':memory:')
        initProfileSchema(db)

        // 1. 构造一个由历史旧机器特征密钥加密的密文
        const legacyMachineKey = getLegacyMachineEntropyKeys()[0]
        const machineIv = crypto.randomBytes(12)
        const cipher = crypto.createCipheriv('aes-256-gcm', legacyMachineKey, machineIv)
        const secretPayload = JSON.stringify({ provider: 'openai', baseUrl: 'https://api.openai.com/v1', apiKey: 'sk-legacy-machine-key-secret' })
        let encMachine = cipher.update(secretPayload, 'utf8', 'hex')
        encMachine += cipher.final('hex')
        const authTag = cipher.getAuthTag().toString('hex')
        const legacyMachineCipher = `enc:v1:${machineIv.toString('hex')}:${authTag}:${encMachine}`

        // 2. 构造一个旧明文字符串
        const legacyPlainCipher = JSON.stringify({ provider: 'custom', baseUrl: 'https://api.openai.com/v1', apiKey: 'sk-legacy-plain-secret' })

        // 插入数据库
        const pMachine = saveProfile(db, { name: '旧机器特征测试', email: 'machine@test.com' })
        const pPlain = saveProfile(db, { name: '旧明文测试', email: 'plain@test.com' })

        const initialMachineTime = 1000000000000
        const initialPlainTime = 2000000000000
        db.prepare('UPDATE user_profiles SET ai_config_enc = ?, updated_at = ? WHERE id = ?').run(legacyMachineCipher, initialMachineTime, pMachine.id)
        db.prepare('UPDATE user_profiles SET ai_config_enc = ?, updated_at = ? WHERE id = ?').run(legacyPlainCipher, initialPlainTime, pPlain.id)

        // 3. 临时设置环境变量 MS_ENCRYPTION_SECRET 覆盖
        process.env.MS_ENCRYPTION_SECRET = 'temporary-env-secret-for-legacy-test'

        // 4. 在临时 env 覆盖期间执行 GET / getDecryptedAiConfig 读取
        const decDuringEnvMachine = getDecryptedAiConfig(db, pMachine.id)
        const decDuringEnvPlain = getDecryptedAiConfig(db, pPlain.id)

        // 验证读取明文正确
        assert.equal(decDuringEnvMachine?.apiKey, 'sk-legacy-machine-key-secret', '临时 env 下旧机器特征密文必须可读')
        assert.equal(decDuringEnvPlain?.apiKey, 'sk-legacy-plain-secret', '临时 env 下旧明文必须可读')

        // 核心核查断言：此时绝对不能被临时 env 覆盖写库！密文与 updated_at 必须保持完全不变！
        const rowMachineDuringEnv = db.prepare('SELECT ai_config_enc, updated_at FROM user_profiles WHERE id = ?').get(pMachine.id)
        const rowPlainDuringEnv = db.prepare('SELECT ai_config_enc, updated_at FROM user_profiles WHERE id = ?').get(pPlain.id)

        assert.equal(rowMachineDuringEnv.ai_config_enc, legacyMachineCipher, '临时 env 下旧机器特征密文绝对不得被自动改写')
        assert.equal(rowMachineDuringEnv.updated_at, initialMachineTime, '临时 env 下旧机器特征 updated_at 绝对不得被刷新')

        assert.equal(rowPlainDuringEnv.ai_config_enc, legacyPlainCipher, '临时 env 下旧明文绝对不得被自动改写')
        assert.equal(rowPlainDuringEnv.updated_at, initialPlainTime, '临时 env 下旧明文 updated_at 绝对不得被刷新')

        // 5. 移除临时环境变量 MS_ENCRYPTION_SECRET
        delete process.env.MS_ENCRYPTION_SECRET

        // 6. 核心核查验收：移除 env 后，无需任何额外历史 env，两者依然完全可读！
        const decAfterEnvMachine = getDecryptedAiConfig(db, pMachine.id)
        const decAfterEnvPlain = getDecryptedAiConfig(db, pPlain.id)

        assert.equal(decAfterEnvMachine?.apiKey, 'sk-legacy-machine-key-secret', '移除临时 env 后旧机器特征密文仍可完好解密')
        assert.equal(decAfterEnvPlain?.apiKey, 'sk-legacy-plain-secret', '移除临时 env 后旧明文仍可完好解密')

        // 7. 此时（处于稳定持久的 .device_key 模式下），系统成功将其单次平滑升级迁移至 .device_key
        const rowMachineFinal = db.prepare('SELECT ai_config_enc, updated_at FROM user_profiles WHERE id = ?').get(pMachine.id)
        const rowPlainFinal = db.prepare('SELECT ai_config_enc, updated_at FROM user_profiles WHERE id = ?').get(pPlain.id)

        assert.ok(rowMachineFinal.ai_config_enc.startsWith('enc:v1:'))
        assert.notEqual(rowMachineFinal.ai_config_enc, legacyMachineCipher, '在稳定目标密钥下，旧机器特征成功升级迁移为 .device_key 密文')
        assert.notEqual(rowMachineFinal.updated_at, initialMachineTime, '迁移时更新时间戳')

        assert.ok(rowPlainFinal.ai_config_enc.startsWith('enc:v1:'))
        assert.notEqual(rowPlainFinal.updated_at, initialPlainTime, '旧明文迁移时更新时间戳')

        // 8. 迁移后再次连续读取多次，纯只读，密文与时间戳绝对恒定
        for (let i = 0; i < 3; i++) {
            const decStable = getDecryptedAiConfig(db, pMachine.id)
            assert.equal(decStable?.apiKey, 'sk-legacy-machine-key-secret')
            const rowCheck = db.prepare('SELECT ai_config_enc, updated_at FROM user_profiles WHERE id = ?').get(pMachine.id)
            assert.equal(rowCheck.ai_config_enc, rowMachineFinal.ai_config_enc, '升级后读取纯只读')
            assert.equal(rowCheck.updated_at, rowMachineFinal.updated_at)
        }

        db.close()
    } finally {
        if (oldSessionDir !== undefined) process.env.MS_SESSION_DIR = oldSessionDir
        else delete process.env.MS_SESSION_DIR
        if (oldEnvSecret !== undefined) process.env.MS_ENCRYPTION_SECRET = oldEnvSecret
        else delete process.env.MS_ENCRYPTION_SECRET
        if (oldPrevSecret !== undefined) process.env.MS_PREVIOUS_ENCRYPTION_SECRET = oldPrevSecret
        else delete process.env.MS_PREVIOUS_ENCRYPTION_SECRET
        try { fs.rmSync(tempDir, { recursive: true, force: true }) } catch (_) {}
    }
})

// =========================================================================
// 并发竞态与原子创建验证：首次生成 .device_key 使用独占创建 (flag: 'wx') 绝不覆盖抢先进程
// =========================================================================

test('问题 4 并发竞态验证: 首次生成 .device_key 独占原子创建，杜绝竞态覆盖先到进程的密钥', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ms-rewards-concurrency-'))
    const oldSessionDir = process.env.MS_SESSION_DIR
    const oldEnvSecret = process.env.MS_ENCRYPTION_SECRET

    try {
        process.env.MS_SESSION_DIR = tempDir
        delete process.env.MS_ENCRYPTION_SECRET

        const keyPath = resolveDeviceKeyPath()
        assert.ok(!fs.existsSync(keyPath), '测试前密钥文件不存在')

        // 1. 模拟进程 A 先行创建并生成密钥 Key A
        const keyA = getDeviceKey()
        assert.ok(Buffer.isBuffer(keyA))
        assert.ok(fs.existsSync(keyPath), '进程 A 成功创建密钥文件')
        const fileContentAfterA = fs.readFileSync(keyPath, 'utf8').trim()
        assert.equal(fileContentAfterA, keyA.toString('hex'))

        // 2. 模拟进程 B 紧接着请求设备密钥，必须读取到与进程 A 完全一致的 Key A，绝对不得覆盖
        const keyB = getDeviceKey()
        assert.ok(keyA.equals(keyB), '进程 B 必须复用已创建的密钥，返回完全一致的 Key')
        const fileContentAfterB = fs.readFileSync(keyPath, 'utf8').trim()
        assert.equal(fileContentAfterB, fileContentAfterA, '文件内容绝对未被二次覆盖')

        // 3. 验证 flag: 'wx' 的原子独占特性：若文件已存在，直接调用 writeFileSync(..., { flag: 'wx' }) 必须抛出 EEXIST
        assert.throws(() => {
            fs.writeFileSync(keyPath, crypto.randomBytes(32).toString('hex'), { flag: 'wx' })
        }, (err) => {
            return err.code === 'EEXIST' || err.message?.includes('already exists')
        }, '底层文件系统必须支持 flag: wx 抛出 EEXIST 阻断并发写入')

    } finally {
        if (oldSessionDir !== undefined) process.env.MS_SESSION_DIR = oldSessionDir
        else delete process.env.MS_SESSION_DIR
        if (oldEnvSecret !== undefined) process.env.MS_ENCRYPTION_SECRET = oldEnvSecret
        else delete process.env.MS_ENCRYPTION_SECRET
        try { fs.rmSync(tempDir, { recursive: true, force: true }) } catch (_) {}
    }
})

// =========================================================================
// 问题 5 验证：AI URL 目标强绑定、IPv4映射IPv6、DNS解析私网与SSRF拦截
// =========================================================================

test('问题 5 验证: verifyAiUrlTargetBinding 严格锁定端点路径与参数，并阻断 IPv4映射IPv6 与 DNS私网目标', async () => {
    const legitBaseUrl = 'https://api.openai.com/v1'
    const storedConfig = {
        provider: 'openai',
        baseUrl: legitBaseUrl,
        apiKey: 'sk-protected-openai-key-5566'
    }

    // 1. 正常情况：完全一致的端点允许沿用
    const legit = verifyAiUrlTargetBinding({
        requestUrl: legitBaseUrl,
        requestProvider: 'openai',
        inputKey: '••••••••',
        storedAiConfig: storedConfig
    })
    assert.equal(legit.finalKey, 'sk-protected-openai-key-5566')
    assert.equal(legit.usingStoredKey, true)
    assert.equal(legit.targetUrl, 'https://api.openai.com/v1')

    // 2. 攻击场景 A：同 Origin，但篡改不同路径 (如 /evil 或 /v1/chat/completions/evil)
    assert.throws(() => {
        verifyAiUrlTargetBinding({
            requestUrl: 'https://api.openai.com/evil/path',
            requestProvider: 'openai',
            inputKey: '',
            storedAiConfig: storedConfig
        })
    }, /安全防御拦截 \(S2\): 使用已保存的 API Key 时，禁止同域替换目标端点路径/)

    // 3. 攻击场景 B：同 Origin、同路径，但追加 URL Query 参数企图外带凭据
    assert.throws(() => {
        verifyAiUrlTargetBinding({
            requestUrl: 'https://api.openai.com/v1?leak_param=steal',
            requestProvider: 'openai',
            inputKey: '',
            storedAiConfig: storedConfig
        })
    }, /安全防御拦截 \(S2\): 使用已保存的 API Key 时，禁止附加或修改 URL Query 参数/)

    // 4. 攻击场景 C：IPv4 私网与保留网段拦截 (RFC 1918 / 169.254 / 0.0.0.0 等)
    const blockedIpv4 = [
        'https://192.168.1.1/v1',
        'https://10.0.0.1/v1',
        'https://172.16.0.1/v1',
        'https://169.254.169.254/latest/meta-data',
        'https://127.0.0.2/v1',
        'https://0.0.0.0:8080/v1'
    ]
    for (const target of blockedIpv4) {
        assert.throws(() => {
            validateAndNormalizeAiUrl(target, 'custom')
        }, /安全校验拦截: 目标地址禁止指向内网私有保留 IP/, `必须阻断内网私有目标: ${target}`)
    }

    // 5. 核心核查闭环：IPv4 映射 IPv6、IPv6 转换与私网保留范围拦截
    const blockedIpv6Mapped = [
        'https://[::ffff:127.0.0.1]/v1',
        'https://[::ffff:7f00:1]/v1',
        'https://[::ffff:10.0.0.1]/v1',
        'https://[::ffff:192.168.1.1]/v1',
        'https://[64:ff9b::192.168.1.1]/v1',
        'https://[2002:c0a8:0101::]/v1',
        'https://[fc00::1]/v1',
        'https://[fe80::1]/v1',
        'https://[::]/v1'
    ]
    for (const target of blockedIpv6Mapped) {
        assert.throws(() => {
            validateAndNormalizeAiUrl(target, 'custom')
        }, /安全校验拦截: 目标地址禁止指向内网私有保留 IP/, `必须阻断 IPv4映射IPv6 或保留地址: ${target}`)
    }

    // 6. 核心核查闭环：DNS 解析到私网 IP (DNS Rebinding 防御)
    // 6.1 字面私网 IP 校验
    await assert.rejects(async () => {
        await verifyDnsResolutionSecurity('192.168.1.1')
    }, /安全拦截: 目标 IP .* 属于私有局域网/)

    await assert.rejects(async () => {
        await verifyDnsResolutionSecurity('127.0.0.1', false)
    }, /安全拦截: 目标 IP .* 属于私有局域网/)

    // 6.2 模拟域名解析到 127.0.0.1 (域名 DNS Rebinding 到本地回环)
    const originalLookup = dns.promises.lookup
    try {
        dns.promises.lookup = async (host) => {
            if (host === 'evil-rebinding.local') {
                return [{ address: '127.0.0.1', family: 4 }]
            }
            if (host === 'evil-internal.local') {
                return [{ address: '192.168.1.100', family: 4 }]
            }
            return originalLookup(host, { all: true, verbatim: true })
        }

        // 域名解析到 127.0.0.1 必须无条件阻断 (即便 allowLoopback 开启，域名也绝不能指向回环)
        await assert.rejects(async () => {
            await verifyDnsResolutionSecurity('evil-rebinding.local', true)
        }, /DNS 安全拦截: 域名 .* 解析到了私有\/回环受限 IP/)

        // 域名解析到内网 192.168.1.100 必须阻断
        await assert.rejects(async () => {
            await verifyDnsResolutionSecurity('evil-internal.local', false)
        }, /DNS 安全拦截: 域名 .* 解析到了私有\/回环受限 IP/)

        // 6.3 端到端建连前拦截：testAiConnection 传入恶意域名绝不发包
        const testRes = await testAiConnection({
            baseUrl: 'https://evil-rebinding.local/v1',
            apiKey: 'sk-fake-isolated-audit-key',
            provider: 'custom'
        })
        assert.equal(testRes.success, false)
        assert.ok(testRes.error.includes('DNS 安全拦截') || testRes.error.includes('私有/回环受限 IP'))

    } finally {
        dns.promises.lookup = originalLookup
    }

    // 7. 本地回环模型服务 (Ollama / LM Studio) 合法字面地址放行
    assert.equal(validateAndNormalizeAiUrl('http://127.0.0.1:11434/v1', 'ollama'), 'http://127.0.0.1:11434/v1')
    assert.equal(validateAndNormalizeAiUrl('http://localhost:1234/v1', 'lmstudio'), 'http://localhost:1234/v1')
})

// =========================================================================
// 问题 5 进阶验证：IP Pinning 固化建连与 TOCTOU DNS Rebinding 隔离防御 (本地合成服务验证)
// =========================================================================

test('问题 5 进阶验证: IP Pinning 固化建连与 TOCTOU DNS Rebinding 隔离防御 (本地合成服务验证)', async () => {
    // 1. 创建本地合成测试 HTTP 服务 (完全隔离于 127.0.0.1 随机端口)
    let requestCount = 0
    let lastReceivedHost = null
    const syntheticServer = http.createServer((req, res) => {
        requestCount++
        lastReceivedHost = req.headers['host']
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ ok: true, msg: 'synthetic-pong', count: requestCount }))
    })

    await new Promise((resolve) => syntheticServer.listen(0, '127.0.0.1', resolve))
    const serverPort = syntheticServer.address().port

    const originalLookup = dns.promises.lookup

    try {
        // 2. 正常场景：本地回环字面 IP 访问合成服务
        const directRes = await secureFetchWithPinnedDns(`http://127.0.0.1:${serverPort}/ping`)
        assert.equal(directRes.status, 200)
        const directBody = await directRes.json()
        assert.equal(directBody.msg, 'synthetic-pong')
        assert.equal(requestCount, 1)

        // 3. TOCTOU DNS Rebinding 攻击模拟：
        // 攻击者控制一个域名 rebind.attacker.local，DNS 行为动态变更：
        // 第一次查询：返回合法公网 IP (例如 93.184.216.34)
        // 第二次查询 (若系统没有 IP Pinning)：立即变更返回 127.0.0.1，企图使发起的实际请求连向本地内网服务！
        let queryCounter = 0
        dns.promises.lookup = async (hostname) => {
            if (hostname === 'rebind.attacker.local') {
                queryCounter++
                if (queryCounter === 1) {
                    return [{ address: '93.184.216.34', family: 4 }]
                } else {
                    return [{ address: '127.0.0.1', family: 4 }]
                }
            }
            return originalLookup(hostname, { all: true, verbatim: true })
        }

        // 验证 3.1: resolveAndPinSafeHost 能够固化首次校验通过的 IP (93.184.216.34)
        const { pinnedIp } = await resolveAndPinSafeHost('rebind.attacker.local', false)
        assert.equal(pinnedIp, '93.184.216.34', '必须固化首次通过校验的合法 IP')

        // 验证 3.2: 模拟域名首次解析就返回内网私有 IP (如 192.168.1.50)
        dns.promises.lookup = async (hostname) => {
            if (hostname === 'private.attacker.local') {
                return [{ address: '192.168.1.50', family: 4 }]
            }
            return originalLookup(hostname, { all: true, verbatim: true })
        }

        const preCount = requestCount
        await assert.rejects(async () => {
            await secureFetchWithPinnedDns(`http://private.attacker.local:${serverPort}/evil`)
        }, /DNS 安全拦截: 域名 "private.attacker.local" 解析到了私有\/回环受限 IP/)

        // 断言：由于在建连前单次解析校验被拦截，本地合成服务绝未收到任何请求
        assert.equal(requestCount, preCount, '拦截恶意私网域名时绝不得向目标发送任何网络包')

        // 验证 3.3: 模拟域名首次解析返回本地回环 (127.0.0.1) 攻击
        dns.promises.lookup = async (hostname) => {
            if (hostname === 'loopback.attacker.local') {
                return [{ address: '127.0.0.1', family: 4 }]
            }
            return originalLookup(hostname, { all: true, verbatim: true })
        }

        await assert.rejects(async () => {
            await secureFetchWithPinnedDns(`http://loopback.attacker.local:${serverPort}/evil`)
        }, /DNS 安全拦截: 域名 "loopback.attacker.local" 解析到了私有\/回环受限 IP/)

        assert.equal(requestCount, preCount, '域名指向回环时无条件拦截，绝不向服务发送网络包')

    } finally {
        dns.promises.lookup = originalLookup
        await new Promise((resolve) => syntheticServer.close(resolve))
    }
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

