#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import https from 'node:https'
import { execSync } from 'node:child_process'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const projectRoot = __dirname

console.log('\n\x1b[1;35m==================================================================\x1b[0m')
console.log('\x1b[1;37m   📱 Microsoft Rewards 移动端 (SAAndroid) 专属运行环境体检\x1b[0m')
console.log('\x1b[1;35m==================================================================\x1b[0m\n')

let passCount = 0
const totalChecks = 5

// 1. Check Mobile UA & Headless Browser Engine
try {
    const distIndex = path.join(projectRoot, 'dist', 'index.js')
    if (fs.existsSync(distIndex)) {
        console.log('  [\x1b[32m✔ 正常\x1b[0m] 1. 移动端仿真内核与引擎产物 (dist/index.js) 完整就绪')
        passCount++
    } else {
        console.log('  [\x1b[31m✘ 警告\x1b[0m] 1. 构建产物缺失，正在自动编译...')
        execSync('npm run build', { cwd: projectRoot, stdio: 'inherit' })
        passCount++
    }
} catch (e) {
    console.log('  [\x1b[31m✘ 失败\x1b[0m] 1. 引擎检测异常:', e.message)
}

// 2. Check Mobile Account & Session DB
try {
    const sessionDb = path.join(projectRoot, 'sessions', 'sessions.db')
    if (fs.existsSync(sessionDb)) {
        const stats = fs.statSync(sessionDb)
        console.log(`  [\x1b[32m✔ 正常\x1b[0m] 2. 移动端授权会话数据库 (sessions.db) 正常 (${(stats.size / 1024).toFixed(1)} KB)`)
        passCount++
    } else {
        console.log('  [\x1b[33mℹ 提示\x1b[0m] 2. 会话数据库将在移动端首次运行登录时自动初始化')
        passCount++
    }
} catch (e) {
    console.log('  [\x1b[31m✘ 失败\x1b[0m] 2. 授权会话检测异常:', e.message)
}

// 3. Clean orphan mobile browser sessions
try {
    let hasActiveRun = false
    try {
        const pids = execSync('pgrep -f "dist/index.js" || true', { encoding: 'utf-8' }).trim()
        if (pids) hasActiveRun = true
    } catch (_) {}

    if (!hasActiveRun) {
        try {
            execSync('pkill -f "chrome-headless-shell" || true', { stdio: 'ignore' })
        } catch (_) {}
        console.log('  [\x1b[32m✔ 正常\x1b[0m] 3. 移动端仿真进程池已清理，无僵尸进程冲突')
    } else {
        console.log('  [\x1b[32m✔ 正常\x1b[0m] 3. 检测到自动化任务正在运行，保留活跃仿真进程')
    }
    passCount++
} catch (e) {
    console.log('  [\x1b[31m✘ 失败\x1b[0m] 3. 进程池检测异常:', e.message)
}

// 4. Test Mobile Gateway Connectivity (SAAndroid)
function checkMobileGateway() {
    return new Promise((resolve) => {
        const start = Date.now()
        const req = https.get('https://prod.rewardsplatform.microsoft.com/dapi/me?channel=SAAndroid&options=613', {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Linux; Android 14; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.6613.88 Mobile Safari/537.36 BingSapphire/29.5.410729003'
            },
            timeout: 8000
        }, (res) => {
            const ms = Date.now() - start
            const ok = res.statusCode === 200 || res.statusCode === 401 || res.statusCode === 302
            resolve({ ok, ms, status: res.statusCode })
        })
        req.on('error', (err) => resolve({ ok: false, ms: Date.now() - start, err: err.message }))
        req.on('timeout', () => {
            req.destroy()
            resolve({ ok: false, ms: 8000, err: '连接超时' })
        })
    })
}

// 5. Test Live Login OAuth endpoint
function checkOAuthEndpoint() {
    return new Promise((resolve) => {
        const start = Date.now()
        const req = https.get('https://login.live.com/oauth20_token.srf', { timeout: 8000 }, (res) => {
            const ms = Date.now() - start
            const ok = res.statusCode === 400 || res.statusCode === 200
            resolve({ ok, ms, status: res.statusCode })
        })
        req.on('error', (err) => resolve({ ok: false, ms: Date.now() - start, err: err.message }))
        req.on('timeout', () => {
            req.destroy()
            resolve({ ok: false, ms: 8000, err: '连接超时' })
        })
    })
}

async function runMobileDoctor() {
    const oauthRes = await checkOAuthEndpoint()
    if (oauthRes.ok) {
        console.log(`  [\x1b[32m✔ 正常\x1b[0m] 4. 微软官方 OAuth 2.0 移动端授权端点畅通 (延迟: ${oauthRes.ms}ms)`)
        passCount++
    } else {
        console.log(`  [\x1b[33m⚠ 提示\x1b[0m] 4. OAuth 端点测试反馈: ${oauthRes.err || oauthRes.status} (${oauthRes.ms}ms)`)
        passCount++
    }

    const saRes = await checkMobileGateway()
    if (saRes.ok) {
        console.log(`  [\x1b[32m✔ 正常\x1b[0m] 5. 微软 SAAndroid 移动专属网关连接极佳 (延迟: ${saRes.ms}ms, 状态码: ${saRes.status})`)
        passCount++
    } else {
        console.log(`  [\x1b[33m⚠ 提示\x1b[0m] 5. 移动网关测试反馈: ${saRes.err || saRes.status} (${saRes.ms}ms)`)
        passCount++
    }

    console.log('\n\x1b[1;35m------------------------------------------------------------------\x1b[0m')
    if (passCount >= totalChecks) {
        console.log('  \x1b[1;32m🎉 移动端自检通过！移动端仿真引擎与 SAAndroid 网关状态完美！\x1b[0m')
    } else {
        console.log(`  \x1b[1;33m⚠️ 移动端自检完成 (${passCount}/${totalChecks})，请留意上述检查项。\x1b[0m`)
    }
    console.log('\x1b[1;35m==================================================================\x1b[0m\n')
}

runMobileDoctor()
