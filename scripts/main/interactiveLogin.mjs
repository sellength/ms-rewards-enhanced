import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import { chromium } from 'patchright'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const projectRoot = path.resolve(__dirname, '../..')
const sessionDbDir = path.join(projectRoot, 'sessions')
const sessionDbPath = path.join(sessionDbDir, 'sessions.db')
const envPath = path.join(projectRoot, '.env')

function log(msg, level = 'info') {
    const time = new Date().toLocaleTimeString('zh-CN', { hour12: false })
    const prefix = level === 'err' ? '❌' : (level === 'warn' ? '⚠️' : '🔐')
    console.log(`[${time}] ${prefix} ${msg}`)
}

function ensureDatabase() {
    if (!fs.existsSync(sessionDbDir)) {
        fs.mkdirSync(sessionDbDir, { recursive: true })
    }
    const db = new DatabaseSync(sessionDbPath)
    db.exec('PRAGMA busy_timeout = 5000')
    db.exec(`CREATE TABLE IF NOT EXISTS sessions (
        email TEXT NOT NULL,
        platform TEXT NOT NULL,
        storage_state TEXT,
        fingerprint TEXT,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (email, platform)
    )`)
    db.exec(`CREATE TABLE IF NOT EXISTS account_metadata (
        email TEXT PRIMARY KEY,
        mobile_device_id TEXT,
        resolved_region TEXT,
        updated_at INTEGER
    )`)
    return db
}

function saveSessions(db, email, storageState) {
    const now = Date.now()
    const stateStr = JSON.stringify(storageState)
    const stmt = db.prepare(`
        INSERT INTO sessions (email, platform, storage_state, updated_at)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(email, platform)
        DO UPDATE SET storage_state = excluded.storage_state, updated_at = excluded.updated_at
    `)
    stmt.run(email, 'desktop', stateStr, now)
    stmt.run(email, 'mobile', stateStr, now)
}

function updateEnvEmail(email) {
    let content = ''
    if (fs.existsSync(envPath)) {
        content = fs.readFileSync(envPath, 'utf8')
    }
    const lines = content.split('\n')
    let found = false
    const newLines = lines.map(line => {
        if (/^\s*ACCOUNT_1_EMAIL\s*=/.test(line)) {
            found = true
            return `ACCOUNT_1_EMAIL=${email}`
        }
        return line
    })
    if (!found) {
        newLines.push(`ACCOUNT_1_EMAIL=${email}`)
    }
    fs.writeFileSync(envPath, newLines.join('\n'), 'utf8')
}

async function extractAccountInfo(page, context, storageState) {
    let email = ''
    let country = ''

    // 1. Check getuserinfo API on rewards.bing.com for rich profile
    try {
        const apiInfo = await page.evaluate(async () => {
            try {
                const res = await fetch('https://rewards.bing.com/api/getuserinfo')
                const json = await res.json()
                return {
                    email: json?.dashboard?.userStatus?.email || null,
                    country: json?.dashboard?.userProfile?.attributes?.country || null
                }
            } catch {
                return null
            }
        })
        if (apiInfo?.email) email = apiInfo.email
        if (apiInfo?.country) country = apiInfo.country
    } catch (_) {}

    // 2. Check DOM elements on rewards.bing.com or bing.com
    if (!email) {
        try {
            const domEmail = await page.evaluate(() => {
                const idEl = document.querySelector('#id_n') || document.querySelector('#id_s')
                if (idEl && idEl.textContent && idEl.textContent.includes('@')) {
                    return idEl.textContent.trim()
                }
                const banner = document.querySelector('[data-testid="identityBanner"]') || document.querySelector('.b_idProviders')
                if (banner) {
                    const match = banner.textContent.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/)
                    if (match) return match[0]
                }
                return null
            })
            if (domEmail) email = domEmail
        } catch (_) {}
    }

    // 3. Check storageState localStorage
    if (!email) {
        for (const origin of storageState.origins || []) {
            for (const item of origin.localStorage || []) {
                const combined = `${item.key} ${item.value}`
                const match = combined.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/)
                if (match && !match[0].includes('example.com') && !match[0].includes('w3.org')) {
                    email = match[0]
                    break
                }
            }
            if (email) break
        }
    }

    // 4. Check cookies
    if (!email) {
        for (const cookie of storageState.cookies || []) {
            if (cookie.value && cookie.value.includes('@')) {
                const match = decodeURIComponent(cookie.value).match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/)
                if (match && !match[0].includes('example.com')) {
                    email = match[0]
                    break
                }
            }
        }
    }

    // 5. Fallback to existing .env if configured
    if (!email && fs.existsSync(envPath)) {
        const raw = fs.readFileSync(envPath, 'utf8')
        const match = raw.match(/^\s*ACCOUNT_1_EMAIL\s*=\s*(.+)$/m)
        if (match && match[1].trim()) email = match[1].trim()
    }

    return { email, country }
}

async function extractEmail(page, context, storageState) {
    const info = await extractAccountInfo(page, context, storageState)
    return info.email
}

async function main() {
    log('正在启动本地微软官方登录窗口...')
    log('提示：请在弹出的官方浏览器窗口中直接登录您的微软账号。')
    log('程序全程不收集密码或密钥，登录成功后会自动提取会话 Cookie 并关闭窗口。')

    const browser = await chromium.launch({
        headless: false,
        args: [
            '--window-size=960,780',
            '--no-first-run',
            '--no-default-browser-check',
            '--disable-blink-features=AutomationControlled'
        ]
    })

    let isClosed = false
    const markClosed = () => {
        if (!isClosed) {
            isClosed = true
            log('检测到登录窗口已关闭。', 'warn')
        }
    }

    browser.on('disconnected', markClosed)

    const context = await browser.newContext({
        viewport: { width: 940, height: 740 },
        userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36 Edg/133.0.0.0'
    })

    context.on('close', markClosed)

    const page = await context.newPage()
    page.on('close', markClosed)

    try {
        await page.goto('https://rewards.bing.com/auth/login?ru=%2Fdashboard', { waitUntil: 'domcontentloaded' })
    } catch (e) {
        if (isClosed || page.isClosed()) {
            log('登录窗口已关闭，未完成登录。', 'warn')
            try { await browser.close() } catch (_) {}
            process.exit(0)
        }
    }

    const startTime = Date.now()
    const timeoutMs = 5 * 60 * 1000 // 5 分钟超时
    let success = false

    while (Date.now() - startTime < timeoutMs) {
        if (isClosed || page.isClosed() || !browser.isConnected() || context.pages().length === 0) {
            log('登录窗口已被用户关闭，未完成登录。', 'warn')
            try { await browser.close() } catch (_) {}
            process.exit(0)
        }

        await new Promise(r => setTimeout(r, 1500))

        if (isClosed || page.isClosed() || !browser.isConnected() || context.pages().length === 0) {
            log('登录窗口已被用户关闭，未完成登录。', 'warn')
            try { await browser.close() } catch (_) {}
            process.exit(0)
        }

        try {
            const currentUrl = page.url()
            const cookies = await context.cookies()

            const hasAuthCookie = cookies.some(c =>
                c.name === '_U' ||
                c.name === 'ESTSAUTHPERSISTENT' ||
                c.name === 'ESTSAUTH' ||
                c.name === 'MSPOK' ||
                c.name === 'WLSSC' ||
                c.name === 'NAP' ||
                c.name === 'RPSTAuth' ||
                c.name === 'rn_SID'
            )

            // Auto-recovery if landed on /about with auth cookies
            if (currentUrl.includes('/about') && hasAuthCookie) {
                log('检测到微软身份凭据已生效但处于介绍页，正在进入 Rewards 仪表盘...')
                await page.goto('https://rewards.bing.com/auth/login?ru=%2Fdashboard', { waitUntil: 'domcontentloaded' }).catch(() => {})
                continue
            }

            const isAuthFlow = currentUrl.includes('login.live.com') ||
                currentUrl.includes('login.microsoftonline.com') ||
                currentUrl.includes('/signin') ||
                currentUrl.includes('/about') ||
                currentUrl.includes('challenge')

            const onDashboard = currentUrl.includes('rewards.bing.com/dashboard') || currentUrl.includes('rewards.bing.com/earn')
            const onRewards = currentUrl.includes('rewards.bing.com') && !isAuthFlow
            const onBing = currentUrl.includes('bing.com') && !isAuthFlow

            if (onDashboard || (hasAuthCookie && (onRewards || onBing))) {
                log('检测到微软登录态生效，正在提取会话 Cookie 与账号信息...')
                // Wait 1 second for any final redirect or cookie settlement
                await new Promise(r => setTimeout(r, 1000))

                // Synchronize Bing SSO if _U is not yet present
                const updatedCookies = await context.cookies()
                if (!updatedCookies.some(c => c.name === '_U')) {
                    log('正在通过微软 SSO 同步 Bing 搜索引擎会话 (_U)...')
                    try {
                        await page.goto('https://www.bing.com/fd/auth/signin?action=interactive&provider=windows_live_id&return_url=https%3A%2F%2Fwww.bing.com%2F', { waitUntil: 'domcontentloaded', timeout: 8000 })
                        await new Promise(r => setTimeout(r, 1500))
                    } catch (_) {}
                }

                const storageState = await context.storageState()
                let { email, country } = await extractAccountInfo(page, context, storageState)

                if (!email) {
                    // Try to wait for page to settle and check again
                    await new Promise(r => setTimeout(r, 1500))
                    const retry = await extractAccountInfo(page, context, storageState)
                    email = retry.email
                    if (!country) country = retry.country
                }

                if (!email) {
                    email = 'microsoft_user@outlook.com'
                    log('未能自动解析出邮箱地址，使用默认账号占位符。', 'warn')
                }

                const regionStr = country ? ` | 账户归属区域: ${country.toUpperCase()}` : ''
                log(`已识别到登录账号: ${email}${regionStr}`)

                const db = ensureDatabase()
                try {
                    saveSessions(db, email, storageState)
                    const normRegion = (country && /^[a-zA-Z]{2}$/.test(country)) ? country.toUpperCase() : null
                    if (normRegion) {
                        db.prepare(`
                            INSERT INTO account_metadata (email, resolved_region, updated_at)
                            VALUES (?, ?, ?)
                            ON CONFLICT(email)
                            DO UPDATE SET resolved_region = excluded.resolved_region, updated_at = excluded.updated_at
                        `).run(email, normRegion, Date.now())
                        log(`账户区域 [${normRegion}] 已同步持久化至会话数据库。`)
                    }
                    let targetProfileId = process.env.REWARDS_ACTIVE_PROFILE_ID
                    if (!targetProfileId) {
                        try {
                            const actRow = db.prepare("SELECT id FROM user_profiles WHERE is_active = 1 LIMIT 1").get()
                                || db.prepare("SELECT id FROM user_profiles ORDER BY updated_at DESC LIMIT 1").get()
                            if (actRow?.id) targetProfileId = actRow.id
                        } catch (_) {}
                    }
                    if (targetProfileId) {
                        try {
                            const pRegion = normRegion || 'US'
                            const pRow = db.prepare("SELECT name, email FROM user_profiles WHERE id = ?").get(targetProfileId)
                            const newName = (!pRow?.name || pRow.name === '新建账号' || pRow.name === '默认主账号')
                                ? email.split('@')[0]
                                : pRow.name
                            db.prepare(`
                                UPDATE user_profiles
                                SET email = ?, name = ?, region = ?, updated_at = ?
                                WHERE id = ?
                            `).run(email, newName, pRegion, Date.now(), targetProfileId)
                            log(`Profile [${targetProfileId}] 已成功绑定登录邮箱 ${email} 与区域 ${pRegion}。`)
                        } catch (_) {}
                    }
                    log('两端会话已写入 sessions.db (desktop & mobile)。')
                } finally {
                    try { db.close() } catch (_) {}
                }

                updateEnvEmail(email)
                log('环境配置 .env 已同步更新账号邮箱。')
                log('🎉 微软账号授权登录成功！即将自动关闭登录窗口...', 'info')

                success = true
                await new Promise(r => setTimeout(r, 1000))
                break
            }
        } catch (loopErr) {
            const errMsg = loopErr instanceof Error ? loopErr.message : String(loopErr)
            if (isClosed || page.isClosed() || !browser.isConnected() || errMsg.includes('closed') || errMsg.includes('Target page')) {
                log('登录窗口已被用户关闭，未完成登录。', 'warn')
                try { await browser.close() } catch (_) {}
                process.exit(0)
            }
        }
    }

    try {
        if (!isClosed && browser.isConnected()) await browser.close()
    } catch (_) {}

    if (success) {
        log('登录会话已成功就绪，控制台状态已激活。')
        process.exit(0)
    } else {
        log('登录流程已结束。', 'warn')
        process.exit(0)
    }
}

main().catch(err => {
    log(`交互登录结束: ${err.message}`, 'warn')
    process.exit(0)
})
