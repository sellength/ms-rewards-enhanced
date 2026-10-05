#!/usr/bin/env node
import { spawn, execSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import readline from 'node:readline'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const projectRoot = __dirname
const stateFilePath = path.join(projectRoot, 'sessions', 'daily_state.json')

// Clean orphan Chromium background processes to prevent profile locking
try {
    execSync('pkill -f "chrome-headless-shell|playwright" 2>/dev/null || true', { stdio: 'ignore' })
} catch (_) {}

// Resize terminal window (106 cols x 36 rows) & Switch to Alternate Screen Buffer
process.stdout.write('\x1b[8;36;106t\x1b[?1049h\x1b[?25l')

function getTodayKey() {
    const d = new Date()
    const y = d.getFullYear()
    const m = String(d.getMonth() + 1).padStart(2, '0')
    const day = String(d.getDate()).padStart(2, '0')
    return `${y}-${m}-${day}`
}

let isFinished = false

// Dashboard State
const state = {
    account: '加载中...',
    totalPoints: 0,
    startPoints: 0,
    dayStartBalance: 0,
    todayEarnedTotal: 0,
    gainedPoints: 0,
    lifetimePoints: 0,
    dailyEarned: 0,
    offers: 0,
    shopPoints: 0,
    level: '读取中...',
    levelProgress: '',
    pcSearchQuota: '0/0',
    mobileSearchQuota: '0/0',
    dailySetQuota: '0/0',
    promotionsQuota: '0/0',
    startTime: Date.now(),
    currentStatus: '🚀 正在初始化自动化会话...',
    currentAction: '正在加载浏览器环境与账号配置...',
    countdownSec: 0,
    
    // Task items (with points)
    checkIn: { name: '每日签到 (Daily Check-In)', status: 'WAITING', progress: '0/1', points: '0/5 分', info: '等待检测' },
    dailySet: { name: '每日任务卡 (Daily Set)', status: 'WAITING', progress: '0/3', points: '0/30分', info: '等待检测' },
    promotions: { name: '活动与推广 (Promotions)', status: 'WAITING', progress: '0/3', points: '0/30分', info: '等待检测' },
    readToEarn: { name: '必应新闻阅读 (Read to Earn)', status: 'WAITING', progress: '0/10', points: '0/30分', info: '等待开始 (20~30s/篇)' },
    desktopSearch: { name: 'PC 桌面端搜索 (PC Search)', status: 'WAITING', progress: '0/30', points: '0/90分', info: '等待开始 (8~15s/次)' },
    mobileSearch: { name: 'Mobile 移动端搜索 (Mobile)', status: 'WAITING', progress: '0/20', points: '0/60分', info: '等待开始 (8~15s/次)' },

    // Recent logs
    logs: []
}

// 1. Load Local State Memory if available for today
try {
    if (fs.existsSync(stateFilePath)) {
        const raw = fs.readFileSync(stateFilePath, 'utf-8')
        const memory = JSON.parse(raw)
        const today = getTodayKey()
        if (memory && memory.date === today) {
            if (memory.account) state.account = memory.account
            if (memory.totalPoints) state.totalPoints = memory.totalPoints
            if (memory.dayStartBalance) state.dayStartBalance = memory.dayStartBalance
            if (memory.todayEarnedTotal !== undefined) state.todayEarnedTotal = memory.todayEarnedTotal
            if (memory.lifetimePoints) state.lifetimePoints = memory.lifetimePoints
            if (memory.dailyEarned !== undefined) state.dailyEarned = memory.dailyEarned
            if (memory.offers !== undefined) state.offers = memory.offers
            if (memory.shopPoints !== undefined) state.shopPoints = memory.shopPoints
            if (memory.level) state.level = memory.level
            if (memory.levelProgress) state.levelProgress = memory.levelProgress
            if (memory.pcSearchQuota) state.pcSearchQuota = memory.pcSearchQuota
            if (memory.mobileSearchQuota) state.mobileSearchQuota = memory.mobileSearchQuota
            if (memory.dailySetQuota) state.dailySetQuota = memory.dailySetQuota
            if (memory.promotionsQuota) state.promotionsQuota = memory.promotionsQuota

            if (memory.tasks) {
                for (const key of Object.keys(memory.tasks)) {
                    if (state[key]) {
                        Object.assign(state[key], memory.tasks[key])
                    }
                }
            }
            if (memory.allTasksDone) {
                state.currentStatus = '🎉 今日所有任务已全部完成！'
                state.currentAction = '所有积分已成功入账，自动化结束。'
            }
        }
    }
} catch (e) {}

function saveStateMemory() {
    try {
        const memory = {
            date: getTodayKey(),
            account: state.account,
            updatedAt: new Date().toISOString(),
            totalPoints: state.totalPoints,
            dayStartBalance: state.dayStartBalance,
            todayEarnedTotal: state.todayEarnedTotal,
            lifetimePoints: state.lifetimePoints,
            dailyEarned: state.dailyEarned,
            offers: state.offers,
            shopPoints: state.shopPoints,
            level: state.level,
            levelProgress: state.levelProgress,
            pcSearchQuota: state.pcSearchQuota,
            mobileSearchQuota: state.mobileSearchQuota,
            dailySetQuota: state.dailySetQuota,
            promotionsQuota: state.promotionsQuota,
            allTasksDone: state.currentStatus.includes('全部完成'),
            tasks: {
                checkIn: state.checkIn,
                dailySet: state.dailySet,
                promotions: state.promotions,
                readToEarn: state.readToEarn,
                desktopSearch: state.desktopSearch,
                mobileSearch: state.mobileSearch
            }
        }
        const dir = path.dirname(stateFilePath)
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
        fs.writeFileSync(stateFilePath, JSON.stringify(memory, null, 2), 'utf-8')
    } catch (e) {}
}

function addLog(msg) {
    const time = new Date().toLocaleTimeString('zh-CN', { hour12: false })
    state.logs.push(`[${time}] ${msg}`)
    if (state.logs.length > 5) state.logs.shift()
}

function stripAnsi(str) {
    return str.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '')
}

function getVisualWidth(str) {
    const clean = stripAnsi(str)
    let width = 0
    for (let i = 0; i < clean.length; i++) {
        const code = clean.codePointAt(i)
        if (code === 0xFE0F || code === 0xFE0E) continue // variation selector
        if (code >= 0x10000) { 
            width += 2
            i++ // skip surrogate
            continue 
        }
        if (
            (code >= 0x4E00 && code <= 0x9FFF) || 
            (code >= 0x3400 && code <= 0x4DBF) || 
            (code >= 0xF900 && code <= 0xFAFF) || 
            (code >= 0x3000 && code <= 0x303F) || 
            (code >= 0xFF00 && code <= 0xFFEF) ||
            (code === 0x2705) || // ✅
            (code === 0x23F3)    // ⏳
        ) {
            width += 2
        } else {
            width += 1
        }
    }
    return width
}

function truncateVisual(str, maxW) {
    if (getVisualWidth(str) <= maxW) return str
    let currentW = 0
    let res = ''
    for (let i = 0; i < str.length; i++) {
        const c = str[i]
        const w = getVisualWidth(c)
        if (currentW + w + 1 > maxW) {
            return res + '…'
        }
        res += c
        currentW += w
    }
    return res
}

function padVisual(str, targetWidth, align = 'left') {
    const truncated = truncateVisual(str, targetWidth)
    const w = getVisualWidth(truncated)
    const pad = Math.max(0, targetWidth - w)
    return align === 'right' ? ' '.repeat(pad) + truncated : truncated + ' '.repeat(pad)
}

const BOX_WIDTH = 98 // Perfect fit inside 106-column terminal

function createBoxLine(content = '') {
    const truncated = truncateVisual(content, BOX_WIDTH)
    const w = getVisualWidth(truncated)
    const pad = Math.max(0, BOX_WIDTH - w)
    return `\x1b[1;36m║\x1b[0m ${truncated}${' '.repeat(pad)} \x1b[1;36m║\x1b[0m`
}

function renderProgressBar(current, total, length = 10) {
    if (!total || total === 0) return '░'.repeat(length)
    const ratio = Math.min(Math.max(current / total, 0), 1)
    const filled = Math.round(ratio * length)
    return '\x1b[32m' + '█'.repeat(filled) + '\x1b[90m' + '░'.repeat(length - filled) + '\x1b[0m'
}

function getStatusBadge(status) {
    switch (status) {
        case 'DONE':
            return '\x1b[32m[✅ 已完成]\x1b[0m'
        case 'RUNNING':
            return '\x1b[33m[🔄 进行中]\x1b[0m'
        case 'SKIPPED':
            return '\x1b[36m[⏩ 已跳过]\x1b[0m'
        case 'WAITING':
        default:
            return '\x1b[90m[⏳ 等待中]\x1b[0m'
    }
}

function formatDuration(ms) {
    const totalSec = Math.floor(ms / 1000)
    const min = Math.floor(totalSec / 60)
    const sec = totalSec % 60
    return `${min}分 ${sec.toString().padStart(2, '0')}秒`
}

const allTasks = [
    state.checkIn,
    state.dailySet,
    state.promotions,
    state.readToEarn,
    state.desktopSearch,
    state.mobileSearch
]

function render() {
    const elapsed = formatDuration(Date.now() - state.startTime)
    const pointsStr = state.totalPoints > 0 ? `\x1b[1;33m${state.totalPoints.toLocaleString()} 分\x1b[0m` : '读取中...'
    const lifetimeStr = state.lifetimePoints > 0 ? `${state.lifetimePoints.toLocaleString()} 分` : '读取中...'

    const promoMatch = (state.promotions.points || '').match(/(\d+)/)
    const promoEarned = promoMatch ? parseInt(promoMatch[1], 10) : 0
    const pcMatch = (state.desktopSearch.points || '').match(/(\d+)/)
    const pcEarned = pcMatch ? parseInt(pcMatch[1], 10) : 0
    const mbMatch = (state.mobileSearch.points || '').match(/(\d+)/)
    const mbEarned = mbMatch ? parseInt(mbMatch[1], 10) : 0
    
    const taskPointsSum =
        (state.checkIn.status === 'DONE' ? 5 : 0) +
        (state.dailySet.status === 'DONE' ? 30 : 0) +
        (state.readToEarn.status === 'DONE' ? 30 : 0) +
        promoEarned + pcEarned + mbEarned

    const totalTodayPoints = Math.max(state.dailyEarned, taskPointsSum, state.todayEarnedTotal || 0)
    const todayEarned = totalTodayPoints > 0 ? `\x1b[1;32m+${totalTodayPoints} 分\x1b[0m` : (state.gainedPoints > 0 ? `\x1b[1;32m+${state.gainedPoints} 分\x1b[0m` : `读取中...`)
    
    // Category Breakdown points
    const shopFormatted = state.shopPoints > 0 ? `\x1b[1;33m+${state.shopPoints.toLocaleString()} 分\x1b[0m` : `+0 分`
    const searchQuotaStr = (state.pcSearchQuota !== '0/0' || state.mobileSearchQuota !== '0/0') ? `${state.pcSearchQuota} | ${state.mobileSearchQuota}` : '150/150 分'
    const dailyTasksStr = `${totalTodayPoints > 0 ? totalTodayPoints : '95'}/95 分`

    const top = `\x1b[1;36m╔${'═'.repeat(BOX_WIDTH + 2)}╗\x1b[0m`
    const mid = `\x1b[1;36m╠${'═'.repeat(BOX_WIDTH + 2)}╣\x1b[0m`
    const bot = `\x1b[1;36m╚${'═'.repeat(BOX_WIDTH + 2)}╝\x1b[0m`

    const out = []
    out.push('\x1b[H') // cursor to top-left
    out.push(top)

    let levelDisplay = '\x1b[90m读取中...\x1b[0m'
    if (state.level && state.level !== '读取中...') {
        levelDisplay = `\x1b[1;32m${state.level}\x1b[0m`
    }

    const monthlyProgressStr = state.levelProgress ? `\x1b[36m${state.levelProgress} (已达标)\x1b[0m` : `\x1b[90m读取中...\x1b[0m`

    // Header section (Account & Points Overview)
    out.push(createBoxLine(`\x1b[1;37m🌟 Microsoft Rewards 自动任务控制台 \x1b[36m(v4.3.1-patch1.7.0)\x1b[0m`))
    out.push(createBoxLine(`👤 账号: \x1b[36m${state.account}\x1b[0m    🎖️ 等级: ${levelDisplay}    💰 可用积分: ${pointsStr}`))
    out.push(createBoxLine(`🕒 耗时: \x1b[90m${elapsed}\x1b[0m    🟢 状态: \x1b[32m${state.currentStatus}\x1b[0m    📈 今日总赚取: ${todayEarned}`))
    out.push(createBoxLine(`\x1b[90m${'─'.repeat(BOX_WIDTH)}\x1b[0m`))
    
    // Detailed Category Breakdown (100% aligned with official Points breakdown modal)
    out.push(createBoxLine(`\x1b[1;37m📊 积分来源明细 (对齐官方 Points breakdown):\x1b[0m`))
    out.push(createBoxLine(`  🔍 \x1b[36m必应搜索 (Bing search):\x1b[0m ${searchQuotaStr}   🎁 \x1b[36m活动与卡片 (Offers):\x1b[0m +${state.offers || 0} 分   🎮 \x1b[36m商城消费:\x1b[0m ${shopFormatted}`))
    out.push(createBoxLine(`  📅 \x1b[36m本月累计 (This month):\x1b[0m ${monthlyProgressStr}   🌟 \x1b[36m终生累计 (Lifetime):\x1b[0m ${lifetimeStr}`))
    out.push(mid)

    // Tasks section (with Points Breakdown column)
    out.push(createBoxLine(`\x1b[1;37m📋 任务进度详情 (含单项积分明细)\x1b[0m`))
    for (const t of allTasks) {
        const badge = getStatusBadge(t.status)
        let bar = ''
        if (t.progress.includes('/')) {
            const [cur, tot] = t.progress.split('/').map(Number)
            if (!isNaN(cur) && !isNaN(tot) && tot > 0) {
                bar = ` [${renderProgressBar(cur, tot, 10)}]`
            }
        }
        const countStr = padVisual(t.progress + '次', 7, 'right')
        const pointsStr = padVisual('(' + (t.points || '0分') + ')', 11, 'right')
        const lineContent = `  ${badge} ${padVisual(t.name, 28)} ${countStr} ${pointsStr}${bar}  ${t.info}`
        out.push(createBoxLine(lineContent))
    }
    out.push(mid)

    // Action section
    out.push(createBoxLine(`\x1b[1;37m🔍 实时动作与延时监控\x1b[0m`))
    let countdownText = ''
    if (state.countdownSec > 0) {
        countdownText = ` \x1b[1;33m(⏳ 防封冷却: 剩余 ${state.countdownSec}s)\x1b[0m`
    }
    out.push(createBoxLine(`  👉 \x1b[1;36m${state.currentAction}\x1b[0m${countdownText}`))
    out.push(mid)

    // Logs section
    out.push(createBoxLine(`\x1b[1;37m📜 最新事件日志\x1b[0m`))
    const displayLogs = state.logs.slice(-4)
    while (displayLogs.length < 4) {
        displayLogs.unshift('\x1b[90m...\x1b[0m')
    }
    for (const l of displayLogs) {
        out.push(createBoxLine(`  ${l}`))
    }
    out.push(bot)

    if (isFinished) {
        out.push('  \x1b[1;32m🎉 提示: 任务已完成！按 [Enter]、[q] 或 [Ctrl + C] 退出看板\x1b[0m')
    } else {
        out.push('  \x1b[90m💡 提示: 任务运行中，按 [Ctrl + C] 随时可安全退出看板\x1b[0m')
    }
    out.push('\x1b[J') // Clear extra lines

    process.stdout.write(out.join('\n'))
}

// Start timer tick to update UI smoothly
const uiInterval = setInterval(() => {
    if (state.countdownSec > 0) {
        state.countdownSec--
    }
    render()
}, 1000)

function formatThemeTitle(rawTitle) {
    if (!rawTitle) return '主题探索'
    const clean = rawTitle.replace(/[\u200B-\u200D\uFEFF]/g, '').trim()
    const map = {
        'Catch the show': '演出门票 (Catch the show)',
        'Check options': '家庭宽带 (Check options)',
        'Drive your way': '租车自驾 (Drive your way)',
        'Park with ease': '机场停车 (Park with ease)',
        'Relax completely': '度假酒店 (Relax completely)',
        'Bank smarter': '银行金融 (Bank smarter)',
        'Set sail': '邮轮度假 (Set sail)'
    }
    return map[clean] || clean
}

function formatShortTheme(rawTitle) {
    if (!rawTitle) return '探索'
    const clean = rawTitle.replace(/[\u200B-\u200D\uFEFF]/g, '').trim()
    const map = {
        'Catch the show': '演出门票',
        'Check options': '家庭宽带',
        'Drive your way': '租车自驾',
        'Park with ease': '机场停车',
        'Relax completely': '度假酒店',
        'Bank smarter': '银行金融',
        'Set sail': '邮轮度假'
    }
    return map[clean] || clean
}

function parseLine(line) {
    // Account start
    const accMatch = line.match(/Starting account:\s+([^\s|]+)/)
    if (accMatch) {
        state.account = accMatch[1]
        state.currentStatus = '已连接，开始执行任务'
        addLog(`载入账号: ${state.account}`)
        saveStateMemory()
    }

    // Genuine Error capture (exclude benign teardown logs and normal skips)
    if (
        (line.includes('[ERROR]') || line.includes('MAIN-ERROR')) &&
        !line.includes('Ignoring benign') &&
        !line.includes('Target page, context or browser has been closed') &&
        !line.includes('CLEANUP')
    ) {
        const cleanMsg = stripAnsi(line).replace(/^.*\[ERROR\]\s*/, '').replace(/^.*\[MAIN-ERROR\]\s*/, '')
        state.currentStatus = `⚠️ 异常: ${truncateVisual(cleanMsg, 28)}`
        addLog(`❌ 出错: ${cleanMsg}`)
    }

    // Points Breakdown event from backend
    const breakdownMatch = line.match(/POINTS-BREAKDOWN\]\s+(\{.*\})/)
    if (breakdownMatch) {
        try {
            const data = JSON.parse(breakdownMatch[1])
            if (data.available) state.totalPoints = data.available
            if (data.lifetime) state.lifetimePoints = data.lifetime
            if (data.dailyEarned !== undefined) state.dailyEarned = data.dailyEarned
            if (data.offers !== undefined) state.offers = data.offers
            if (data.shopPoints !== undefined) state.shopPoints = data.shopPoints
            if (data.level) state.level = data.level
            if (data.levelProgress) state.levelProgress = `月度: ${data.levelProgress}分`
            if (data.pcSearch) {
                state.pcSearchQuota = data.pcSearch
                state.desktopSearch.points = `${data.pcSearch}分`
            }
            if (data.mobileSearch) {
                state.mobileSearchQuota = data.mobileSearch
                state.mobileSearch.points = `${data.mobileSearch}分`
            }
            if (data.dailySet) {
                state.dailySetQuota = data.dailySet
                state.dailySet.points = `${data.dailySet}分`
            }
            if (data.promotions) {
                state.promotionsQuota = data.promotions
                state.promotions.points = `${data.promotions}分`
            }
            if (data.checkIn) state.checkIn.points = `${data.checkIn}分`
            if (data.readToEarn) state.readToEarn.points = `${data.readToEarn}分`
            saveStateMemory()
        } catch (e) {}
    }

    // Mission Discovery event from backend
    const discoveryMatch = line.match(/TASK-DISCOVERY\]\s+(\{.*\})/)
    if (discoveryMatch) {
        try {
            const disc = JSON.parse(discoveryMatch[1])
            if (disc.dailySetPending > 0) {
                state.dailySet.status = 'RUNNING'
                state.dailySet.progress = `${disc.dailySetTotal - disc.dailySetPending}/${disc.dailySetTotal}`
                state.dailySet.info = `${disc.dailySetPending} 项待做`
                addLog(`🔍 发现 Daily Set: ${disc.dailySetPending} 项待完成`)
            } else {
                state.dailySet.status = 'DONE'
                state.dailySet.progress = '3/3'
                state.dailySet.points = '30/30分'
                state.dailySet.info = '今日已全部完成 (跳过)'
            }
            if (disc.promoPending > 0) {
                state.promotions.status = 'RUNNING'
                state.promotions.progress = `${disc.promoTotal - disc.promoPending}/${disc.promoTotal}`
                state.promotions.info = `${disc.promoPending} 项待做`
                addLog(`🔍 发现活动推广: ${disc.promoPending} 项待完成`)
            } else {
                state.promotions.status = 'DONE'
                state.promotions.info = '今日已全部完成 (跳过)'
            }
            saveStateMemory()
        } catch (e) {}
    }

    // Points balance update
    const balMatch = line.match(/currentBalance=(\d+)/)
    if (balMatch) {
        const bal = parseInt(balMatch[1], 10)
        if (state.startPoints === 0) {
            state.startPoints = bal
        }
        if (!state.dayStartBalance || state.dayStartBalance === 0) {
            state.dayStartBalance = bal
        } else if (bal > state.dayStartBalance) {
            state.todayEarnedTotal = bal - state.dayStartBalance
        }
        state.totalPoints = bal
        state.gainedPoints = Math.max(0, bal - state.startPoints)
        saveStateMemory()
    }

    // 1. Daily Set (每日任务卡)
    const dailySetStart = line.match(/Started solving "Daily Set" items\s+\|\s+remaining=(\d+)/)
    if (dailySetStart) {
        state.dailySet.status = 'RUNNING'
        state.dailySet.progress = `0/${dailySetStart[1]}`
        state.dailySet.info = `正在自动答题与点击 (${dailySetStart[1]} 项待做)`
        state.currentAction = `正在执行每日任务卡 (共 ${dailySetStart[1]} 项)...`
        addLog(`开始执行每日任务三项 (Daily Set)...`)
        saveStateMemory()
    }
    if (
        line.includes('All "Daily Set" items have already been completed') ||
        line.includes('Finished processing "Daily Set" items')
    ) {
        state.dailySet.status = 'DONE'
        state.dailySet.progress = '3/3'
        state.dailySet.points = '30/30分'
        state.dailySet.info = '今日已全部完成 (已达标)'
        state.currentAction = '每日任务卡已全部完成，跳过进入下一步...'
        addLog('每日任务卡 (Daily Set): 今日已完成')
        saveStateMemory()
    }

    // 2. Daily Check-In (每日签到)
    if (line.includes('[DAILY-CHECK-IN] Starting')) {
        state.checkIn.status = 'RUNNING'
        state.checkIn.info = '正在签到...'
        state.currentAction = '执行每日自动签到...'
    }
    if (line.includes('[DAILY-CHECK-IN] Completed') || line.includes('Daily Check-In completed')) {
        state.checkIn.status = 'DONE'
        state.checkIn.progress = '1/1'
        state.checkIn.points = '5/5 分'
        state.checkIn.info = '今日已签到 (已完成)'
        addLog('每日签到: 今日已完成')
        saveStateMemory()
    }

    // 3. Promotions & App Promotions (活动与推广)
    if (line.includes('All "App Promotions" items have already been completed') || line.includes('All "More Promotions" items have already been completed')) {
        state.promotions.status = 'DONE'
        state.promotions.points = '30/30分'
        state.promotions.info = '今日已全部完成 (跳过)'
        state.currentAction = '活动与推广任务已全部完成，跳过进入下一步...'
        addLog('活动与推广: 今日已完成，跳过')
        saveStateMemory()
    }
    const appMatch = line.match(/Started solving "(?:App|More) Promotions" items\s+\|\s+remaining=(\d+)/)
    if (appMatch) {
        state.promotions.status = 'RUNNING'
        state.promotions.totalCards = parseInt(appMatch[1], 10)
        state.promotions.completedCards = 0
        state.promotions.progress = `0/${state.promotions.totalCards}`
        state.promotions.info = `共 ${state.promotions.totalCards} 张 Explore on Bing 卡片待完成`
    }
    const startingSearchMatch = line.match(/(?:Starting SearchOnBing|Found activity type "[^"]+")\s+\|\s+(?:offerId=[^\s|]+\s+\|\s+)?title="([^"]+)"/)
    if (startingSearchMatch) {
        state.promotions.currentTitle = startingSearchMatch[1]
        const pretty = formatThemeTitle(startingSearchMatch[1])
        const shortName = formatShortTheme(startingSearchMatch[1])
        const cardNum = (state.promotions.completedCards || 0) + 1
        const totCards = state.promotions.totalCards || 3
        state.promotions.info = `[${cardNum}/${totCards} ${shortName}] 准备开始`
        state.currentAction = `开启 Explore on Bing 探索卡片: "${pretty}"`
        addLog(`进入探索主题: "${pretty}"`)
    }
    const appRewardMatch = line.match(/Completed AppReward\s+\|\s+offerId=([^\s|]+)\s+\|\s+pointsGained=(\d+)/)
    if (appRewardMatch) {
        state.promotions.completedCards = (state.promotions.completedCards || 0) + 1
        state.promotions.progress = `${state.promotions.completedCards}/${state.promotions.totalCards || 3}`
        addLog(`完成推广任务: +${appRewardMatch[2]}分`)
        saveStateMemory()
    }
    if (line.includes('SearchOnBing activity completed')) {
        const pretty = formatThemeTitle(state.promotions.currentTitle)
        state.promotions.completedCards = (state.promotions.completedCards || 0) + 1
        state.promotions.progress = `${state.promotions.completedCards}/${state.promotions.totalCards || 3}`
        state.promotions.points = `${(state.promotions.completedCards || 0) * 10}/${(state.promotions.totalCards || 3) * 10}分`
        addLog(`✅ 探索卡片 [${state.promotions.completedCards}/${state.promotions.totalCards || 3}] "${pretty}" 完成 (+10分)`)
        saveStateMemory()
    }
    if (line.includes('Finished processing "App Promotions" items') || line.includes('Finished processing "More Promotions" items')) {
        state.promotions.status = 'DONE'
        state.promotions.progress = `${state.promotions.totalCards || 3}/${state.promotions.totalCards || 3}`
        state.promotions.points = '30/30分'
        state.promotions.info = `共 ${state.promotions.totalCards || 3} 项已全部完成`
        saveStateMemory()
    }

    // 3.1 Promotional Search on Bing (活动卡片中的必应搜索任务)
    const promoSearchMatch = line.match(/SEARCH-ON-BING-SEARCH\]\s+(\d+)\/(\d+).*query="([^"]+)"/)
    if (promoSearchMatch) {
        const cur = promoSearchMatch[1]
        const tot = promoSearchMatch[2]
        const cardNum = (state.promotions.completedCards || 0) + 1
        const totCards = state.promotions.totalCards || 3
        const pretty = formatThemeTitle(state.promotions.currentTitle)
        const shortName = formatShortTheme(state.promotions.currentTitle)
        state.promotions.status = 'RUNNING'
        state.promotions.progress = `${state.promotions.completedCards || 0}/${totCards}`
        state.promotions.info = `[${cardNum}/${totCards} ${shortName}] 搜索中 (${cur}/${tot})`
        state.currentAction = `[${cardNum}/${totCards} 探索 "${pretty}"] 搜索 [${cur}/${tot}]: "${promoSearchMatch[3]}"`
        state.countdownSec = 10
        addLog(`[${shortName} ${cur}/${tot}] 搜索: "${promoSearchMatch[3]}"`)
    }

    // 4. Read to Earn (必应新闻阅读)
    if (line.includes('No points gained, stopping Read to Earn')) {
        state.readToEarn.status = 'DONE'
        state.readToEarn.progress = '10/10'
        state.readToEarn.points = '30/30分'
        state.readToEarn.info = '今日已满 (跳过)'
        state.currentAction = '新闻阅读今日已满，跳过进入下一步...'
        addLog('必应新闻阅读: 今日已达上限，跳过')
        saveStateMemory()
    }
    const readMatch = line.match(/Read article (\d+)\/(\d+)\s+\|\s+status=200\s+\|\s+pointsGained=(\d+)/)
    if (readMatch) {
        const cur = parseInt(readMatch[1], 10)
        const tot = parseInt(readMatch[2], 10)
        state.readToEarn.status = 'RUNNING'
        state.readToEarn.progress = `${cur}/${tot}`
        state.readToEarn.points = `${cur * 3}/${tot * 3}分`
        state.readToEarn.info = `已读 ${cur}/${tot} 篇 (+3分/篇)`
        state.currentAction = `正在阅读必应新闻 ${cur}/${tot}...`
        state.countdownSec = 20
        addLog(`读新闻 (${cur}/${tot}) 成功: +${readMatch[3]}分`)
        saveStateMemory()
    }
    if (line.includes('Finished Read to Earn') || line.includes('Read to Earn completed')) {
        state.readToEarn.status = 'DONE'
        state.readToEarn.progress = '10/10'
        state.readToEarn.points = '30/30分'
        state.readToEarn.info = '10篇已全部读完 (+30分)'
        saveStateMemory()
    }

    // 5. Desktop & Mobile Search Quotas
    const desktopQuotaMatch = line.match(/Desktop:\s*(skip|run)\s*\((?:complete,\s*)?(\d+)\/(\d+)/i)
    if (desktopQuotaMatch) {
        const isSkip = desktopQuotaMatch[1].toLowerCase() === 'skip'
        const earned = parseInt(desktopQuotaMatch[2], 10)
        const max = parseInt(desktopQuotaMatch[3], 10)
        const cur = Math.floor(earned / 3)
        const tot = Math.floor(max / 3)
        state.desktopSearch.progress = `${cur}/${tot}`
        state.desktopSearch.points = `${earned}/${max}分`
        if (isSkip || earned >= max) {
            state.desktopSearch.status = 'DONE'
            state.desktopSearch.info = '今日配额已满 (跳过)'
            state.currentAction = 'PC 桌面端搜索今日已满，直接进入下一步...'
            addLog('PC 桌面端搜索: 今日配额已满，跳过')
        } else {
            state.desktopSearch.status = 'RUNNING'
            state.desktopSearch.info = `待执行 ${tot - cur} 次`
        }
        saveStateMemory()
    }

    const mobileQuotaMatch = line.match(/Mobile:\s*(skip|run)\s*\((?:complete,\s*)?(\d+)\/(\d+)/i)
    if (mobileQuotaMatch) {
        const isSkip = mobileQuotaMatch[1].toLowerCase() === 'skip'
        const earned = parseInt(mobileQuotaMatch[2], 10)
        const max = parseInt(mobileQuotaMatch[3], 10)
        const cur = Math.floor(earned / 3)
        const tot = Math.floor(max / 3)
        state.mobileSearch.progress = `${cur}/${tot}`
        state.mobileSearch.points = `${earned}/${max}分`
        if (isSkip || earned >= max) {
            state.mobileSearch.status = 'DONE'
            state.mobileSearch.info = '今日配额已满 (跳过)'
            state.currentAction = '移动端搜索今日已满，直接进入下一步...'
            addLog('Mobile 移动端搜索: 今日配额已满，跳过')
        } else {
            state.mobileSearch.status = 'RUNNING'
            state.mobileSearch.info = `待执行 ${tot - cur} 次`
        }
        saveStateMemory()
    }

    // 5.1 Desktop & Mobile Regular Search Action (常规日常搜索)
    const regularSearchMatch = line.match(/(?:\[DESKTOP\]|\[MOBILE\])\s+\[(?:SEARCH-BING|SEARCH-MOBILE|SEARCH-BING-SEARCH)\]\s+.*query="([^"]+)"\s+\|\s+(?:\[?(\d+)\/(\d+)\]?|progress=(\d+)\/(\d+))/)
    if (regularSearchMatch) {
        const isMobile = line.includes('[MOBILE]')
        const query = regularSearchMatch[1]
        const cur = parseInt(regularSearchMatch[2] || regularSearchMatch[4] || '1', 10)
        const tot = parseInt(regularSearchMatch[3] || regularSearchMatch[5] || (isMobile ? '20' : '30'), 10)
        
        if (isMobile) {
            state.mobileSearch.progress = `${cur}/${tot}`
            state.mobileSearch.points = `${cur * 3}/${tot * 3}分`
            if (cur >= tot) {
                state.mobileSearch.status = 'DONE'
                state.mobileSearch.info = '手机搜索已全部完成'
            } else {
                state.mobileSearch.status = 'RUNNING'
                state.mobileSearch.info = `移动搜索中 (${cur}/${tot})`
            }
            state.currentAction = `手机搜索 [${cur}/${tot}]: "${query}"`
            addLog(`手机搜索: "${query}"`)
        } else {
            state.desktopSearch.progress = `${cur}/${tot}`
            state.desktopSearch.points = `${cur * 3}/${tot * 3}分`
            if (cur >= tot) {
                state.desktopSearch.status = 'DONE'
                state.desktopSearch.info = 'PC 搜索已全部完成'
            } else {
                state.desktopSearch.status = 'RUNNING'
                state.desktopSearch.info = `PC 搜索中 (${cur}/${tot})`
            }
            state.currentAction = `PC 搜索 [${cur}/${tot}]: "${query}"`
            addLog(`PC 搜索: "${query}"`)
        }
        state.countdownSec = 10
        saveStateMemory()
    }

    // Overall Completion
    if (line.includes('Account summary:') || line.includes('Execution completed') || line.includes('Finished run') || line.includes('[MAIN] [RUN-END]')) {
        state.currentStatus = '🎉 今日所有任务已全部完成！'
        state.currentAction = '所有积分已成功入账，自动化结束。'
        state.countdownSec = 0
        allTasks.forEach(t => {
            if (t.status === 'RUNNING' || t.status === 'WAITING') {
                t.status = 'DONE'
                if (t === state.dailySet) {
                    t.progress = '3/3'
                    t.points = '30/30分'
                    t.info = '今日已全部完成 (跳过)'
                }
                if (!t.info.includes('完成') && !t.info.includes('满')) t.info = '已完成'
            }
        })
        addLog('🎉 今日任务全部圆满完成！')
        saveStateMemory()
    }
}

// Spawn child process
const child = spawn('node', ['./dist/index.js'], {
    cwd: projectRoot,
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe']
})

const rlOut = readline.createInterface({ input: child.stdout })
rlOut.on('line', (line) => parseLine(line))

const rlErr = readline.createInterface({ input: child.stderr })
rlErr.on('line', (line) => parseLine(line))

function cleanExit(code = 0) {
    clearInterval(uiInterval)
    saveStateMemory()
    process.stdout.write('\x1b[?1049l\x1b[?25h\n')
    process.exit(code)
}

child.on('close', (code) => {
    isFinished = true
    state.countdownSec = 0
    if (code === 0) {
        state.currentStatus = '🎉 今日所有任务已圆满完成！'
        state.currentAction = '所有积分已成功入账。按 [Enter] 或 [q] 退出看板。'
    } else {
        state.currentStatus = `⚠️ 任务结束 (退出码 ${code})`
        state.currentAction = '请查看上方明细与下方日志。按 [Enter] 或 [q] 退出看板。'
    }
    render()
    saveStateMemory()
})

if (process.stdin.isTTY) {
    readline.emitKeypressEvents(process.stdin)
    process.stdin.setRawMode(true)
    process.stdin.on('keypress', (str, key) => {
        if (key && (key.ctrl && key.name === 'c')) {
            cleanExit(0)
        } else if (isFinished) {
            cleanExit(0)
        }
    })
}

process.on('SIGINT', () => {
    cleanExit(0)
})
