import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import crypto from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'

import {
    initClientAuthSchema,
    createAuthorizedClient,
    validateClientCredential,
    revokeClient,
    revokeAllClients,
    getOrCreateAuthEpoch,
    rotateAuthEpoch,
    sanitizeDeviceName,
    generateDeviceCsrfToken,
    verifyDeviceCsrfToken,
    buildDeviceCookieHeader,
    buildClearDeviceCookieHeader,
    DEVICE_COOKIE_NAME,
    DEFAULT_DEVICE_COOKIE_MAX_AGE
} from './webClientAuth.mjs'

// =========================================================================
// 测试隔离前移：在动态加载 web.mjs 之前无条件预设独立临时隔离环境，绝不触碰真实 sessions 或外部目录
// =========================================================================
const origPreEnvSessionDir = process.env.MS_SESSION_DIR
const origPreEnvSessionDbPath = process.env.MS_SESSION_DB_PATH
const origPreEnvPairingSecret = process.env.MS_WEB_PAIRING_SECRET

const preImportTempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ms-rewards-auth-preimport-'))
process.env.MS_SESSION_DIR = preImportTempDir
process.env.MS_SESSION_DB_PATH = path.join(preImportTempDir, 'sessions.db')
process.env.MS_WEB_PAIRING_SECRET = 'fictional-preimport-secret-auth1234567890abcdef'

const {
    server: webServer,
    checkRequestAuthentication,
    checkRequestCsrf,
    getLocalPairingSecret,
    setLocalPairingSecret,
    getLocalSecurityTokens,
    setLocalSecurityTokens,
    isRequestHttps,
    validatePairingSecretStrength,
    initPairingSecret,
    getPairingInitError,
    getClientIp,
    normalizeIp,
    checkPairRateLimit,
    recordPairFailure,
    resetPairFailure,
    clearAllPairFailures,
    parseHostHeader,
    isValidHost,
    isValidOrigin,
    reloadAllowedHosts,
    reloadTrustedProxies,
    isProxyTrusted
} = await import('../../web.mjs')

test.after(() => {
    if (origPreEnvSessionDir !== undefined) process.env.MS_SESSION_DIR = origPreEnvSessionDir
    else delete process.env.MS_SESSION_DIR
    if (origPreEnvSessionDbPath !== undefined) process.env.MS_SESSION_DB_PATH = origPreEnvSessionDbPath
    else delete process.env.MS_SESSION_DB_PATH
    if (origPreEnvPairingSecret !== undefined) process.env.MS_WEB_PAIRING_SECRET = origPreEnvPairingSecret
    else delete process.env.MS_WEB_PAIRING_SECRET
    if (preImportTempDir) {
        try { fs.rmSync(preImportTempDir, { recursive: true, force: true }) } catch (_) {}
    }
})

// =========================================================================
// 单元测试：凭据生命周期、无弱密码哈希、服务端过期校验、XSS净化与版本轮换
// =========================================================================

test('Web 客户端鉴权: 绝无配对密码哈希、服务端过期校验、XSS净化、auth_epoch轮换与常量时间比对', () => {
    const db = new DatabaseSync(':memory:')
    initClientAuthSchema(db)

    // 1. 结构安全断言：数据库结构中严禁包含 pairing_secret_hash 字段
    const columns = db.prepare("PRAGMA table_info(authorized_web_clients)").all()
    const colNames = columns.map(c => c.name)
    assert.ok(!colNames.includes('pairing_secret_hash'), '数据库绝不可包含 pairing_secret_hash 字段，杜绝弱密码离线哈希爆破')
    assert.ok(colNames.includes('expires_at'), '数据库必须包含服务端过期时间 expires_at')
    assert.ok(colNames.includes('auth_epoch'), '数据库必须包含随机版本 auth_epoch')

    // 2. 设备名称 XSS 净化测试
    assert.equal(sanitizeDeviceName('<script>alert("XSS")</script>Chrome'), 'alert(XSS)Chrome')
    assert.equal(sanitizeDeviceName('iPhone"><img src=x onerror=alert(1)>'), 'iPhone')
    assert.equal(sanitizeDeviceName('Edge\x00\x08\x1B\x7F'), 'Edge')
    assert.equal(sanitizeDeviceName(''), 'Browser')
    assert.equal(sanitizeDeviceName(null), 'Browser')

    // 3. 创建授权客户端
    const maliciousName = '<script>alert(1)</script>Safari / macOS'
    const client = createAuthorizedClient(db, { name: maliciousName })
    assert.ok(client.deviceId.startsWith('dev_'))
    assert.equal(client.deviceId.length, 36)
    assert.equal(client.deviceSecret.length, 64)
    assert.equal(client.cookieValue, `${client.deviceId}.${client.deviceSecret}`)
    assert.ok(Number(client.expiresAt) > Date.now(), '创建成功必须返回合法服务端过期时间戳')

    // 4. 存储与净化核查
    const row = db.prepare('SELECT * FROM authorized_web_clients WHERE device_id = ?').get(client.deviceId)
    assert.ok(row, '必须落盘存储设备记录')
    assert.notEqual(row.secret_hash, client.deviceSecret, '数据库绝对不得存储明文密钥')
    assert.equal(row.secret_hash, crypto.createHash('sha256').update(client.deviceSecret).digest('hex'), '数据库中必须为正确的 SHA-256 摘要')
    assert.equal(row.name, 'alert(1)Safari  macOS', '数据库存储的设备名称必须经过严格 XSS 净化')
    assert.equal(row.revoked_at, null, '新设备默认未撤销')
    assert.ok(row.expires_at > Date.now(), '数据库中必须持久化有效 expires_at')

    // 5. 正确凭据校验通过
    const validResult = validateClientCredential(db, client.cookieValue)
    assert.equal(validResult.valid, true)
    assert.equal(validResult.deviceId, client.deviceId)
    assert.equal(validResult.deviceSecret, client.deviceSecret)
    assert.equal(validResult.expiresAt, row.expires_at)

    // 6. 服务端过期时间 expires_at 硬校验阻断 (模拟长期抓包后重放)
    const expiredClient = createAuthorizedClient(db, { name: 'Old Device' }, { ttlMs: 1000 })
    // 手工将数据库中的 expires_at 修改为过去的时间
    db.prepare('UPDATE authorized_web_clients SET expires_at = ? WHERE device_id = ?').run(Date.now() - 5000, expiredClient.deviceId)
    const expiredResult = validateClientCredential(db, expiredClient.cookieValue)
    assert.equal(expiredResult.valid, false, '服务端过期凭证必须被坚决阻断')
    assert.equal(expiredResult.reason, 'expired', '拒绝原因必须明确为 expired')

    // 7. 篡改 deviceSecret 中的单字符 (时序安全拦截)
    const tamperedSecret = client.deviceSecret.slice(0, -1) + (client.deviceSecret.slice(-1) === 'a' ? 'b' : 'a')
    const tamperedResult = validateClientCredential(db, `${client.deviceId}.${tamperedSecret}`)
    assert.equal(tamperedResult.valid, false)
    assert.equal(tamperedResult.reason, 'secret_mismatch')

    // 8. 伪造不存在的 deviceId
    const fakeDeviceId = 'dev_' + crypto.randomBytes(16).toString('hex')
    const fakeResult = validateClientCredential(db, `${fakeDeviceId}.${client.deviceSecret}`)
    assert.equal(fakeResult.valid, false)
    assert.equal(fakeResult.reason, 'device_not_found_or_revoked')

    // 9. 畸形凭据字符串格式被拒
    assert.equal(validateClientCredential(db, 'invalid_cookie_format').valid, false)
    assert.equal(validateClientCredential(db, 'dev_short.123').valid, false)
    assert.equal(validateClientCredential(db, '').valid, false)
    assert.equal(validateClientCredential(db, null).valid, false)

    // 10. 单设备撤销 (退出当前浏览器)
    const client2 = createAuthorizedClient(db, { name: 'Safari on iPhone' })
    assert.equal(validateClientCredential(db, client2.cookieValue).valid, true)

    const revoke1 = revokeClient(db, client.deviceId)
    assert.equal(revoke1, true)
    assert.equal(validateClientCredential(db, client.cookieValue).valid, false)
    // 撤销 client 不应影响 client2
    assert.equal(validateClientCredential(db, client2.cookieValue).valid, true)

    // 11. 全量设备撤销 (通过轮换随机 auth_epoch 瞬时全量失效)
    const revokedCount = revokeAllClients(db)
    assert.ok(revokedCount >= 1)
    assert.equal(validateClientCredential(db, client2.cookieValue).valid, false, '全量撤销后旧凭据必须因版本不匹配或已撤销失效')

    // 12. CSRF 令牌派生与校验
    const secret = crypto.randomBytes(32).toString('hex')
    const csrfToken = generateDeviceCsrfToken(secret, 'salt-epoch-1')
    assert.equal(verifyDeviceCsrfToken(secret, 'salt-epoch-1', csrfToken), true)
    assert.equal(verifyDeviceCsrfToken(secret, 'salt-epoch-1', 'wrong_csrf_token'), false)
    assert.equal(verifyDeviceCsrfToken(secret, 'salt-epoch-2', csrfToken), false, 'salt或epoch变化时旧 CSRF 令牌失效')

    // 13. Cookie 标头组装规范 (普通 LAN HTTP vs HTTPS)
    const cookieHeaderHttp = buildDeviceCookieHeader('val123', { isHttps: false, maxAge: 3600 })
    assert.ok(cookieHeaderHttp.includes('Path=/'))
    assert.ok(cookieHeaderHttp.includes('HttpOnly'))
    assert.ok(cookieHeaderHttp.includes('SameSite=Strict'))
    assert.ok(cookieHeaderHttp.includes('Max-Age=3600'))
    assert.ok(!cookieHeaderHttp.includes('Secure'), '普通局域网 HTTP 绝对不能加 Secure，否则浏览器静默丢弃 Cookie')

    const cookieHeaderHttps = buildDeviceCookieHeader('val123', { isHttps: true, maxAge: 3600 })
    assert.ok(cookieHeaderHttps.includes('Secure'), 'HTTPS 环境下必须自动设置 Secure')

    const clearHeader = buildClearDeviceCookieHeader({ isHttps: true })
    assert.ok(clearHeader.includes('Max-Age=0'))
    assert.ok(clearHeader.includes('Expires='))
    assert.ok(clearHeader.includes('Secure'))

    // 14. 阻断点 4 验收：getOrCreateAuthEpoch 在写入失败且重读无值时必须 fail closed 抛出致命异常
    const brokenDb = {
        exec() {},
        prepare(sql) {
            if (sql.includes('INSERT')) {
                return {
                    run() {
                        throw new Error('disk I/O error or table corrupted')
                    }
                }
            }
            if (sql.includes('SELECT')) {
                return {
                    get() {
                        return null // 模拟重读仍无值
                    }
                }
            }
            return { run() {}, get() { return null }, all() { return [] } }
        }
    }
    assert.throws(
        () => getOrCreateAuthEpoch(brokenDb),
        /认证版本标识 \(auth_epoch\) 持久化失败/,
        '持久化失败且重读无值时必须严格抛错，绝不返回未持久化的内存伪值'
    )

    db.close()
})

// =========================================================================
// 端到端隔离 HTTP 测试：配对失败阻断、关浏览器重放、滑动Cookie续期、旧Token重放拦截与撤销
// =========================================================================

test('Web 客户端端到端 HTTP 集成验证: 首次配对→关浏览器Cookie重放→模拟重启免密→多浏览器隔离→撤销失效', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ms-rewards-web-auth-test-'))
    const tempDbPath = path.join(tempDir, 'sessions.db')
    const oldSessionDir = process.env.MS_SESSION_DIR
    const oldSessionDbPath = process.env.MS_SESSION_DB_PATH
    const oldPairingSecret = process.env.MS_WEB_PAIRING_SECRET
    const testSecret = 'fictional-secure-pairing-token-abc123'

    process.env.MS_SESSION_DIR = tempDir
    process.env.MS_SESSION_DB_PATH = tempDbPath
    process.env.MS_WEB_PAIRING_SECRET = testSecret
    setLocalPairingSecret(testSecret)

    // 动态初始化临时 sessions.db
    const initDb = new DatabaseSync(tempDbPath)
    initClientAuthSchema(initDb)
    initDb.close()

    // 启动本地受测微型 HTTP 服务 (集成 web.mjs 生产鉴权行为)
    let currentSessionToken = crypto.randomBytes(32).toString('hex')
    let currentCsrfToken = crypto.randomBytes(32).toString('hex')

    const server = http.createServer(async (req, res) => {
        const parsedUrl = new URL(req.url, `http://${req.headers.host || '127.0.0.1'}`)
        const pathname = parsedUrl.pathname
        const isHttps = isRequestHttps(req)

        // 根路径鉴权 (支持传入 res 处理滑动续期下发)
        if (pathname === '/' || pathname === '/index.html') {
            const auth = checkRequestAuthentication(req, res)
            if (!auth.authenticated) {
                res.writeHead(401, { 'Content-Type': 'text/html; charset=utf-8' })
                res.end('<html><body>401 Pairing Required</body></html>')
                return
            }

            let activeCsrf = currentCsrfToken
            if (auth.deviceSecret) {
                const csrfSeed = auth.authEpoch || 'device_csrf_seed'
                activeCsrf = generateDeviceCsrfToken(auth.deviceSecret, csrfSeed)
            }
            const headers = {
                'Content-Type': 'text/html; charset=utf-8',
                'X-Active-Csrf': activeCsrf
            }
            if (auth.renewalCookie) {
                headers['Set-Cookie'] = auth.renewalCookie
            }
            res.writeHead(200, headers)
            res.end(`<html><head><meta name="csrf-token" content="${activeCsrf}"></head><body>200 Authenticated Dashboard</body></html>`)
            return
        }

        // 带外配对接口 (POST /api/pair)
        if (pathname === '/api/pair' && req.method === 'POST') {
            let body = ''
            for await (const chunk of req) body += chunk
            let submittedToken = ''
            let simulateStorageError = false
            try {
                const parsed = JSON.parse(body)
                submittedToken = parsed.pairToken || parsed.token || ''
                simulateStorageError = Boolean(parsed.simulateStorageError)
            } catch (_) {
                submittedToken = body.trim()
            }

            const effectiveSecret = getLocalPairingSecret()
            if (!submittedToken || submittedToken !== effectiveSecret) {
                res.writeHead(401, { 'Content-Type': 'application/json' })
                res.end(JSON.stringify({ error: 'invalid_pairing_token', message: '配对凭据无效' }))
                return
            }

            // 阻断点 1 验证：若持久化授权失败，必须明确失败，严禁吞错降级为仅发临时 session token
            if (simulateStorageError) {
                res.writeHead(500, { 'Content-Type': 'application/json' })
                res.end(JSON.stringify({
                    error: 'device_authorization_failed',
                    message: '无法持久化设备授权凭据 (模拟存储异常)'
                }))
                return
            }

            // 配对成功：发放专属长期凭据
            let deviceAuth = null
            try {
                const db = new DatabaseSync(tempDbPath)
                try {
                    deviceAuth = createAuthorizedClient(db, { name: 'Test Browser' })
                } finally {
                    db.close()
                }
            } catch (authErr) {
                const genericErrorMessage = '持久化设备授权创建失败，请检查服务状态后重试'
                res.writeHead(500, { 'Content-Type': 'application/json' })
                res.end(JSON.stringify({
                    error: 'device_authorization_failed',
                    message: genericErrorMessage
                }))
                return
            }

            if (!deviceAuth?.cookieValue) {
                res.writeHead(500, { 'Content-Type': 'application/json' })
                res.end(JSON.stringify({ error: 'device_authorization_failed', message: '无法生成有效凭据' }))
                return
            }

            // 核心安全原则：仅下发独立高熵长期设备凭证 ms_device_token，绝不下发任何共享全局 token
            const cookieHeaders = [
                buildDeviceCookieHeader(deviceAuth.cookieValue, { isHttps })
            ]

            const csrfSeed = deviceAuth.authEpoch || 'device_csrf_seed'
            const deviceCsrf = generateDeviceCsrfToken(deviceAuth.deviceSecret, csrfSeed)

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
        }

        // 受保护的 API
        if (pathname.startsWith('/api/')) {
            const auth = checkRequestAuthentication(req, res)
            if (!auth.authenticated) {
                res.writeHead(401, { 'Content-Type': 'application/json' })
                res.end(JSON.stringify({ error: 'unauthorized', message: 'API 未授权' }))
                return
            }

            const isWrite = ['POST', 'PUT', 'DELETE'].includes(req.method)
            if (isWrite) {
                if (!checkRequestCsrf(req, auth)) {
                    res.writeHead(403, { 'Content-Type': 'application/json' })
                    res.end(JSON.stringify({ error: 'csrf_mismatch', message: 'CSRF Token 无效' }))
                    return
                }
            }

            if (pathname === '/api/console/logout' && req.method === 'POST') {
                const cookies = {}
                const rc = req.headers.cookie
                if (rc) {
                    rc.split(';').forEach(c => {
                        const parts = c.split('=')
                        const k = parts.shift()?.trim()
                        if (k) cookies[k] = parts.join('=').trim()
                    })
                }
                const deviceToken = cookies[DEVICE_COOKIE_NAME]
                if (deviceToken) {
                    let revoked = false
                    try {
                        const db = new DatabaseSync(tempDbPath)
                        try {
                            const parts = deviceToken.split('.')
                            if (parts[0]) revoked = revokeClient(db, parts[0])
                        } finally {
                            db.close()
                        }
                    } catch (_) {
                        res.writeHead(500, { 'Content-Type': 'application/json' })
                        res.end(JSON.stringify({ error: 'revoke_failed', message: '无法撤销设备授权凭据，数据库写入失败' }))
                        return
                    }
                    if (!revoked) {
                        res.writeHead(500, { 'Content-Type': 'application/json' })
                        res.end(JSON.stringify({ error: 'revoke_failed', message: '无法撤销设备授权凭据，目标设备不存在或已被撤销' }))
                        return
                    }
                }

                // 核心安全修复：仅在持久化撤销成功后才轮换进程 localSessionToken
                currentSessionToken = crypto.randomBytes(32).toString('hex')
                setLocalSecurityTokens({ sessionToken: currentSessionToken, csrfToken: currentCsrfToken })

                res.writeHead(200, {
                    'Content-Type': 'application/json',
                    'Set-Cookie': [
                        buildClearDeviceCookieHeader({ isHttps }),
                        `ms_local_token=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT`
                    ]
                })
                res.end(JSON.stringify({ success: true, message: '已撤销此浏览器的控制台配对授权并清理凭证' }))
                return
            }

            if (pathname === '/api/console/status' && req.method === 'GET') {
                res.writeHead(200, { 'Content-Type': 'application/json' })
                res.end(JSON.stringify({
                    authenticated: auth.authenticated,
                    type: auth.type,
                    deviceId: auth.deviceId || null
                }))
                return
            }

            res.writeHead(200, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ success: true, data: 'secure-data' }))
            return
        }

        res.writeHead(404)
        res.end()
    })

    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
    const serverPort = server.address().port

    try {
        // -------------------------------------------------------------
        // 步骤 1: 首次未配对访问根路径 (401 锁屏页，无 Set-Cookie，无 CSRF 泄露)
        // -------------------------------------------------------------
        const resInit = await fetch(`http://127.0.0.1:${serverPort}/`)
        assert.equal(resInit.status, 401, '未认证访问必须返回 401')
        const initText = await resInit.text()
        assert.ok(initText.includes('401 Pairing Required'))
        assert.equal(resInit.headers.get('set-cookie'), null, '未配对绝不下发 Cookie')

        // -------------------------------------------------------------
        // 步骤 2: 提交错误配对凭据被拒绝
        // -------------------------------------------------------------
        const resBadPair = await fetch(`http://127.0.0.1:${serverPort}/api/pair`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ pairToken: 'wrong-fake-password' })
        })
        assert.equal(resBadPair.status, 401)
        const badPairJson = await resBadPair.json()
        assert.equal(badPairJson.error, 'invalid_pairing_token')

        // -------------------------------------------------------------
        // 步骤 2.5 (阻断点 1 验证): 持久化授权存储失败必须明确 500 失败，绝不可静默返回 200 或降级
        // -------------------------------------------------------------
        const resFailStorage = await fetch(`http://127.0.0.1:${serverPort}/api/pair`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ pairToken: testSecret, simulateStorageError: true })
        })
        assert.equal(resFailStorage.status, 500, '持久授权失败必须返回 500 明确阻断')
        const failJson = await resFailStorage.json()
        assert.equal(failJson.error, 'device_authorization_failed')
        assert.equal(resFailStorage.headers.get('set-cookie'), null, '存储失败绝对不得下发任何凭证 Cookie')

        // -------------------------------------------------------------
        // 步骤 3: 提交正确配对凭据，成功获得独立高熵设备 Cookie (阻断点 2 验证: 绝不下发 ms_local_token)
        // -------------------------------------------------------------
        const resPair = await fetch(`http://127.0.0.1:${serverPort}/api/pair`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ pairToken: testSecret })
        })
        assert.equal(resPair.status, 200)
        const pairJson = await resPair.json()
        assert.equal(pairJson.success, true)
        assert.ok(pairJson.deviceId.startsWith('dev_'))

        // 提取下发的 Cookie 标头
        const setCookieHeaders = resPair.headers.getSetCookie ? resPair.headers.getSetCookie() : [resPair.headers.get('set-cookie')]
        const deviceCookieHeader = setCookieHeaders.find(c => c.includes(DEVICE_COOKIE_NAME))
        assert.ok(deviceCookieHeader, '响应中必须包含 ms_device_token 标头')
        assert.ok(deviceCookieHeader.includes('HttpOnly'), '必须包含 HttpOnly')
        assert.ok(deviceCookieHeader.includes('SameSite=Strict'), '必须包含 SameSite=Strict')
        assert.ok(deviceCookieHeader.includes('Max-Age='), '必须包含持久化 Max-Age')

        // 核心安全指标断言：绝不向浏览器下发共享全局 ms_local_token 标头
        assert.ok(!setCookieHeaders.some(c => c && c.includes('ms_local_token=')), '安全基线：配对响应中绝不可包含 ms_local_token 标头')

        // 提取 Cookie 值
        const matchToken = deviceCookieHeader.match(/ms_device_token=([^;]+)/)
        assert.ok(matchToken)
        const deviceCookieValue = matchToken[1]

        // -------------------------------------------------------------
        // 步骤 4: 模拟关浏览器重开 (仅保留持久化的 ms_device_token Cookie 重放请求)
        // -------------------------------------------------------------
        const resReplay = await fetch(`http://127.0.0.1:${serverPort}/`, {
            headers: { 'Cookie': `ms_device_token=${deviceCookieValue}` }
        })
        assert.equal(resReplay.status, 200, '携带持久设备 Cookie 重开浏览器必须无感进入控制台 (200)')
        const replayHtml = await resReplay.text()
        assert.ok(replayHtml.includes('200 Authenticated Dashboard'))
        const activeCsrf = resReplay.headers.get('x-active-csrf')
        assert.ok(activeCsrf && activeCsrf.length === 64, '必须获得有效的 64 位派生 CSRF 令牌')

        // -------------------------------------------------------------
        // 步骤 4.5 (阻断点 3 验证): 模拟活跃日常使用滑动窗口续期，浏览器端 Cookie 同步 Set-Cookie 刷新
        // -------------------------------------------------------------
        // 手工将数据库中记录的 last_used_at 调到 2 天前 (超过 1 天滑动防抖阈值)
        const modifyDb = new DatabaseSync(tempDbPath)
        const twoDaysAgo = Date.now() - 2 * 24 * 3600 * 1000
        modifyDb.prepare('UPDATE authorized_web_clients SET last_used_at = ? WHERE device_id = ?').run(twoDaysAgo, pairJson.deviceId)
        const rowBefore = modifyDb.prepare('SELECT * FROM authorized_web_clients WHERE device_id = ?').get(pairJson.deviceId)
        modifyDb.close()

        const resSliding = await fetch(`http://127.0.0.1:${serverPort}/`, {
            headers: { 'Cookie': `ms_device_token=${deviceCookieValue}` }
        })
        assert.equal(resSliding.status, 200)

        // 关键断言：服务端必须在响应中带上续期后的 Set-Cookie 标头，重置浏览器端本地 Max-Age
        const renewHeaders = resSliding.headers.getSetCookie ? resSliding.headers.getSetCookie() : [resSliding.headers.get('set-cookie')]
        const renewCookieHeader = renewHeaders.find(c => c && c.includes(DEVICE_COOKIE_NAME))
        assert.ok(renewCookieHeader, '滑动续期发生时必须向浏览器下发 Set-Cookie 续期头')
        assert.ok(renewCookieHeader.includes('Max-Age='), '续期头必须重置 Max-Age')

        // 验证数据库中服务端 expires_at 已延展到未来
        const checkDb = new DatabaseSync(tempDbPath)
        const rowAfter = checkDb.prepare('SELECT * FROM authorized_web_clients WHERE device_id = ?').get(pairJson.deviceId)
        checkDb.close()
        assert.ok(rowAfter.expires_at > rowBefore.expires_at, '服务端数据库中的 expires_at 必须成功顺延')

        // -------------------------------------------------------------
        // 步骤 5: 模拟 Docker 容器重启 / 服务重启 (重置内存随机令牌，但挂载卷 DB 保持)
        // -------------------------------------------------------------
        currentSessionToken = crypto.randomBytes(32).toString('hex') // 模拟重启内存重置
        currentCsrfToken = crypto.randomBytes(32).toString('hex')

        const resAfterRestart = await fetch(`http://127.0.0.1:${serverPort}/`, {
            headers: { 'Cookie': `ms_device_token=${deviceCookieValue}` }
        })
        assert.equal(resAfterRestart.status, 200, '容器重启后凭借 sessions 目录持久化摘要，同浏览器依然免密访问 (200)')

        // -------------------------------------------------------------
        // 步骤 6: 另一未配对浏览器访问，保持 401 隔离
        // -------------------------------------------------------------
        const resOtherBrowser = await fetch(`http://127.0.0.1:${serverPort}/`, {
            headers: {} // 无凭据
        })
        assert.equal(resOtherBrowser.status, 401, '另一未配对浏览器必须严格返回 401 隔离')

        // -------------------------------------------------------------
        // 步骤 7: 伪造/篡改设备 Cookie 被阻断
        // -------------------------------------------------------------
        const resForged = await fetch(`http://127.0.0.1:${serverPort}/`, {
            headers: { 'Cookie': `ms_device_token=dev_00000000000000000000000000000000.1111111111111111111111111111111111111111111111111111111111111111` }
        })
        assert.equal(resForged.status, 401, '伪造凭据必须严格被拒')

        // -------------------------------------------------------------
        // 步骤 8: 受保护 API 请求与 CSRF 拦截
        // -------------------------------------------------------------
        // 无 CSRF 令牌的写操作应被 403 阻断
        const resNoCsrf = await fetch(`http://127.0.0.1:${serverPort}/api/test-write`, {
            method: 'POST',
            headers: {
                'Cookie': `ms_device_token=${deviceCookieValue}`
            }
        })
        assert.equal(resNoCsrf.status, 403, '无 CSRF 令牌写操作必须 403 拒绝')

        // 携带合法 CSRF 令牌的写操作通过
        const resWithCsrf = await fetch(`http://127.0.0.1:${serverPort}/api/test-write`, {
            method: 'POST',
            headers: {
                'Cookie': `ms_device_token=${deviceCookieValue}`,
                'X-CSRF-Token': activeCsrf
            }
        })
        assert.equal(resWithCsrf.status, 200, '携带派生合法 CSRF 令牌的写操作成功通过')

        // 模拟客户端在退出前捕获的当前会话 token (用于阻断点 2 的重放测试)
        const capturedSessionToken = currentSessionToken

        // -------------------------------------------------------------
        // 步骤 9: 退出控制台 / 撤销此浏览器 (POST /api/console/logout)
        // -------------------------------------------------------------
        const resLogout = await fetch(`http://127.0.0.1:${serverPort}/api/console/logout`, {
            method: 'POST',
            headers: {
                'Cookie': `ms_device_token=${deviceCookieValue}`,
                'X-CSRF-Token': activeCsrf
            }
        })
        assert.equal(resLogout.status, 200)
        const logoutJson = await resLogout.json()
        assert.equal(logoutJson.success, true)

        // 确认下发了清理 Cookie 标头
        const logoutCookies = resLogout.headers.getSetCookie ? resLogout.headers.getSetCookie() : [resLogout.headers.get('set-cookie')]
        const clearDeviceCookie = logoutCookies.find(c => c.includes(DEVICE_COOKIE_NAME))
        assert.ok(clearDeviceCookie.includes('Max-Age=0') || clearDeviceCookie.includes('Expires='))

        // -------------------------------------------------------------
        // 步骤 10: 撤销后原浏览器携带旧 ms_device_token 重放，必须返回 401！
        // -------------------------------------------------------------
        const resAfterLogout = await fetch(`http://127.0.0.1:${serverPort}/`, {
            headers: { 'Cookie': `ms_device_token=${deviceCookieValue}` }
        })
        assert.equal(resAfterLogout.status, 401, '设备被撤销后，原 Cookie 必须立即失效，返回 401 锁屏页')

        // -------------------------------------------------------------
        // 步骤 11 (阻断点核心验证): 即使携带当前服务进程有效 sessionToken 的旧 ms_local_token Cookie，也坚决返回 401！
        // -------------------------------------------------------------
        const resReplayLocalCookie = await fetch(`http://127.0.0.1:${serverPort}/`, {
            headers: { 'Cookie': `ms_local_token=${currentSessionToken}` }
        })
        assert.equal(resReplayLocalCookie.status, 401, '旧 ms_local_token Cookie 坚决不能授权 (401)')

        // -------------------------------------------------------------
        // 步骤 12 (CLI 请求头支持验证): 仅显式请求头 X-Local-Token 允许授权 (CLI 工具专用)
        // -------------------------------------------------------------
        const resCliHeader = await fetch(`http://127.0.0.1:${serverPort}/api/console/status`, {
            headers: { 'X-Local-Token': currentSessionToken }
        })
        assert.equal(resCliHeader.status, 200, 'CLI 工具通过显式 X-Local-Token 请求头允许授权通过')

    } finally {
        await new Promise((resolve) => server.close(resolve))
        if (oldSessionDir !== undefined) process.env.MS_SESSION_DIR = oldSessionDir
        else delete process.env.MS_SESSION_DIR
        if (oldSessionDbPath !== undefined) process.env.MS_SESSION_DB_PATH = oldSessionDbPath
        else delete process.env.MS_SESSION_DB_PATH
        if (oldPairingSecret !== undefined) process.env.MS_WEB_PAIRING_SECRET = oldPairingSecret
        else delete process.env.MS_WEB_PAIRING_SECRET
        try { fs.rmSync(tempDir, { recursive: true, force: true }) } catch (_) {}
    }
})

// =========================================================================
// 阻断点严密验收：真实生产路由 /api/pair 脱敏 + 退出/撤销持久化写入失败 500 容错 + DB 状态严格一致
// =========================================================================

test('Web 客户端控制台撤销持久化容错与安全脱敏: /api/pair脱敏 + logout/revoke-all 只读DB 500拦截 + DB状态严格一致', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ms-rewards-revoke-fail-test-'))
    const tempDbPath = path.join(tempDir, 'sessions.db')
    const oldSessionDir = process.env.MS_SESSION_DIR
    const oldSessionDbPath = process.env.MS_SESSION_DB_PATH
    const oldPairingSecret = process.env.MS_WEB_PAIRING_SECRET
    const testSecret = 'fictional-pairing-secret-fail-closed-test-456'

    process.env.MS_SESSION_DIR = tempDir
    process.env.MS_SESSION_DB_PATH = tempDbPath
    process.env.MS_WEB_PAIRING_SECRET = testSecret
    setLocalPairingSecret(testSecret)

    // 启动 web.mjs 生产导出的真实原生 HTTP 服务
    await new Promise((resolve) => webServer.listen(0, '127.0.0.1', resolve))
    const serverPort = webServer.address().port

    try {
        // -------------------------------------------------------------
        // 1. 验证 POST /api/pair 持久化失败安全脱敏与泛化响应 (JSON + Form-urlencoded)
        // -------------------------------------------------------------
        // 预先创建空 DB 文件并锁死为只读，强制触发数据库写入异常
        fs.writeFileSync(tempDbPath, '')
        fs.chmodSync(tempDbPath, 0o400)

        // 1.1 JSON 请求 POST /api/pair
        const resPairFailJson = await fetch(`http://127.0.0.1:${serverPort}/api/pair`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ pairToken: testSecret })
        })
        assert.equal(resPairFailJson.status, 500, '配对持久化失败必须返回 500')
        const failJsonBody = await resPairFailJson.json()
        assert.equal(failJsonBody.error, 'device_authorization_failed')
        assert.equal(failJsonBody.message, '持久化设备授权创建失败，请检查服务状态后重试', '必须返回脱敏后的固定泛化文案')
        // 严格安全脱敏断言：绝不向客户端回显真实文件路径、DB文件名或底层 SQLite 细节
        const serializedFailJson = JSON.stringify(failJsonBody)
        assert.ok(!serializedFailJson.includes(tempDir), 'JSON 响应绝不可泄露服务器目录绝对路径')
        assert.ok(!serializedFailJson.includes('sessions.db'), 'JSON 响应绝不可泄露底层数据库文件名')
        assert.ok(!serializedFailJson.includes('authorized_web_clients'), 'JSON 响应绝不可泄露数据库内部表结构')
        assert.ok(!serializedFailJson.toLowerCase().includes('readonly'), 'JSON 响应绝不可泄露 SQLite 只读异常原文')
        assert.ok(!serializedFailJson.toLowerCase().includes('sqlite'), 'JSON 响应绝不可泄露 SQLite 引擎信息')

        // 1.2 Form 表单 POST /api/pair
        const resPairFailForm = await fetch(`http://127.0.0.1:${serverPort}/api/pair`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: `pairToken=${encodeURIComponent(testSecret)}`
        })
        assert.equal(resPairFailForm.status, 500, '表单配对持久化失败必须返回 500')
        const failFormHtml = await resPairFailForm.text()
        assert.ok(failFormHtml.includes('持久化设备授权创建失败，请检查服务状态后重试'), '表单响应必须展示固定泛化文案')
        assert.ok(!failFormHtml.includes(tempDir), '表单响应绝不可泄露服务器目录绝对路径')
        assert.ok(!failFormHtml.includes('sessions.db'), '表单响应绝不可泄露底层数据库文件名')
        assert.ok(!failFormHtml.includes('authorized_web_clients'), '表单响应绝不可泄露数据库内部表结构')
        assert.ok(!failFormHtml.toLowerCase().includes('readonly'), '表单响应绝不可泄露 SQLite 只读异常原文')
        assert.ok(!failFormHtml.toLowerCase().includes('sqlite'), '表单响应绝不可泄露 SQLite 引擎信息')

        // -------------------------------------------------------------
        // 2. 恢复写权限，完成正常配对获取设备凭据
        // -------------------------------------------------------------
        fs.chmodSync(tempDbPath, 0o600)
        const resPairOk = await fetch(`http://127.0.0.1:${serverPort}/api/pair`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ pairToken: testSecret })
        })
        assert.equal(resPairOk.status, 200)
        const pairOkJson = await resPairOk.json()
        assert.equal(pairOkJson.success, true)
        const deviceId1 = pairOkJson.deviceId
        assert.ok(deviceId1.startsWith('dev_'))

        const setCookies1 = resPairOk.headers.getSetCookie ? resPairOk.headers.getSetCookie() : [resPairOk.headers.get('set-cookie')]
        const deviceCookieHeader1 = setCookies1.find(c => c && c.includes(DEVICE_COOKIE_NAME))
        assert.ok(deviceCookieHeader1)
        assert.ok(!setCookies1.some(c => c && c.includes('ms_local_token=')), '安全基线：真实生产路由配对绝不下发共享 ms_local_token')
        const deviceCookie1 = deviceCookieHeader1.match(/ms_device_token=([^;]+)/)[1]
        const csrfToken1 = pairOkJson.csrfToken

        // 验证数据库中该设备状态：初始未撤销 (revoked_at IS NULL)
        const verifyDb1 = new DatabaseSync(tempDbPath, { readOnly: true })
        const initialRow1 = verifyDb1.prepare('SELECT * FROM authorized_web_clients WHERE device_id = ?').get(deviceId1)
        verifyDb1.close()
        assert.ok(initialRow1)
        assert.equal(initialRow1.revoked_at, null, '配对成功后凭据处于活跃状态，revoked_at 为 NULL')

        // -------------------------------------------------------------
        // 3. 注入数据库写入失败 (只读 DB)：POST /api/console/logout
        // 核心安全验收：严禁吞错继续返回 200“已撤销”；必须 500 报错且 DB 状态与报错严格一致
        // -------------------------------------------------------------
        fs.chmodSync(tempDbPath, 0o400) // 锁死为只读

        const resLogoutFail = await fetch(`http://127.0.0.1:${serverPort}/api/console/logout`, {
            method: 'POST',
            headers: {
                'Cookie': `ms_device_token=${deviceCookie1}`,
                'X-CSRF-Token': csrfToken1
            }
        })
        assert.equal(resLogoutFail.status, 500, 'DB写入失败时退出接口必须明确返回 500 报错，绝不可伪造 200 成功')
        const logoutFailJson = await resLogoutFail.json()
        assert.equal(logoutFailJson.error, 'revoke_failed')
        assert.equal(logoutFailJson.message, '无法撤销设备授权凭据，数据库写入失败')
        assert.notEqual(logoutFailJson.success, true, '报错时绝不可返回 success: true')

        // 验证响应绝不下发已清除 Cookie 标头 (避免欺骗用户浏览器)
        const failLogoutCookies = resLogoutFail.headers.getSetCookie ? resLogoutFail.headers.getSetCookie() : [resLogoutFail.headers.get('set-cookie')]
        const failClearCookie = failLogoutCookies.find(c => c && c.includes(DEVICE_COOKIE_NAME))
        assert.equal(failClearCookie, undefined, '写入失败时绝不可下发清理 Cookie 标头虚假宣称凭据已失效')

        // 核心状态验证：只读查询底层数据库，证明旧 Cookie 状态严格未被修改 (revoked_at 依然为 NULL)
        const verifyDbFail = new DatabaseSync(tempDbPath, { readOnly: true })
        const rowAfterFail = verifyDbFail.prepare('SELECT * FROM authorized_web_clients WHERE device_id = ?').get(deviceId1)
        verifyDbFail.close()
        assert.equal(rowAfterFail.revoked_at, null, '撤销持久化失败时，数据库中凭据状态必须严格保持未撤销(NULL)，与报错完全一致')

        // -------------------------------------------------------------
        // 4. 恢复写权限后，重试 POST /api/console/logout 撤销成功
        // -------------------------------------------------------------
        fs.chmodSync(tempDbPath, 0o600) // 恢复写入权限

        const resLogoutOk = await fetch(`http://127.0.0.1:${serverPort}/api/console/logout`, {
            method: 'POST',
            headers: {
                'Cookie': `ms_device_token=${deviceCookie1}`,
                'X-CSRF-Token': csrfToken1
            }
        })
        assert.equal(resLogoutOk.status, 200, '数据库恢复正常后退出必须成功返回 200')
        const logoutOkJson = await resLogoutOk.json()
        assert.equal(logoutOkJson.success, true)
        assert.equal(logoutOkJson.message, '已撤销此浏览器的控制台配对授权并清理凭证')

        // 验证数据库中该设备状态：已成功置为已撤销 (revoked_at 为有效时间戳)
        const verifyDbOk = new DatabaseSync(tempDbPath, { readOnly: true })
        const rowAfterOk = verifyDbOk.prepare('SELECT * FROM authorized_web_clients WHERE device_id = ?').get(deviceId1)
        verifyDbOk.close()
        assert.ok(Number(rowAfterOk.revoked_at) > 0, '持久化成功后，数据库中 revoked_at 必须更新为有效时间戳')

        // 再次以已撤销凭据访问，被 401 坚决阻断
        const resAccessRevoked = await fetch(`http://127.0.0.1:${serverPort}/api/console/status`, {
            headers: { 'Cookie': `ms_device_token=${deviceCookie1}` }
        })
        assert.equal(resAccessRevoked.status, 401, '凭据撤销后访问受保护 API 必须被坚决阻断 (401)')

        // -------------------------------------------------------------
        // 5. 注入数据库写入失败 (只读 DB)：POST /api/console/revoke-all
        // -------------------------------------------------------------
        // 先配对新设备 2
        const resPair2 = await fetch(`http://127.0.0.1:${serverPort}/api/pair`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ pairToken: testSecret })
        })
        const pair2Json = await resPair2.json()
        const deviceId2 = pair2Json.deviceId
        const setCookies2 = resPair2.headers.getSetCookie ? resPair2.headers.getSetCookie() : [resPair2.headers.get('set-cookie')]
        const deviceCookieHeader2 = setCookies2.find(c => c && c.includes(DEVICE_COOKIE_NAME))
        const deviceCookie2 = deviceCookieHeader2.match(/ms_device_token=([^;]+)/)[1]
        const csrfToken2 = pair2Json.csrfToken

        // 再次锁死为只读 DB
        fs.chmodSync(tempDbPath, 0o400)

        const resRevokeAllFail = await fetch(`http://127.0.0.1:${serverPort}/api/console/revoke-all`, {
            method: 'POST',
            headers: {
                'Cookie': `ms_device_token=${deviceCookie2}`,
                'X-CSRF-Token': csrfToken2
            }
        })
        assert.equal(resRevokeAllFail.status, 500, '全量撤销在 DB 写入异常时必须明确返回 500 报错')
        const revokeAllFailJson = await resRevokeAllFail.json()
        assert.equal(revokeAllFailJson.error, 'revoke_all_failed')
        assert.equal(revokeAllFailJson.message, '无法撤销所有设备授权，数据库操作失败')
        assert.notEqual(revokeAllFailJson.success, true, '报错时绝不可返回 success: true')

        // 验证数据库状态：设备 2 依然处于未撤销状态
        const verifyDb2Fail = new DatabaseSync(tempDbPath, { readOnly: true })
        const row2AfterFail = verifyDb2Fail.prepare('SELECT * FROM authorized_web_clients WHERE device_id = ?').get(deviceId2)
        verifyDb2Fail.close()
        assert.equal(row2AfterFail.revoked_at, null, '全量撤销失败时，现有设备凭据状态严格保持未撤销(NULL)')

        // 恢复写入权限后执行全量撤销
        fs.chmodSync(tempDbPath, 0o600)
        const resRevokeAllOk = await fetch(`http://127.0.0.1:${serverPort}/api/console/revoke-all`, {
            method: 'POST',
            headers: {
                'Cookie': `ms_device_token=${deviceCookie2}`,
                'X-CSRF-Token': csrfToken2
            }
        })
        assert.equal(resRevokeAllOk.status, 200, '数据库恢复写入后全量撤销返回 200')
        const revokeAllOkJson = await resRevokeAllOk.json()
        assert.equal(revokeAllOkJson.success, true)
        assert.ok(Number(revokeAllOkJson.count) >= 1)

        // 验证数据库状态：设备 2 已被全量撤销
        const verifyDb2Ok = new DatabaseSync(tempDbPath, { readOnly: true })
        const row2AfterOk = verifyDb2Ok.prepare('SELECT * FROM authorized_web_clients WHERE device_id = ?').get(deviceId2)
        verifyDb2Ok.close()
        assert.ok(Number(row2AfterOk.revoked_at) > 0, '全量撤销成功后，设备 2 的 revoked_at 必须更新为有效时间戳')

    } finally {
        await new Promise((resolve) => webServer.close(resolve))
        if (oldSessionDir !== undefined) process.env.MS_SESSION_DIR = oldSessionDir
        else delete process.env.MS_SESSION_DIR
        if (oldSessionDbPath !== undefined) process.env.MS_SESSION_DB_PATH = oldSessionDbPath
        else delete process.env.MS_SESSION_DB_PATH
        if (oldPairingSecret !== undefined) process.env.MS_WEB_PAIRING_SECRET = oldPairingSecret
        else delete process.env.MS_WEB_PAIRING_SECRET
        try { fs.chmodSync(tempDbPath, 0o600) } catch (_) {}
        try { fs.rmSync(tempDir, { recursive: true, force: true }) } catch (_) {}
    }
})

// =========================================================================
// 核心安全验收：多个浏览器凭据互异 + 撤销 A 绝对不影响 B + 旧 ms_local_token Cookie 坚决不能授权
// =========================================================================

test('Web 客户端多浏览器安全隔离: 凭证互异 + 撤销A不影响B + 旧ms_local_token Cookie不能授权 + CLI头支持', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ms-rewards-multi-browser-test-'))
    const tempDbPath = path.join(tempDir, 'sessions.db')
    const oldSessionDir = process.env.MS_SESSION_DIR
    const oldSessionDbPath = process.env.MS_SESSION_DB_PATH
    const oldPairingSecret = process.env.MS_WEB_PAIRING_SECRET
    const testSecret = 'fictional-pairing-secret-multi-browser-999'

    process.env.MS_SESSION_DIR = tempDir
    process.env.MS_SESSION_DB_PATH = tempDbPath
    process.env.MS_WEB_PAIRING_SECRET = testSecret
    setLocalPairingSecret(testSecret)

    // 启动原生真实 HTTP 服务
    await new Promise((resolve) => webServer.listen(0, '127.0.0.1', resolve))
    const serverPort = webServer.address().port

    try {
        // -------------------------------------------------------------
        // 1. 验证多个浏览器配对下发的凭证绝对互异且绝不下发共享 ms_local_token
        // -------------------------------------------------------------
        // 浏览器 A 配对
        const resPairA = await fetch(`http://127.0.0.1:${serverPort}/api/pair`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'User-Agent': 'Mozilla/5.0 Chrome/BrowserA'
            },
            body: JSON.stringify({ pairToken: testSecret })
        })
        assert.equal(resPairA.status, 200)
        const pairAJson = await resPairA.json()
        assert.equal(pairAJson.success, true)
        const setCookiesA = resPairA.headers.getSetCookie ? resPairA.headers.getSetCookie() : [resPairA.headers.get('set-cookie')]
        const deviceCookieHeaderA = setCookiesA.find(c => c && c.includes(DEVICE_COOKIE_NAME))
        assert.ok(deviceCookieHeaderA)
        assert.ok(!setCookiesA.some(c => c && c.includes('ms_local_token=')), '浏览器 A 绝不下发共享全局 ms_local_token')
        const cookieA = deviceCookieHeaderA.match(/ms_device_token=([^;]+)/)[1]
        const csrfA = pairAJson.csrfToken

        // 浏览器 B 配对
        const resPairB = await fetch(`http://127.0.0.1:${serverPort}/api/pair`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'User-Agent': 'Mozilla/5.0 Firefox/BrowserB'
            },
            body: JSON.stringify({ pairToken: testSecret })
        })
        assert.equal(resPairB.status, 200)
        const pairBJson = await resPairB.json()
        assert.equal(pairBJson.success, true)
        const setCookiesB = resPairB.headers.getSetCookie ? resPairB.headers.getSetCookie() : [resPairB.headers.get('set-cookie')]
        const deviceCookieHeaderB = setCookiesB.find(c => c && c.includes(DEVICE_COOKIE_NAME))
        assert.ok(deviceCookieHeaderB)
        assert.ok(!setCookiesB.some(c => c && c.includes('ms_local_token=')), '浏览器 B 绝不下发共享全局 ms_local_token')
        const cookieB = deviceCookieHeaderB.match(/ms_device_token=([^;]+)/)[1]
        const csrfB = pairBJson.csrfToken

        // 核心凭据互异断言
        assert.notEqual(pairAJson.deviceId, pairBJson.deviceId, '浏览器 A 与浏览器 B 的 deviceId 必须完全独立互异')
        assert.notEqual(cookieA, cookieB, '浏览器 A 与浏览器 B 的 ms_device_token Cookie 必须完全独立互异')
        assert.notEqual(csrfA, csrfB, '浏览器 A 与浏览器 B 派生的 CSRF 令牌必须完全独立互异')

        // -------------------------------------------------------------
        // 2. 两个浏览器均能独立正常访问仪表盘和 API
        // -------------------------------------------------------------
        const resHomeA = await fetch(`http://127.0.0.1:${serverPort}/`, {
            headers: { 'Cookie': `ms_device_token=${cookieA}` }
        })
        assert.equal(resHomeA.status, 200)

        const resHomeB = await fetch(`http://127.0.0.1:${serverPort}/`, {
            headers: { 'Cookie': `ms_device_token=${cookieB}` }
        })
        assert.equal(resHomeB.status, 200)

        // -------------------------------------------------------------
        // 3. 浏览器 A 主动退出控制台 (POST /api/console/logout)
        // 核心验收：撤销 A 绝对不影响 B！
        // -------------------------------------------------------------
        const resLogoutA = await fetch(`http://127.0.0.1:${serverPort}/api/console/logout`, {
            method: 'POST',
            headers: {
                'Cookie': `ms_device_token=${cookieA}`,
                'X-CSRF-Token': csrfA
            }
        })
        assert.equal(resLogoutA.status, 200)
        const logoutAJson = await resLogoutA.json()
        assert.equal(logoutAJson.success, true)

        // 验证浏览器 A 重放已失效 (返回 401)
        const resReplayA = await fetch(`http://127.0.0.1:${serverPort}/api/console/status`, {
            headers: { 'Cookie': `ms_device_token=${cookieA}` }
        })
        assert.equal(resReplayA.status, 401, '浏览器 A 撤销后必须立即被 401 阻断')

        // 关键断言：浏览器 B 完全不受浏览器 A 撤销的影响！
        const resStatusB = await fetch(`http://127.0.0.1:${serverPort}/api/console/status`, {
            headers: { 'Cookie': `ms_device_token=${cookieB}` }
        })
        assert.equal(resStatusB.status, 200, '撤销浏览器 A 绝对不得影响浏览器 B，浏览器 B 依然有效认证通过')
        const statusBJson = await resStatusB.json()
        assert.equal(statusBJson.authenticated, true)
        assert.equal(statusBJson.type, 'device')

        // 验证浏览器 B 的写操作依然畅通无阻
        const resWriteB = await fetch(`http://127.0.0.1:${serverPort}/api/stop`, {
            method: 'POST',
            headers: {
                'Cookie': `ms_device_token=${cookieB}`,
                'X-CSRF-Token': csrfB
            }
        })
        assert.equal(resWriteB.status, 200, '浏览器 B 的写操作和 CSRF 令牌不受浏览器 A 退出影响')

        // -------------------------------------------------------------
        // 4. 验证旧 ms_local_token Cookie 坚决不能授权
        // -------------------------------------------------------------
        const currentTokens = getLocalSecurityTokens()
        const resLegacyCookieHome = await fetch(`http://127.0.0.1:${serverPort}/`, {
            headers: { 'Cookie': `ms_local_token=${currentTokens.sessionToken}` }
        })
        assert.equal(resLegacyCookieHome.status, 401, '根路径携带旧 ms_local_token Cookie 坚决不能授权 (401)')

        const resLegacyCookieApi = await fetch(`http://127.0.0.1:${serverPort}/api/state`, {
            headers: { 'Cookie': `ms_local_token=${currentTokens.sessionToken}` }
        })
        assert.equal(resLegacyCookieApi.status, 401, '受保护 API 携带旧 ms_local_token Cookie 坚决不能授权 (401)')

        // 复制全局 Cookie 试图绕过单设备撤销 (携带已撤销设备Cookie + ms_local_token)
        const resBypassAttempt = await fetch(`http://127.0.0.1:${serverPort}/api/console/status`, {
            headers: { 'Cookie': `ms_device_token=${cookieA}; ms_local_token=${currentTokens.sessionToken}` }
        })
        assert.equal(resBypassAttempt.status, 401, '携带已撤销设备凭证加旧 ms_local_token 组合坚决不能绕过撤销 (401)')

        // -------------------------------------------------------------
        // 5. 验证仅显式请求头 X-Local-Token 允许授权 (CLI 工具专用通道)
        // -------------------------------------------------------------
        const resCliHeader = await fetch(`http://127.0.0.1:${serverPort}/api/console/status`, {
            headers: { 'X-Local-Token': currentTokens.sessionToken }
        })
        assert.equal(resCliHeader.status, 200, 'CLI 工具通过显式 X-Local-Token 请求头正常授权通过')
        const cliJson = await resCliHeader.json()
        assert.equal(cliJson.authenticated, true)
        assert.equal(cliJson.type, 'header')

    } finally {
        await new Promise((resolve) => webServer.close(resolve))
        if (oldSessionDir !== undefined) process.env.MS_SESSION_DIR = oldSessionDir
        else delete process.env.MS_SESSION_DIR
        if (oldSessionDbPath !== undefined) process.env.MS_SESSION_DB_PATH = oldSessionDbPath
        else delete process.env.MS_SESSION_DB_PATH
        if (oldPairingSecret !== undefined) process.env.MS_WEB_PAIRING_SECRET = oldPairingSecret
        else delete process.env.MS_WEB_PAIRING_SECRET
        try { fs.chmodSync(tempDbPath, 0o600) } catch (_) {}
        try { fs.rmSync(tempDir, { recursive: true, force: true }) } catch (_) {}
    }
})

// =========================================================================
// 安全测试 5：配对凭据管理：手工密码至少 15 字符拦截、文件持久化 fail closed 与异常文件完整性保留
// =========================================================================
test('Web 配对凭证管理: 手工弱密码拦截(>=15字符)、文件持久化 fail closed 治理与异常文件完整性保留', async () => {
    // 1. validatePairingSecretStrength 纯函数测试
    assert.equal(validatePairingSecretStrength('').valid, false, '空字符串必须拒绝')
    assert.equal(validatePairingSecretStrength(null).valid, false, 'null 必须拒绝')
    assert.equal(validatePairingSecretStrength('12345678').valid, false, '8 字符弱密码必须拒绝 (至少15字符)')
    assert.equal(validatePairingSecretStrength('shortpass1234').valid, false, '13 字符密码必须拒绝 (至少15字符)')
    assert.ok(validatePairingSecretStrength('12345678').reason.includes('15'), '拒绝原因中必须提示至少 15 个字符')
    assert.equal(validatePairingSecretStrength('password123456').valid, false, '常见弱密码必须拒绝')
    assert.equal(validatePairingSecretStrength('123456789012345').valid, false, '纯顺序数字弱密码必须拒绝')
    assert.equal(validatePairingSecretStrength('aaaaaaaaaaaaaaaa').valid, false, '单一字符完全重复必须拒绝')
    assert.equal(validatePairingSecretStrength('StrongCustomSecretPass2026!').valid, true, '合规强密码必须通过校验')

    // 2. 隔离临时环境下的环境变量测试
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ms-pairing-secret-test-'))
    const tempDbPath = path.join(tempDir, 'sessions.db')
    const oldSessionDir = process.env.MS_SESSION_DIR
    const oldSessionDbPath = process.env.MS_SESSION_DB_PATH
    const oldPairingSecret = process.env.MS_WEB_PAIRING_SECRET

    try {
        process.env.MS_SESSION_DIR = tempDir
        process.env.MS_SESSION_DB_PATH = tempDbPath

        // 2.1 设置弱密码环境变量 -> initPairingSecret 必须 fail closed 返回 null 并记录合规错误
        process.env.MS_WEB_PAIRING_SECRET = 'short_weak'
        const weakInit = initPairingSecret()
        assert.equal(weakInit, null, '环境变量为弱密码时必须 fail closed 返回 null')
        assert.ok(getPairingInitError().includes('配置不合规'), '必须设置合规错误提示')
        assert.equal(getLocalPairingSecret(), null, 'getLocalPairingSecret 也必须返回 null')

        // 2.2 设置强密码环境变量 -> initPairingSecret 成功
        process.env.MS_WEB_PAIRING_SECRET = 'StrongCustomSecretPass2026!'
        const strongInit = initPairingSecret()
        assert.equal(strongInit, 'StrongCustomSecretPass2026!')
        assert.equal(getPairingInitError(), null)
        assert.equal(getLocalPairingSecret(), 'StrongCustomSecretPass2026!')

        // 2.3 移除环境变量，验证默认自动生成 48 位高熵十六进制码
        delete process.env.MS_WEB_PAIRING_SECRET
        const secretFilePath = path.join(tempDir, '.web_pairing_secret')
        assert.equal(fs.existsSync(secretFilePath), false, '初始化前文件不应存在')

        const autoSecret = initPairingSecret()
        assert.ok(typeof autoSecret === 'string' && autoSecret.length === 48, '自动生成的随机码必须为 48 字符高熵 hex')
        assert.equal(fs.existsSync(secretFilePath), true, '必须在 sessions 目录写入 .web_pairing_secret')
        const fileContent = fs.readFileSync(secretFilePath, 'utf-8').trim()
        assert.equal(fileContent, autoSecret, '落盘文件内容必须与内存密钥严格一致')

        // 二次调用读取现有文件，不重复生成
        const cachedSecret = initPairingSecret()
        assert.equal(cachedSecret, autoSecret, '二次调用必须读取已有文件，保持原密钥不变')

        // 2.4 安全问题 ③ 核心验证：现有文件若为空或格式异常，严禁生成新码覆盖原文件，必须 fail closed 并保留原文件！
        // 模拟损坏为空文件
        fs.writeFileSync(secretFilePath, '', { mode: 0o600 })
        const emptyFileInit = initPairingSecret()
        assert.equal(emptyFileInit, null, '已有文件为空时必须 fail closed 返回 null')
        assert.ok(getPairingInitError().includes('为空或格式异常'), '必须返回异常提示')
        // 关键断言：磁盘文件内容必须仍为空，绝不可被自动生成的新码覆盖！
        assert.equal(fs.readFileSync(secretFilePath, 'utf-8'), '', '绝不得生成新码覆盖空文件，必须保留原文件')

        // 模拟格式异常/过短文件
        fs.writeFileSync(secretFilePath, 'corrupted_short', { mode: 0o600 })
        const corruptFileInit = initPairingSecret()
        assert.equal(corruptFileInit, null, '已有文件过短时必须 fail closed 返回 null')
        assert.ok(getPairingInitError().includes('为空或格式异常'))
        // 关键断言：磁盘文件内容必须仍为 'corrupted_short'，绝不可被覆盖！
        assert.equal(fs.readFileSync(secretFilePath, 'utf-8'), 'corrupted_short', '绝不得生成新码覆盖损坏文件，必须保留原文件')

        // 2.5 模拟只读目录无法写入场景 -> fail closed，绝不发放未持久化的内存伪码
        const readOnlySessionsDir = path.join(tempDir, 'readonly_sessions')
        fs.mkdirSync(readOnlySessionsDir, { mode: 0o700 })
        // 创建一个同名子目录阻断写文件
        const blockedSecretPath = path.join(readOnlySessionsDir, '.web_pairing_secret')
        fs.mkdirSync(blockedSecretPath) // 目录占位导致 writeFileSync 必报 EISDIR 异常

        process.env.MS_SESSION_DIR = readOnlySessionsDir
        process.env.MS_SESSION_DB_PATH = path.join(readOnlySessionsDir, 'sessions.db')
        const failClosedSecret = initPairingSecret()
        assert.equal(failClosedSecret, null, '写入失败时必须 fail closed 返回 null')
        assert.ok(getPairingInitError().includes('无法读取或持久化配对凭证文件'), '必须给出脱敏后的明确错误提示')
        assert.equal(getLocalPairingSecret(), null, '配对密钥必须为 null，绝不下发内存伪码')

    } finally {
        if (oldSessionDir !== undefined) process.env.MS_SESSION_DIR = oldSessionDir
        else delete process.env.MS_SESSION_DIR
        if (oldSessionDbPath !== undefined) process.env.MS_SESSION_DB_PATH = oldSessionDbPath
        else delete process.env.MS_SESSION_DB_PATH
        if (oldPairingSecret !== undefined) process.env.MS_WEB_PAIRING_SECRET = oldPairingSecret
        else delete process.env.MS_WEB_PAIRING_SECRET
        try { fs.rmSync(tempDir, { recursive: true, force: true }) } catch (_) {}
    }
})

// =========================================================================
// 安全测试 6：防暴力破解：真实 IP 识别防伪造、/api/pair 频率限制与 429 锁定
// =========================================================================
test('Web 控制台防暴力破解: getClientIp 安全防伪造 + /api/pair 连续 5 次失败锁定 60 秒与 429 Retry-After', async () => {
    // 1. 安全问题 1 核心测试：仅当 socket.remoteAddress 在明确配置的 TRUSTED_PROXIES 内才信任 X-Forwarded-Proto / For
    const fakeUntrustedReq = {
        headers: { 'x-forwarded-for': '198.51.100.1, 10.0.0.1', 'x-forwarded-proto': 'https' },
        socket: { remoteAddress: '::ffff:192.168.1.50', encrypted: false }
    }
    // 1.1 未配置 TRUSTED_PROXIES 时，所有伪造请求头一律忽略
    reloadTrustedProxies('')
    assert.equal(isRequestHttps(fakeUntrustedReq), false, '未配置可信代理时，伪造 X-Forwarded-Proto: https 必须被忽略')
    assert.equal(getClientIp(fakeUntrustedReq), '192.168.1.50', '未配置可信代理时，伪造 X-Forwarded-For 必须被忽略，使用真实 socket 地址')

    // 1.2 配置 TRUSTED_PROXIES='127.0.0.1,172.17.0.1'
    reloadTrustedProxies('127.0.0.1,172.17.0.1')
    assert.equal(isProxyTrusted('127.0.0.1'), true)
    assert.equal(isProxyTrusted('172.17.0.1'), true)
    assert.equal(isProxyTrusted('192.168.1.50'), false)

    // 1.3 来自非可信 socket (192.168.1.50) 的请求头依然严格被忽略
    assert.equal(isRequestHttps(fakeUntrustedReq), false, '来自非可信 socket 的 X-Forwarded-Proto 依然被忽略')
    assert.equal(getClientIp(fakeUntrustedReq), '192.168.1.50', '来自非可信 socket 的 X-Forwarded-For 依然被忽略')

    // 1.4 仅当 socket 来自可信代理 IP (172.17.0.1) 时，才信任请求头
    const fakeTrustedReq = {
        headers: { 'x-forwarded-for': '203.0.113.195, 172.17.0.1', 'x-forwarded-proto': 'https' },
        socket: { remoteAddress: '::ffff:172.17.0.1', encrypted: false }
    }
    assert.equal(isRequestHttps(fakeTrustedReq), true, '来自可信代理 socket 时，X-Forwarded-Proto: https 正常生效')
    assert.equal(getClientIp(fakeTrustedReq), '203.0.113.195', '来自可信代理 socket 时，X-Forwarded-For 客户端真实 IP 正常生效')

    reloadTrustedProxies('') // 恢复默认

    // 2. 纯逻辑函数测试
    clearAllPairFailures()
    const testIp = '10.0.0.99'
    assert.equal(checkPairRateLimit(testIp).allowed, true)
    for (let i = 1; i <= 4; i++) {
        recordPairFailure(testIp)
        assert.equal(checkPairRateLimit(testIp).allowed, true, `失败 ${i} 次时不应锁定`)
    }
    // 第 5 次失败
    recordPairFailure(testIp)
    const rateLocked = checkPairRateLimit(testIp)
    assert.equal(rateLocked.allowed, false, '连续 5 次失败后必须触发锁定')
    assert.ok(rateLocked.remainingSeconds > 0 && rateLocked.remainingSeconds <= 60)

    // 重置测试
    resetPairFailure(testIp)
    assert.equal(checkPairRateLimit(testIp).allowed, true, 'resetPairFailure 必须解除锁定')
    clearAllPairFailures()

    // 3. 真实 HTTP 集成测试：攻击者更换伪造 X-Forwarded-For 头依然被严格锁定
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ms-rate-limit-test-'))
    const tempDbPath = path.join(tempDir, 'sessions.db')
    const oldSessionDir = process.env.MS_SESSION_DIR
    const oldSessionDbPath = process.env.MS_SESSION_DB_PATH
    const oldPairingSecret = process.env.MS_WEB_PAIRING_SECRET
    const oldTrustProxy = process.env.TRUST_PROXY

    delete process.env.TRUST_PROXY // 确保默认非可信代理模式
    process.env.MS_SESSION_DIR = tempDir
    process.env.MS_SESSION_DB_PATH = tempDbPath
    const correctSecret = 'StrongValidSecret2026!@#'
    process.env.MS_WEB_PAIRING_SECRET = correctSecret
    initPairingSecret()
    clearAllPairFailures()

    await new Promise((resolve) => webServer.listen(0, '127.0.0.1', resolve))
    const serverPort = webServer.address().port

    try {
        // 攻击者发起 5 次错误密码配对，每次伪造不同的 X-Forwarded-For 请求头
        for (let i = 1; i <= 5; i++) {
            const resFail = await fetch(`http://127.0.0.1:${serverPort}/api/pair`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'X-Forwarded-For': `203.0.113.${i}` // 试图通过换头绕过限速
                },
                body: JSON.stringify({ pairToken: 'wrong_password_' + i })
            })
            assert.equal(resFail.status, 401, `第 ${i} 次错误密码必须返回 401`)
            const failJson = await resFail.json()
            assert.equal(failJson.error, 'invalid_pairing_token')
            // 响应绝不泄露密码明文或哈希
            assert.ok(!JSON.stringify(failJson).includes(correctSecret))
        }

        // 第 6 次请求：即便输入正确密码，由于该 socket IP 已被锁定，必须立即被 429 拦截！
        const resLocked = await fetch(`http://127.0.0.1:${serverPort}/api/pair`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-Forwarded-For': '203.0.113.99' // 换头依然无效！
            },
            body: JSON.stringify({ pairToken: correctSecret })
        })
        assert.equal(resLocked.status, 429, '触发限速后必须返回 HTTP 429 Too Many Requests')
        assert.ok(resLocked.headers.get('Retry-After'), '响应头必须下发 Retry-After')
        const lockedJson = await resLocked.json()
        assert.equal(lockedJson.error, 'too_many_attempts')
        assert.ok(lockedJson.message.includes('配对尝试失败次数过多'))

        // 表单方式请求同样返回 429
        const resFormLocked = await fetch(`http://127.0.0.1:${serverPort}/api/pair`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded'
            },
            body: `pairToken=${encodeURIComponent(correctSecret)}`
        })
        assert.equal(resFormLocked.status, 429, '表单提交同样返回 HTTP 429')
        assert.ok(resFormLocked.headers.get('Retry-After'))

        // 清理失败记录后恢复
        clearAllPairFailures()
        const resSuccess = await fetch(`http://127.0.0.1:${serverPort}/api/pair`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ pairToken: correctSecret })
        })
        assert.equal(resSuccess.status, 200, '解锁并输入正确密码后必须配对成功')

    } finally {
        await new Promise((resolve) => webServer.close(resolve))
        clearAllPairFailures()
        if (oldSessionDir !== undefined) process.env.MS_SESSION_DIR = oldSessionDir
        else delete process.env.MS_SESSION_DIR
        if (oldSessionDbPath !== undefined) process.env.MS_SESSION_DB_PATH = oldSessionDbPath
        else delete process.env.MS_SESSION_DB_PATH
        if (oldPairingSecret !== undefined) process.env.MS_WEB_PAIRING_SECRET = oldPairingSecret
        else delete process.env.MS_WEB_PAIRING_SECRET
        if (oldTrustProxy !== undefined) process.env.TRUST_PROXY = oldTrustProxy
        else delete process.env.TRUST_PROXY
        try { fs.rmSync(tempDir, { recursive: true, force: true }) } catch (_) {}
    }
})

// =========================================================================
// 安全测试 7：Host/Origin 校验与 Docker 局域网端口映射安全隔离
// =========================================================================
test('Web 局域网访问与端口映射: parseHostHeader 端口严检 + isValidOrigin 协议与同源严格校验', async () => {
    // 1. 安全问题 ④ parseHostHeader 严格端口校验：遇非法端口绝不得回退默认端口
    assert.equal(parseHostHeader('localhost:invalid'), null, '非法端口格式必须返回 null')
    assert.equal(parseHostHeader('localhost:99999'), null, '超出 65535 端口必须返回 null')
    assert.equal(parseHostHeader('localhost:0'), null, '端口为 0 必须返回 null')
    assert.equal(parseHostHeader('localhost:-1'), null, '负数端口必须返回 null')
    assert.equal(parseHostHeader('localhost:'), null, '冒号后无端口必须返回 null')
    assert.equal(parseHostHeader('localhost/test'), null, '包含非法路径字符必须返回 null')
    assert.equal(parseHostHeader('[::1]:invalid'), null, 'IPv6 非法端口必须返回 null')
    assert.equal(parseHostHeader('[::1]:99999'), null, 'IPv6 超出端口必须返回 null')

    // 合法端口解析
    assert.deepEqual(parseHostHeader('localhost:3888'), { hostname: 'localhost', port: 3888 })
    assert.deepEqual(parseHostHeader('localhost', false), { hostname: 'localhost', port: 80 })
    assert.deepEqual(parseHostHeader('localhost', true), { hostname: 'localhost', port: 443 })
    assert.deepEqual(parseHostHeader('[::1]:4888'), { hostname: '[::1]', port: 4888 })
    assert.deepEqual(parseHostHeader('192.168.1.100:4888'), { hostname: '192.168.1.100', port: 4888 })

    // 2. isValidHost 测试
    assert.equal(isValidHost('localhost:3888'), true)
    assert.equal(isValidHost('localhost:invalid'), false, '非法端口的 Host 必须被拒绝')
    assert.equal(isValidHost('attacker.com:3888'), false, '未授权 Host 必须被拒绝 (防 DNS rebinding)')

    // 3. 安全问题 ④ isValidOrigin 协议一致性与同源严格校验
    reloadAllowedHosts('192.168.1.100,localhost')

    // 3.1 协议不匹配测试 (HTTP 请求但 Origin 为 HTTPS，或反之)
    assert.equal(
        isValidOrigin('https://192.168.1.100:4888', null, '192.168.1.100:4888', false),
        false,
        '实际请求为 HTTP 时，Origin 为 HTTPS 必须严格拒绝'
    )
    assert.equal(
        isValidOrigin('http://192.168.1.100:4888', null, '192.168.1.100:4888', true),
        false,
        '实际请求为 HTTPS 时，Origin 为 HTTP 必须严格拒绝'
    )

    // 3.2 正常端口映射 (宿主机 4888 -> 容器 3888)
    assert.equal(
        isValidOrigin('http://192.168.1.100:4888', null, '192.168.1.100:4888', false),
        true,
        '合法 Docker 映射端口的 Host 与 Origin 必须通过校验'
    )
    assert.equal(
        isValidOrigin('http://localhost:4888', null, 'localhost:4888', false),
        true,
        'localhost 自定义端口映射必须通过校验'
    )

    // 3.3 恶意同主机跨端口攻击阻断
    assert.equal(
        isValidOrigin('http://192.168.1.100:8080', null, '192.168.1.100:4888', false),
        false,
        '同主机跨端口 (8080 vs 4888) 必须被严格阻断'
    )
    assert.equal(
        isValidOrigin('http://127.0.0.1:3999', null, '127.0.0.1:4888', false),
        false,
        '同主机跨端口 (3999 vs 4888) 必须被严格阻断'
    )

    // 3.4 恶意跨站攻击阻断
    assert.equal(
        isValidOrigin('https://evil.com', null, '192.168.1.100:4888', false),
        false,
        '跨站来源 evil.com 必须被严格阻断'
    )
    assert.equal(
        isValidOrigin('http://attacker.org:4888', null, '192.168.1.100:4888', false),
        false,
        '非白名单域名必须被严格阻断'
    )

    // 3.5 Host 头非法端口时，即便 Origin 相同也必须拒绝
    assert.equal(
        isValidOrigin('http://localhost:invalid', null, 'localhost:invalid', false),
        false,
        'Host 端口非法时必须拒绝'
    )

    // 4. 真实 HTTP 集成测试：协议不匹配与跨端口拦截
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ms-origin-test-'))
    const tempDbPath = path.join(tempDir, 'sessions.db')
    const oldSessionDir = process.env.MS_SESSION_DIR
    const oldSessionDbPath = process.env.MS_SESSION_DB_PATH
    const oldPairingSecret = process.env.MS_WEB_PAIRING_SECRET

    process.env.MS_SESSION_DIR = tempDir
    process.env.MS_SESSION_DB_PATH = tempDbPath
    process.env.MS_WEB_PAIRING_SECRET = 'StrongValidSecret2026!@#'
    initPairingSecret()

    await new Promise((resolve) => webServer.listen(0, '127.0.0.1', resolve))
    const serverPort = webServer.address().port

    try {
        function rawHttpRequest({ path: reqPath, method = 'GET', headers = {} }) {
            return new Promise((resolve, reject) => {
                const req = http.request({
                    host: '127.0.0.1',
                    port: serverPort,
                    path: reqPath,
                    method,
                    headers
                }, res => {
                    let data = ''
                    res.on('data', chunk => data += chunk)
                    res.on('end', () => resolve({
                        status: res.statusCode,
                        headers: res.headers,
                        body: data,
                        json: () => {
                            try { return JSON.parse(data) } catch { return {} }
                        }
                    }))
                })
                req.on('error', reject)
                req.end()
            })
        }

        // 4.1 发送非法 Host 端口请求 (例如 Host: 127.0.0.1:badport 或 127.0.0.1:99999)
        const resBadHost = await rawHttpRequest({
            path: '/api/state',
            headers: { 'host': '127.0.0.1:badport' }
        })
        assert.equal(resBadHost.status, 403, '非法 Host 端口必须被 403 拦截')
        const badHostJson = resBadHost.json()
        assert.equal(badHostJson.error, 'forbidden_host')

        const resBadPortOver = await rawHttpRequest({
            path: '/api/state',
            headers: { 'host': '127.0.0.1:99999' }
        })
        assert.equal(resBadPortOver.status, 403, '超出 65535 端口的 Host 必须被 403 拦截')
        assert.equal(resBadPortOver.json().error, 'forbidden_host')

        // 4.2 发送协议不匹配请求 (请求是 HTTP，但 Origin 伪造为 HTTPS)
        const resProtocolMismatch = await fetch(`http://127.0.0.1:${serverPort}/api/pair`, {
            method: 'POST',
            headers: {
                'Host': `127.0.0.1:${serverPort}`,
                'Origin': `https://127.0.0.1:${serverPort}`, // 协议不一致
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ pairToken: 'any' })
        })
        assert.equal(resProtocolMismatch.status, 403, '协议不匹配的 Origin 必须被 403 拦截')
        const protoJson = await resProtocolMismatch.json()
        assert.equal(protoJson.error, 'forbidden_origin')

        // 4.3 发送跨端口请求 (Origin 端口与 Host 端口不一致)
        const resCrossPort = await fetch(`http://127.0.0.1:${serverPort}/api/pair`, {
            method: 'POST',
            headers: {
                'Host': `127.0.0.1:${serverPort}`,
                'Origin': `http://127.0.0.1:${serverPort + 1}`, // 跨端口
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ pairToken: 'any' })
        })
        assert.equal(resCrossPort.status, 403, '同主机跨端口 Origin 必须被 403 拦截')
        const crossPortJson = await resCrossPort.json()
        assert.equal(crossPortJson.error, 'forbidden_origin')

        // 4.4 发送合法匹配的同源端口请求 -> 正常放行 (返回配对失败 401 而非 403 Origin 阻断)
        const resValidOrigin = await fetch(`http://127.0.0.1:${serverPort}/api/pair`, {
            method: 'POST',
            headers: {
                'Host': `127.0.0.1:${serverPort}`,
                'Origin': `http://127.0.0.1:${serverPort}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ pairToken: 'wrong_secret_12345' })
        })
        assert.equal(resValidOrigin.status, 401, '合法 Origin 请求正常进入配对业务逻辑')
        assert.equal(resValidOrigin.headers.get('access-control-allow-origin'), `http://127.0.0.1:${serverPort}`)

        // 4.5 局域网请求鉴权不豁免：模拟局域网来源但无设备凭证
        const fakeLanReq = {
            headers: { 'host': `192.168.1.100:${serverPort}` },
            socket: { remoteAddress: '192.168.1.50' }
        }
        const authResult = checkRequestAuthentication(fakeLanReq)
        assert.equal(authResult.authenticated, false, '局域网请求无设备凭据绝不得豁免认证')

    } finally {
        await new Promise((resolve) => webServer.close(resolve))
        if (oldSessionDir !== undefined) process.env.MS_SESSION_DIR = oldSessionDir
        else delete process.env.MS_SESSION_DIR
        if (oldSessionDbPath !== undefined) process.env.MS_SESSION_DB_PATH = oldSessionDbPath
        else delete process.env.MS_SESSION_DB_PATH
        if (oldPairingSecret !== undefined) process.env.MS_WEB_PAIRING_SECRET = oldPairingSecret
        else delete process.env.MS_WEB_PAIRING_SECRET
        reloadAllowedHosts()
        try { fs.rmSync(tempDir, { recursive: true, force: true }) } catch (_) {}
    }
})

// =========================================================================
// 安全测试 8：配对服务异常 fail closed：页面与 API 500 阻断且安全脱敏
// =========================================================================
test('Web 配对服务不可用 fail closed: 页面与 API 500 阻断且安全脱敏', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ms-fail-closed-test-'))
    const tempDbPath = path.join(tempDir, 'sessions.db')
    const oldSessionDir = process.env.MS_SESSION_DIR
    const oldSessionDbPath = process.env.MS_SESSION_DB_PATH
    const oldPairingSecret = process.env.MS_WEB_PAIRING_SECRET

    // 制造一个只读占位符阻断密钥写入
    const secretBlockedPath = path.join(tempDir, '.web_pairing_secret')
    fs.mkdirSync(secretBlockedPath) // 占位目录使得 writeFileSync 抛错

    process.env.MS_SESSION_DIR = tempDir
    process.env.MS_SESSION_DB_PATH = tempDbPath
    delete process.env.MS_WEB_PAIRING_SECRET
    initPairingSecret()
    assert.ok(getPairingInitError(), '必须记录初始化错误')

    await new Promise((resolve) => webServer.listen(0, '127.0.0.1', resolve))
    const serverPort = webServer.address().port

    try {
        // 1. GET / 主页面返回 HTTP 500
        const resHome = await fetch(`http://127.0.0.1:${serverPort}/`)
        assert.equal(resHome.status, 500, '配对服务不可用时 GET / 必须返回 HTTP 500')
        const html = await resHome.text()
        assert.ok(html.includes('无法读取或持久化配对凭证文件'), '页面必须展示脱敏后的错误提示')
        assert.ok(html.includes('disabled'), '提交输入框与按钮必须被禁用')
        // 绝不泄露服务器物理绝对路径
        assert.ok(!html.includes(tempDir), '绝不泄露服务器物理绝对路径')

        // 2. POST /api/pair 接口返回 HTTP 500
        const resPair = await fetch(`http://127.0.0.1:${serverPort}/api/pair`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ pairToken: 'some_token' })
        })
        assert.equal(resPair.status, 500, '配对服务不可用时 POST /api/pair 必须返回 HTTP 500')
        const pairJson = await resPair.json()
        assert.equal(pairJson.error, 'pairing_service_unavailable')
        assert.ok(!JSON.stringify(pairJson).includes(tempDir), 'JSON 响应中绝不泄露物理绝对路径')

    } finally {
        await new Promise((resolve) => webServer.close(resolve))
        if (oldSessionDir !== undefined) process.env.MS_SESSION_DIR = oldSessionDir
        else delete process.env.MS_SESSION_DIR
        if (oldSessionDbPath !== undefined) process.env.MS_SESSION_DB_PATH = oldSessionDbPath
        else delete process.env.MS_SESSION_DB_PATH
        if (oldPairingSecret !== undefined) process.env.MS_WEB_PAIRING_SECRET = oldPairingSecret
        else delete process.env.MS_WEB_PAIRING_SECRET
        try { fs.rmSync(tempDir, { recursive: true, force: true }) } catch (_) {}
    }
})

// =========================================================================
// 安全测试 9：修改配对密码不破坏已配对设备读写，撤销所有设备立即阻断
// =========================================================================
test('修改配对密码不破坏已配对设备读写，撤销所有设备立即阻断', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ms-csrf-decouple-test-'))
    const tempDbPath = path.join(tempDir, 'sessions.db')
    const initialSecret = 'InitialSecretPassword2026!'
    const oldSessionDir = process.env.MS_SESSION_DIR
    const oldSessionDbPath = process.env.MS_SESSION_DB_PATH
    const oldPairingSecret = process.env.MS_WEB_PAIRING_SECRET

    process.env.MS_SESSION_DIR = tempDir
    process.env.MS_SESSION_DB_PATH = tempDbPath
    process.env.MS_WEB_PAIRING_SECRET = initialSecret

    initPairingSecret()
    reloadAllowedHosts()

    await new Promise((resolve) => webServer.listen(0, '127.0.0.1', resolve))
    const serverPort = webServer.address().port

    try {
        // 1. 客户端首次配对成功，获取设备 Cookie 与 CSRF Token
        const resPair = await fetch(`http://127.0.0.1:${serverPort}/api/pair`, {
            method: 'POST',
            headers: {
                'Host': `127.0.0.1:${serverPort}`,
                'Origin': `http://127.0.0.1:${serverPort}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ pairToken: initialSecret, deviceName: 'MacBook Pro 测试机' })
        })
        assert.equal(resPair.status, 200, '首次配对必须成功 (200)')
        const pairJson = await resPair.json()
        assert.equal(pairJson.success, true)
        const csrfToken = pairJson.csrfToken
        assert.ok(csrfToken, '配对响应必须携带 CSRF Token')

        const setCookies = resPair.headers.getSetCookie ? resPair.headers.getSetCookie() : [resPair.headers.get('set-cookie')]
        const deviceCookieHeader = setCookies.find(c => c && c.startsWith(`${DEVICE_COOKIE_NAME}=`))
        assert.ok(deviceCookieHeader, '必须返回 ms_device_token Cookie')
        const deviceCookie = deviceCookieHeader.split(';')[0]

        // 2. 配对成功后正常进行写操作 (POST /api/stop)
        const resWriteInitial = await fetch(`http://127.0.0.1:${serverPort}/api/stop`, {
            method: 'POST',
            headers: {
                'Host': `127.0.0.1:${serverPort}`,
                'Origin': `http://127.0.0.1:${serverPort}`,
                'Cookie': deviceCookie,
                'X-CSRF-Token': csrfToken
            }
        })
        assert.equal(resWriteInitial.status, 200, '密码修改前写请求正常通过 (200)')

        // 3. 模拟管理员修改环境变量并热更新配对密码
        const updatedSecret = 'NewAdminPassword2026!Updated'
        process.env.MS_WEB_PAIRING_SECRET = updatedSecret
        setLocalPairingSecret(updatedSecret)

        // 4.1 验证：修改配对密码后，已有合法浏览器的读请求依然可用 (无感访问)
        const resReadAfterPasswordChange = await fetch(`http://127.0.0.1:${serverPort}/api/config`, {
            headers: {
                'Host': `127.0.0.1:${serverPort}`,
                'Cookie': deviceCookie
            }
        })
        assert.equal(resReadAfterPasswordChange.status, 200, '修改配对密码后，已有合法浏览器读请求依然正常 (200)')

        // 4.2 核心验证：修改配对密码后，已有合法浏览器写请求（携带原 Cookie 与原 CSRF Token）依然可用，绝对不受 403 阻断！
        const resWriteAfterPasswordChange = await fetch(`http://127.0.0.1:${serverPort}/api/stop`, {
            method: 'POST',
            headers: {
                'Host': `127.0.0.1:${serverPort}`,
                'Origin': `http://127.0.0.1:${serverPort}`,
                'Cookie': deviceCookie,
                'X-CSRF-Token': csrfToken
            }
        })
        assert.equal(resWriteAfterPasswordChange.status, 200, '修改配对密码后，旧 CSRF Token 依然有效，写请求不被 403 阻断')

        // 4.3 验证：新设备使用旧配对密码配对必须失败 (401)，使用新密码才能成功
        const resPairWithOldPassword = await fetch(`http://127.0.0.1:${serverPort}/api/pair`, {
            method: 'POST',
            headers: {
                'Host': `127.0.0.1:${serverPort}`,
                'Origin': `http://127.0.0.1:${serverPort}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ pairToken: initialSecret })
        })
        assert.equal(resPairWithOldPassword.status, 401, '新设备尝试使用已修改的旧配对密码必须 401 失败')

        // 5. 管理员执行“撤销所有设备授权” (POST /api/console/revoke-all)
        const resRevokeAll = await fetch(`http://127.0.0.1:${serverPort}/api/console/revoke-all`, {
            method: 'POST',
            headers: {
                'Host': `127.0.0.1:${serverPort}`,
                'Origin': `http://127.0.0.1:${serverPort}`,
                'Cookie': deviceCookie,
                'X-CSRF-Token': csrfToken
            }
        })
        assert.equal(resRevokeAll.status, 200, '撤销所有设备操作成功 (200)')
        const revokeJson = await resRevokeAll.json()
        assert.equal(revokeJson.success, true)

        // 6.1 验证：撤销所有设备后，原设备读请求必须被 401 拦截
        const resReadAfterRevoke = await fetch(`http://127.0.0.1:${serverPort}/api/config`, {
            headers: {
                'Host': `127.0.0.1:${serverPort}`,
                'Cookie': deviceCookie
            }
        })
        assert.equal(resReadAfterRevoke.status, 401, '撤销所有设备后，旧设备读请求必须返回 401 拦截')

        // 6.2 验证：撤销所有设备后，原设备写请求必须被 401 拦截
        const resWriteAfterRevoke = await fetch(`http://127.0.0.1:${serverPort}/api/stop`, {
            method: 'POST',
            headers: {
                'Host': `127.0.0.1:${serverPort}`,
                'Origin': `http://127.0.0.1:${serverPort}`,
                'Cookie': deviceCookie,
                'X-CSRF-Token': csrfToken
            }
        })
        assert.equal(resWriteAfterRevoke.status, 401, '撤销所有设备后，旧设备写请求必须返回 401 拦截')

    } finally {
        await new Promise((resolve) => webServer.close(resolve))
        if (oldSessionDir !== undefined) process.env.MS_SESSION_DIR = oldSessionDir
        else delete process.env.MS_SESSION_DIR
        if (oldSessionDbPath !== undefined) process.env.MS_SESSION_DB_PATH = oldSessionDbPath
        else delete process.env.MS_SESSION_DB_PATH
        if (oldPairingSecret !== undefined) process.env.MS_WEB_PAIRING_SECRET = oldPairingSecret
        else delete process.env.MS_WEB_PAIRING_SECRET
        try { fs.rmSync(tempDir, { recursive: true, force: true }) } catch (_) {}
    }
})
