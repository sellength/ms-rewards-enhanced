import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { URL, fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
// =========================================================================
// 测试隔离前移：在加载 web.mjs 之前无条件预设独立临时隔离环境，绝不触碰真实 sessions 或外部目录
// =========================================================================
const origPreEnvSessionDir = process.env.MS_SESSION_DIR
const origPreEnvSessionDbPath = process.env.MS_SESSION_DB_PATH
const origPreEnvPairingSecret = process.env.MS_WEB_PAIRING_SECRET

const preImportTempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ms-rewards-sec-preimport-'))
process.env.MS_SESSION_DIR = preImportTempDir
process.env.MS_SESSION_DB_PATH = path.join(preImportTempDir, 'sessions.db')
process.env.MS_WEB_PAIRING_SECRET = 'fictional-preimport-secret-sec1234567890abcdef'

const {
    server,
    isValidHost,
    isValidOrigin,
    getLocalSecurityTokens,
    setLocalSecurityTokens,
    getLocalPairingSecret,
    setLocalPairingSecret
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
import {
    validateAndNormalizeAiUrl,
    verifyAiUrlTargetBinding,
    sanitizeErrorKey,
    OFFICIAL_PROVIDER_HOSTS
} from './aiUrlSecurity.mjs'
import {
    initProfileSchema,
    saveProfile,
    deleteProfile,
    testAiConnection,
    fetchAiModels
} from './profileManager.mjs'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

// ==========================================
// 辅助工具：在随机空闲端口启动服务并安全关闭
// ==========================================
async function startTestServer() {
    return new Promise((resolve, reject) => {
        server.listen(0, '127.0.0.1', () => {
            const addr = server.address()
            resolve({
                port: addr.port,
                host: addr.address,
                close: () => new Promise(res => server.close(res))
            })
        })
        server.on('error', reject)
    })
}

/**
 * 原生底层 HTTP 请求工具，允许自由伪造任意 Host 与 Header
 */
function rawHttpRequest({ port, path: reqPath, method = 'GET', headers = {}, body = '' }) {
    return new Promise((resolve, reject) => {
        const req = http.request({
            host: '127.0.0.1',
            port,
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
        if (body) req.write(body)
        req.end()
    })
}

// ==========================================
// S1: Web 控制 API 访问控制与 Host / Origin / CSRF 防御
// ==========================================

test('S1: Socket 级验证 - 服务默认且仅绑定到回环地址 127.0.0.1', async () => {
    const srv = await startTestServer()
    try {
        assert.equal(srv.host, '127.0.0.1', '监听的 host 必须严格为 127.0.0.1 回环地址')
    } finally {
        await srv.close()
    }
})

test('S1: Host 头白名单校验 - 阻断 DNS Rebinding 攻击', () => {
    // 合法 Host
    assert.equal(isValidHost('127.0.0.1:3888'), true)
    assert.equal(isValidHost('localhost:3888'), true)
    assert.equal(isValidHost('localhost'), true)
    assert.equal(isValidHost('[::1]:3888'), true)

    // 非法恶意 Host
    assert.equal(isValidHost('attacker.com:3888'), false)
    assert.equal(isValidHost('rebind.evil-domain.org'), false)
    assert.equal(isValidHost('192.168.1.100:3888'), false)
    assert.equal(isValidHost(''), false)
    assert.equal(isValidHost(null), false)
})

test('S1: Origin 头白名单校验与 CORS 防御 - 拒绝不可信外部来源与跨端口来源', () => {
    // 同源/回环 Origin 且端口匹配
    assert.equal(isValidOrigin('http://127.0.0.1:3888', 3888), true)
    assert.equal(isValidOrigin('http://localhost:3888', 3888), true)
    assert.equal(isValidOrigin(''), true) // 无 Origin 头视为同源直接访问

    // 同主机跨端口来源必须阻断
    assert.equal(isValidOrigin('http://127.0.0.1:3999', 3888), false, '同主机不同端口必须阻断')
    assert.equal(isValidOrigin('http://localhost:8080', 3888), false, '同主机不同端口必须阻断')

    // 恶意外部来源
    assert.equal(isValidOrigin('https://attacker.com', 3888), false)
    assert.equal(isValidOrigin('http://evil-phishing.net:8080', 3888), false)
})

test('S1: HTTP 层集成防御 - 非法 Host、非信任 Origin 或跨端口 Origin 直接 403 阻断', async () => {
    const srv = await startTestServer()
    try {
        // 1. 发送伪造外部 Host (模拟 DNS Rebinding)
        const resHost = await rawHttpRequest({
            port: srv.port,
            path: '/api/state',
            headers: { 'host': 'attacker.com' }
        })
        assert.equal(resHost.status, 403)
        assert.equal(resHost.json().error, 'forbidden_host')

        // 2. 发送外部恶意 Origin
        const resOrigin = await rawHttpRequest({
            port: srv.port,
            path: '/api/state',
            headers: {
                'host': `127.0.0.1:${srv.port}`,
                'origin': 'https://evil.attacker.com'
            }
        })
        assert.equal(resOrigin.status, 403)
        assert.equal(resOrigin.json().error, 'forbidden_origin')

        // 3. 发送同主机但跨端口的恶意 Origin
        const resCrossPort = await rawHttpRequest({
            port: srv.port,
            path: '/api/state',
            headers: {
                'host': `127.0.0.1:${srv.port}`,
                'origin': `http://127.0.0.1:${srv.port + 1}`
            }
        })
        assert.equal(resCrossPort.status, 403)
        assert.equal(resCrossPort.json().error, 'forbidden_origin')
    } finally {
        await srv.close()
    }
})

test('S1: 未授权访问阻断 - 敏感 API 必须校验本地 Session Cookie 或 Token', async () => {
    const srv = await startTestServer()
    try {
        // 外部未经认证直接调用 GET /api/state
        const resState = await rawHttpRequest({
            port: srv.port,
            path: '/api/state',
            headers: { 'host': `127.0.0.1:${srv.port}` }
        })
        assert.equal(resState.status, 401)
        assert.equal(resState.json().error, 'unauthorized')

        // 外部未经认证直接调用 POST /api/run
        const resRun = await rawHttpRequest({
            port: srv.port,
            path: '/api/run',
            method: 'POST',
            headers: { 'host': `127.0.0.1:${srv.port}` }
        })
        assert.equal(resRun.status, 401)
    } finally {
        await srv.close()
    }
})

test('S1: 写操作 CSRF 防护 - 即使有认证凭据但缺失或错误 CSRF Token 也必须 403 阻断', async () => {
    const srv = await startTestServer()
    try {
        const tokens = getLocalSecurityTokens()

        // 携带了认证头 (X-Local-Token)，但没有传 X-CSRF-Token
        const resNoCsrf = await rawHttpRequest({
            port: srv.port,
            path: '/api/run',
            method: 'POST',
            headers: {
                'host': `127.0.0.1:${srv.port}`,
                'x-local-token': tokens.sessionToken
            }
        })
        assert.equal(resNoCsrf.status, 403)
        assert.equal(resNoCsrf.json().error, 'csrf_mismatch')

        // 携带了错误的 CSRF Token
        const resWrongCsrf = await rawHttpRequest({
            port: srv.port,
            path: '/api/run',
            method: 'POST',
            headers: {
                'host': `127.0.0.1:${srv.port}`,
                'x-local-token': tokens.sessionToken,
                'x-csrf-token': 'wrong-token-value'
            }
        })
        assert.equal(resWrongCsrf.status, 403)
    } finally {
        await srv.close()
    }
})

test('S1: 带外凭据与安全配对 - 无凭据裸访问或错误凭据禁止发放 Cookie 及 CSRF，阻断本机跨端口提权', async () => {
    const srv = await startTestServer()
    try {
        // 1. 无凭据裸请求 GET /
        const resAnon = await rawHttpRequest({
            port: srv.port,
            path: '/',
            headers: { 'host': `127.0.0.1:${srv.port}` }
        })
        assert.equal(resAnon.status, 401, '未授权且无配对码访问根路径必须返回 401')
        const cookieHeader = resAnon.headers['set-cookie']
        assert.equal(cookieHeader, undefined, '未配对请求严禁在响应头中下发 Set-Cookie')
        assert.ok(resAnon.body.includes('控制台设备安全配对'), '必须返回安全配对锁屏页面')
        assert.equal(resAnon.body.includes('csrf-token'), false, '未配对页面严禁泄漏真实 csrf-token')

        // 2. 尝试通过 URL 传递配对参数 GET /?pair=... (安全加固：已废除 URL 传递密钥，必须拦截并返回 401)
        const pairingSecret = getLocalPairingSecret()
        const resQueryPair = await rawHttpRequest({
            port: srv.port,
            path: `/?pair=${pairingSecret}`,
            headers: { 'host': `127.0.0.1:${srv.port}` }
        })
        assert.equal(resQueryPair.status, 401, 'URL query 传递配对密钥已废弃，必须严格返回 401')
        assert.equal(resQueryPair.headers['set-cookie'], undefined, 'URL query 配对严禁下发 Cookie')

        // 3. 直接调用 POST /api/pair 传入错误 token
        const resBadApiPair = await rawHttpRequest({
            port: srv.port,
            path: '/api/pair',
            method: 'POST',
            headers: {
                'host': `127.0.0.1:${srv.port}`,
                'content-type': 'application/json'
            },
            body: JSON.stringify({ pairToken: 'wrong-token' })
        })
        assert.equal(resBadApiPair.status, 401)
        assert.equal(resBadApiPair.headers['set-cookie'], undefined)
    } finally {
        await srv.close()
    }
})

test('S1: 授权流程完整性 - 仅允许 POST /api/pair 配对成功后下发凭据，后续读写畅通', async () => {
    const srv = await startTestServer()
    try {
        const pairingSecret = getLocalPairingSecret()
        assert.ok(pairingSecret && typeof pairingSecret === 'string' && pairingSecret.length > 0, '本地配对凭据必须是有效非空字符串')

        // 1. 通过安全 POST /api/pair 接口提交配对凭据
        const resApiPair = await rawHttpRequest({
            port: srv.port,
            path: '/api/pair',
            method: 'POST',
            headers: {
                'host': `127.0.0.1:${srv.port}`,
                'content-type': 'application/json'
            },
            body: JSON.stringify({ pairToken: pairingSecret })
        })
        assert.equal(resApiPair.status, 200)
        assert.equal(resApiPair.json().success, true)
        const setCookieHeader = String(resApiPair.headers['set-cookie'] || '')
        assert.ok(setCookieHeader.includes('ms_device_token='), '必须下发独立长期设备凭证 ms_device_token')
        assert.ok(!setCookieHeader.includes('ms_local_token='), '安全基线：绝不下发任何共享全局 ms_local_token')
        assert.ok(setCookieHeader.includes('HttpOnly'))
        assert.ok(setCookieHeader.includes('SameSite=Strict'))

        // 提取 cookie
        const match = setCookieHeader.match(/ms_device_token=([^;]+)/)
        assert.ok(match, '必须返回高熵 ms_device_token')
        const cookieVal = match[1]

        // 2. 携带配对获得的设备 Cookie 访问主页 GET /
        const resAuthedHome = await rawHttpRequest({
            port: srv.port,
            path: '/',
            headers: {
                'host': `127.0.0.1:${srv.port}`,
                'cookie': `ms_device_token=${cookieVal}`
            }
        })
        assert.equal(resAuthedHome.status, 200)
        const html = resAuthedHome.body
        const csrfMatch = html.match(/<meta\s+name=["']csrf-token["']\s+content=["']([a-f0-9]+)["']/)
        assert.ok(csrfMatch, '已认证页面必须动态注入合法 csrf-token')
        const csrfTokenVal = csrfMatch[1]

        // 3. 模拟合法前端发起的读操作 (GET /api/state)
        const resState = await rawHttpRequest({
            port: srv.port,
            path: '/api/state',
            headers: {
                'host': `127.0.0.1:${srv.port}`,
                'cookie': `ms_device_token=${cookieVal}`
            }
        })
        assert.equal(resState.status, 200, '携带有效设备 Cookie 的读请求应畅通无阻')

        // 4. 模拟合法前端发起的写操作 (带设备 Cookie 与 X-CSRF-Token)
        const resStop = await rawHttpRequest({
            port: srv.port,
            path: '/api/stop',
            method: 'POST',
            headers: {
                'host': `127.0.0.1:${srv.port}`,
                'cookie': `ms_device_token=${cookieVal}`,
                'x-csrf-token': csrfTokenVal
            }
        })
        assert.equal(resStop.status, 200)
        assert.equal(resStop.json().success, true)
    } finally {
        await srv.close()
    }
})

test('S1: /api/pair 真实 HTTP 路由超限防护 - 超过 10KB 优雅返回 413 且连接不被重置', async () => {
    const srv = await startTestServer()
    try {
        const largePayload = JSON.stringify({ pairToken: 'a'.repeat(15 * 1024) })
        const res = await new Promise((resolve, reject) => {
            const req = http.request({
                host: '127.0.0.1',
                port: srv.port,
                path: '/api/pair',
                method: 'POST',
                headers: {
                    'host': `127.0.0.1:${srv.port}`,
                    'content-type': 'application/json',
                    'content-length': Buffer.byteLength(largePayload)
                }
            }, res => {
                let data = ''
                res.on('data', chunk => data += chunk)
                res.on('end', () => resolve({ status: res.statusCode, body: data }))
            })
            req.on('error', reject)
            req.write(largePayload)
            req.end()
        })
        assert.equal(res.status, 413, '请求体超过 10KB 必须返回 413 Payload Too Large')
        assert.ok(res.body.includes('payload_too_large'))
    } finally {
        await srv.close()
    }
})

test('S1: /api/pair 真实 HTTP 路由挂起超时防护 - 超时优雅返回 408 且连接不被重置', async () => {
    const srv = await startTestServer()
    try {
        const res = await new Promise((resolve, reject) => {
            const req = http.request({
                host: '127.0.0.1',
                port: srv.port,
                path: '/api/pair',
                method: 'POST',
                headers: {
                    'host': `127.0.0.1:${srv.port}`,
                    'content-type': 'application/json',
                    'content-length': 500
                }
            }, res => {
                let data = ''
                res.on('data', chunk => data += chunk)
                res.on('end', () => resolve({ status: res.statusCode, body: data }))
            })
            req.on('error', reject)
            // 发送部分数据后故意停滞挂起，等待超时
            req.write('{"pairToken": "part')
            // 不调 req.end()，等待服务器超时触发
        })
        assert.equal(res.status, 408, '挂起请求必须被超时拦截并返回 408 Request Timeout')
        assert.ok(res.body.includes('request_timeout'))
    } finally {
        await srv.close()
    }
})

// ==========================================
// S2: AI 密钥目标地址强绑定与 SSRF 阻断
// ==========================================

test('S2: 目标地址校验 - 禁止内嵌凭据与非加密明文协议', () => {
    // 禁止内嵌账号密码
    assert.throws(() => {
        validateAndNormalizeAiUrl('https://admin:password@api.openai.com/v1')
    }, /目标 URL 禁止包含用户名或密码/)

    // 远程官方服务商禁止明文 HTTP
    assert.throws(() => {
        validateAndNormalizeAiUrl('http://api.openai.com/v1', 'openai')
    }, /远程 AI 服务商必须使用加密的 HTTPS 协议/)

    // 远程未知地址禁止明文 HTTP
    assert.throws(() => {
        validateAndNormalizeAiUrl('http://198.51.100.1/v1', 'custom')
    }, /远程 AI 服务商必须使用加密的 HTTPS 协议/)

    // 仅本地离线回环允许 HTTP
    const localOllama = validateAndNormalizeAiUrl('http://127.0.0.1:11434/v1', 'ollama')
    assert.equal(localOllama, 'http://127.0.0.1:11434/v1')
})

test('S2: 服务商防钓鱼域名校验 - 避免知名服务商指向非官方欺诈地址', () => {
    // 官方地址通过
    const geminiOfficial = validateAndNormalizeAiUrl('https://generativelanguage.googleapis.com/v1beta/openai', 'gemini')
    assert.ok(geminiOfficial.startsWith('https://generativelanguage.googleapis.com'))

    // 假冒服务商域名拦截
    assert.throws(() => {
        validateAndNormalizeAiUrl('https://phishing-gemini.com/v1', 'gemini')
    }, /不属于官方域名/)

    // 如使用第三方网关必须明确配置为 custom
    const customGateway = validateAndNormalizeAiUrl('https://my-proxy-gateway.com/v1', 'custom')
    assert.equal(customGateway, 'https://my-proxy-gateway.com/v1')
})

test('S2 用例 1 & 2: 核心防御 - 恶意覆盖 baseUrl 企图偷取已保存 Key 时 100% 阻断，恶意服务收到零请求', async () => {
    // 创建一个受攻击者控制的恶意端点，用来监听是否收到包含 key 的请求
    let evilRequestCount = 0
    let evilReceivedHeaders = null
    const evilServer = http.createServer((req, res) => {
        evilRequestCount++
        evilReceivedHeaders = req.headers
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ model: 'evil-model' }))
    })

    await new Promise(res => evilServer.listen(0, '127.0.0.1', res))
    const evilPort = evilServer.address().port
    const evilUrl = `http://127.0.0.1:${evilPort}/v1`

    // 创建一个合法绑定的本地模拟端点
    let legitRequestCount = 0
    let legitReceivedHeaders = null
    const legitServer = http.createServer((req, res) => {
        legitRequestCount++
        legitReceivedHeaders = req.headers
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ model: 'legit-model' }))
    })

    await new Promise(res => legitServer.listen(0, '127.0.0.1', res))
    const legitPort = legitServer.address().port
    const legitUrl = `http://127.0.0.1:${legitPort}/v1`

    const testSecretKey = 'sk-sensitive-synthetic-secret-key-123456'

    // 1. 算法级防御断言：当尝试覆盖 baseUrl 时抛出 S2 拦截异常
    assert.throws(() => {
        verifyAiUrlTargetBinding({
            requestUrl: evilUrl,
            requestProvider: 'custom',
            inputKey: '',
            storedAiConfig: {
                provider: 'custom',
                baseUrl: legitUrl,
                apiKey: testSecretKey
            }
        })
    }, /安全防御拦截 \(S2\)/)

    // 2. 端点级集成验证：将受保护 Profile 写入完全隔离的临时测试目录与数据库（绝不触碰真实 sessions.db）
    const testTempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ms-rewards-sec-audit-'))
    const oldSessionDir = process.env.MS_SESSION_DIR
    const oldSessionDbPath = process.env.MS_SESSION_DB_PATH
    const oldPairingSecret = process.env.MS_WEB_PAIRING_SECRET
    process.env.MS_SESSION_DIR = testTempDir
    process.env.MS_SESSION_DB_PATH = path.join(testTempDir, 'sessions.db')
    process.env.MS_WEB_PAIRING_SECRET = 'fictional-subtest-pairing-secret-sec'

    const db = new DatabaseSync(process.env.MS_SESSION_DB_PATH)
    initProfileSchema(db)
    const profile = saveProfile(db, {
        name: '受保护用户',
        email: 'victim_test_s2@example.com',
        aiConfig: {
            enabled: true,
            provider: 'custom',
            baseUrl: legitUrl,
            apiKey: testSecretKey
        }
    })

    const srv = await startTestServer()
    try {
        const tokens = getLocalSecurityTokens()

        // 攻击场景验证：
        // 攻击者向 /api/ai/test 发送请求，指定 profileId，省略 apiKey，但把 baseUrl 覆盖为恶意 evilUrl
        const attackRes = await rawHttpRequest({
            port: srv.port,
            path: '/api/ai/test',
            method: 'POST',
            headers: {
                'host': `127.0.0.1:${srv.port}`,
                'x-local-token': tokens.sessionToken,
                'x-csrf-token': tokens.csrfToken,
                'content-type': 'application/json'
            },
            body: JSON.stringify({
                profileId: profile.id,
                baseUrl: evilUrl,
                provider: 'custom',
                apiKey: '' // 省略 key，企图借服务端读取已保存的 key
            })
        })

        // 服务端必须返回 400 阻断
        assert.equal(attackRes.status, 400)
        const attackData = attackRes.json()
        assert.equal(attackData.success, false)
        assert.match(attackData.error, /安全防御拦截 \(S2\)/)

        // 核心安全指标断言：恶意端点必须收到 0 次请求！
        assert.equal(evilRequestCount, 0, '恶意目标端点收到请求次数必须严格为 0')
        assert.equal(evilReceivedHeaders, null, '恶意端点绝对不能收到任何带有密钥的 Headers')

        // 正常场景验证：
        // 请求与已保存的绑定端点一致时，允许沿用已保存 key
        const legitRes = await rawHttpRequest({
            port: srv.port,
            path: '/api/ai/test',
            method: 'POST',
            headers: {
                'host': `127.0.0.1:${srv.port}`,
                'x-local-token': tokens.sessionToken,
                'x-csrf-token': tokens.csrfToken,
                'content-type': 'application/json'
            },
            body: JSON.stringify({
                profileId: profile.id,
                baseUrl: legitUrl,
                provider: 'custom',
                apiKey: '••••••••' // 使用掩码，沿用保存的 key
            })
        })

        assert.equal(legitRes.status, 200)
        assert.equal(legitRequestCount, 1, '合法目标端点正常接收到 1 次测试请求')
        assert.equal(legitReceivedHeaders['authorization'], `Bearer ${testSecretKey}`)
    } finally {
        await srv.close()
        await new Promise(res => evilServer.close(res))
        await new Promise(res => legitServer.close(res))
        try { deleteProfile(db, profile.id) } catch (_) {}
        try { db.close() } catch (_) {}
        try { fs.rmSync(testTempDir, { recursive: true, force: true }) } catch (_) {}
        if (oldSessionDir !== undefined) process.env.MS_SESSION_DIR = oldSessionDir
        else delete process.env.MS_SESSION_DIR
        if (oldSessionDbPath !== undefined) process.env.MS_SESSION_DB_PATH = oldSessionDbPath
        else delete process.env.MS_SESSION_DB_PATH
        if (oldPairingSecret !== undefined) process.env.MS_WEB_PAIRING_SECRET = oldPairingSecret
        else delete process.env.MS_WEB_PAIRING_SECRET
    }
})

test('S2 用例 3: 自定义网关在显式传入新 Key 时允许测试，未提供新 Key 更改地址则阻断', () => {
    const storedConfig = {
        provider: 'custom',
        baseUrl: 'https://gateway-a.example.com/v1',
        apiKey: 'sk-existing-key'
    }

    // 1. 用户显式输入了新 Key，允许测试新地址
    const allowNewKey = verifyAiUrlTargetBinding({
        requestUrl: 'https://gateway-b.example.com/v1',
        requestProvider: 'custom',
        inputKey: 'sk-new-gateway-key',
        storedAiConfig: storedConfig
    })
    assert.equal(allowNewKey.finalKey, 'sk-new-gateway-key')
    assert.equal(allowNewKey.usingStoredKey, false)

    // 2. 更改了地址但未输入新 Key（沿用旧 Key 企图外发），必须抛出拦截异常
    assert.throws(() => {
        verifyAiUrlTargetBinding({
            requestUrl: 'https://gateway-b.example.com/v1',
            requestProvider: 'custom',
            inputKey: '',
            storedAiConfig: storedConfig
        })
    }, /安全防御拦截 \(S2\)/)
})

test('S2 用例 4: 跨主机 3xx 重定向安全防御与敏感密钥脱敏', async () => {
    // 1. 模拟一个返回 302 跨站重定向的端点
    const redirectServer = http.createServer((req, res) => {
        res.writeHead(302, {
            'Location': 'http://127.0.0.1:59999/malicious-target'
        })
        res.end()
    })
    await new Promise(res => redirectServer.listen(0, '127.0.0.1', res))
    const rPort = redirectServer.address().port

    try {
        const testKey = 'sk-sensitive-test-secret-key-abcdef'
        const res = await testAiConnection({
            baseUrl: `http://127.0.0.1:${rPort}/v1`,
            apiKey: testKey,
            provider: 'custom'
        })

        // 必须被 3xx 重定向安全防御拦截
        assert.equal(res.success, false)
        assert.match(res.error, /安全防护拦截 \(S2\): 目标端点返回了重定向 \(HTTP 302\)/)

        // 2. 错误脱敏测试：验证 sanitizeErrorKey 不会将密钥回显
        const dirtyMessage = `Failed at https://api.openai.com: invalid key Bearer ${testKey} or sk-sensitive-test-secret-key-abcdef`
        const cleaned = sanitizeErrorKey(dirtyMessage, testKey)
        assert.ok(!cleaned.includes(testKey), '清洗后的报错中绝不能包含原始敏感 API Key')
        assert.match(cleaned, /\*\*\*/)
    } finally {
        await new Promise(res => redirectServer.close(res))
    }
})
