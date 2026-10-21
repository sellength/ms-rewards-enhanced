#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
    createSleepInhibitor,
    readFreshJsonState,
    TASK_RUNNING_STATE_FILENAME,
    HOST_GUARD_STATE_FILENAME,
    TASK_STATE_TTL_MS
} from '../api/sleepInhibitor.mjs'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const projectRoot = path.resolve(__dirname, '../..')

const sessionDir = process.env.MS_SESSION_DIR || path.join(projectRoot, 'sessions')
const taskFilePath = path.join(sessionDir, TASK_RUNNING_STATE_FILENAME)
const hostGuardFilePath = path.join(sessionDir, HOST_GUARD_STATE_FILENAME)

const inhibitor = createSleepInhibitor({
    platform: process.platform,
    env: { ...process.env, DOCKER_CONTAINER: 'false' },
    stateDir: null // Do not overwrite .task_running.json from the host watcher
})

let holdingLock = false
let lastHeartbeatWriteAt = 0

function writeHostGuardStatus(active, info = {}) {
    try {
        fs.mkdirSync(sessionDir, { recursive: true })
        fs.writeFileSync(
            hostGuardFilePath,
            JSON.stringify({
                active: Boolean(active),
                daemonReady: true,
                platform: process.platform,
                method: info.method || (process.platform === 'darwin' ? 'caffeinate' : (process.platform === 'win32' ? 'win32-execution-state' : 'systemd-inhibit')),
                inhibitorPid: info.inhibitorPid || null,
                updatedAt: Date.now()
            }),
            'utf-8'
        )
        lastHeartbeatWriteAt = Date.now()
    } catch (_) {}
}

function removeHostGuardStatus() {
    try {
        if (fs.existsSync(hostGuardFilePath)) {
            fs.unlinkSync(hostGuardFilePath)
        }
    } catch (_) {}
}

function tick() {
    const taskState = readFreshJsonState(taskFilePath, TASK_STATE_TTL_MS)
    const shouldHoldLock = Boolean(taskState && taskState.active)

    if (shouldHoldLock && !holdingLock) {
        const res = inhibitor.acquire({
            targetPid: process.pid,
            reason: taskState.reason || 'docker-task'
        })
        holdingLock = Boolean(res.active)
        writeHostGuardStatus(holdingLock, res)
        console.log(
            `[${new Date().toLocaleTimeString()}] [host-sleep-guard] 🛡️ 检测到任务运行 (${taskState.reason || 'task'})，已激活宿主机防系统休眠锁 (${res.platform}/${res.method}，允许熄屏与锁屏)`
        )
    } else if (!shouldHoldLock && holdingLock) {
        inhibitor.release()
        holdingLock = false
        writeHostGuardStatus(false)
        console.log(
            `[${new Date().toLocaleTimeString()}] [host-sleep-guard] 🔋 任务已完成，已释放宿主机防系统休眠锁，恢复系统正常睡眠`
        )
    } else if (Date.now() - lastHeartbeatWriteAt >= 12 * 1000) {
        const cur = inhibitor.status()
        writeHostGuardStatus(holdingLock, cur)
    }
}

function shutdown() {
    if (holdingLock) {
        inhibitor.release()
        holdingLock = false
    }
    removeHostGuardStatus()
    process.exit(0)
}

process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)

console.log(
    `[${new Date().toLocaleTimeString()}] [host-sleep-guard] 🚀 宿主机按需防休眠守护已就绪 (监听目录: ${sessionDir})`
)
tick()
setInterval(tick, 2000)
