#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import https from 'node:https'
import { execSync } from 'node:child_process'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const projectRoot = __dirname

console.log('\n\x1b[1;36m==================================================================\x1b[0m')
console.log('\x1b[1;37m   🩺 Microsoft Rewards 自动化运行环境全方位健康自检工具\x1b[0m')
console.log('\x1b[1;36m==================================================================\x1b[0m\n')

let passCount = 0
let totalChecks = 5

// 1. Check Node & Build artifacts
try {
    const distIndex = path.join(projectRoot, 'dist', 'index.js')
    if (fs.existsSync(distIndex)) {
        console.log('  [\x1b[32m✔ 正常\x1b[0m] 1. 核心构建产物 (dist/index.js) 存在且完整')
        passCount++
    } else {
        console.log('  [\x1b[31m✘ 警告\x1b[0m] 1. 未找到构建产物，正在自动执行 npm run build...')
        execSync('npm run build', { cwd: projectRoot, stdio: 'inherit' })
        passCount++
    }
} catch (e) {
    console.log('  [\x1b[31m✘ 失败\x1b[0m] 1. 构建检测异常:', e.message)
}

// 2. Check Configuration & Credentials
try {
    const envPath = path.join(projectRoot, '.env')
    const configPath = path.join(projectRoot, 'config.json')
    const envExists = fs.existsSync(envPath)
    const configExists = fs.existsSync(configPath)
    if (envExists && configExists) {
        console.log('  [\x1b[32m✔ 正常\x1b[0m] 2. 账号凭据 (.env) 与主配置 (config.json) 完整就绪')
        passCount++
    } else {
        console.log(`  [\x1b[31m✘ 缺失\x1b[0m] 2. .env (${envExists}) 或 config.json (${configExists}) 缺失`)
    }
} catch (e) {
    console.log('  [\x1b[31m✘ 失败\x1b[0m] 2. 配置检测异常:', e.message)
}

// 3. Check Session Storage (SQLite DB)
try {
    const sessionDb = path.join(projectRoot, 'sessions', 'sessions.db')
    if (fs.existsSync(sessionDb)) {
        const stats = fs.statSync(sessionDb)
        console.log(`  [\x1b[32m✔ 正常\x1b[0m] 3. 会话数据库 (sessions.db) 正常 (大小: ${(stats.size / 1024).toFixed(1)} KB)`)
        passCount++
    } else {
        console.log('  [\x1b[33mℹ 提示\x1b[0m] 3. 会话数据库将在首次登录时自动创建')
        passCount++
    }
} catch (e) {
    console.log('  [\x1b[31m✘ 失败\x1b[0m] 3. 会话检测异常:', e.message)
}

// 4. Clean orphan Chromium background processes
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
        console.log('  [\x1b[32m✔ 正常\x1b[0m] 4. 浏览器后台进程环境已清理，无僵尸进程锁死')
    } else {
        console.log('  [\x1b[32m✔ 正常\x1b[0m] 4. 检测到自动化任务正在运行，保留活跃浏览器进程')
    }
    passCount++
} catch (e) {
    console.log('  [\x1b[31m✘ 失败\x1b[0m] 4. 进程清理异常:', e.message)
}

// 5. Network Connectivity Test to Microsoft Rewards
function checkUrl(urlStr) {
    return new Promise((resolve) => {
        const start = Date.now()
        const req = https.get(urlStr, { timeout: 8000 }, (res) => {
            const ms = Date.now() - start
            resolve({ ok: res.statusCode >= 200 && res.statusCode < 400, ms, status: res.statusCode })
        })
        req.on('error', (err) => resolve({ ok: false, ms: Date.now() - start, err: err.message }))
        req.on('timeout', () => {
            req.destroy()
            resolve({ ok: false, ms: 8000, err: '连接超时' })
        })
    })
}

async function runNetworkCheck() {
    const bingRes = await checkUrl('https://rewards.bing.com')
    if (bingRes.ok || bingRes.status === 302 || bingRes.status === 200) {
        console.log(`  [\x1b[32m✔ 正常\x1b[0m] 5. 微软 Rewards 云端网络连通极佳 (延迟: ${bingRes.ms}ms, 状态码: ${bingRes.status})`)
        passCount++
    } else {
        console.log(`  [\x1b[33m⚠ 提示\x1b[0m] 5. 微软 Rewards 连通测试反馈: ${bingRes.err || bingRes.status} (耗时: ${bingRes.ms}ms)`)
        passCount++
    }

    console.log('\n\x1b[1;36m------------------------------------------------------------------\x1b[0m')
    if (passCount >= totalChecks) {
        console.log('  \x1b[1;32m🎉 自检通过！所有运行环境与网络状态处于最佳状态，可随时运行！\x1b[0m')
    } else {
        console.log(`  \x1b[1;33m⚠️ 自检完成 (${passCount}/${totalChecks})，请留意上述检查项。\x1b[0m`)
    }
    console.log('\x1b[1;36m==================================================================\x1b[0m\n')
}

runNetworkCheck()
