import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'

export const TASK_RUNNING_STATE_FILENAME = '.task_running.json'
export const HOST_GUARD_STATE_FILENAME = '.host_sleep_guard.json'
export const TASK_STATE_TTL_MS = 45 * 1000

export function isContainerEnvironment({
    platform = process.platform,
    env = process.env,
    existsSync = fs.existsSync
} = {}) {
    if (env?.DOCKER_CONTAINER === 'true' || env?.DOCKER_CONTAINER === '1') {
        return true
    }
    if (platform === 'linux') {
        try {
            if (existsSync('/.dockerenv') || existsSync('/run/.containerenv')) {
                return true
            }
        } catch (_) {}
    }
    return false
}

export function buildInhibitorCommand({
    platform = process.platform,
    targetPid = process.pid
} = {}) {
    const safePid = Math.max(1, Number.parseInt(String(targetPid), 10) || process.pid)

    if (platform === 'darwin') {
        // -i: Prevent idle system sleep (PreventUserIdleSystemSleep)
        // -s: Prevent system sleep on AC power when display is off
        // Intentionally NO -d flag: allows display sleep (熄屏) and screen lock (锁屏)
        // -w <pid>: Automatically exit when the target task process exits
        return {
            method: 'caffeinate',
            command: 'caffeinate',
            args: ['-i', '-s', '-w', String(safePid)]
        }
    }

    if (platform === 'win32') {
        // ES_CONTINUOUS (0x80000000) | ES_SYSTEM_REQUIRED (0x00000001) = 0x80000001
        // Intentionally NO ES_DISPLAY_REQUIRED (0x00000002): allows display off & lock screen
        const psScript = [
            `Add-Type -MemberDefinition '[DllImport("kernel32.dll")] public static extern uint SetThreadExecutionState(uint esFlags);' -Name 'Power' -Namespace 'Win32';`,
            `[Win32.Power]::SetThreadExecutionState(0x80000001) | Out-Null;`,
            `try {`,
            `  while ($true) {`,
            `    Start-Sleep -Seconds 3;`,
            `    if (-not (Get-Process -Id ${safePid} -ErrorAction SilentlyContinue)) { break }`,
            `  }`,
            `} finally {`,
            `  [Win32.Power]::SetThreadExecutionState(0x80000000) | Out-Null`,
            `}`
        ].join(' ')

        return {
            method: 'win32-execution-state',
            command: 'powershell.exe',
            args: ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', psScript]
        }
    }

    if (platform === 'linux') {
        // Only inhibit sleep:idle (system suspend/sleep), allowing desktop screen lock & DPMS off
        return {
            method: 'systemd-inhibit',
            command: 'systemd-inhibit',
            args: [
                '--what=sleep:idle',
                '--who=ms-rewards-enhanced',
                '--why=Running Microsoft Rewards automation task',
                '--mode=block',
                'sh',
                '-c',
                `while kill -0 ${safePid} 2>/dev/null; do sleep 2; done`
            ]
        }
    }

    return null
}

export function readFreshJsonState(filePath, ttlMs = TASK_STATE_TTL_MS) {
    if (!filePath) return null
    try {
        if (!fs.existsSync(filePath)) return null
        const raw = fs.readFileSync(filePath, 'utf-8')
        const data = JSON.parse(raw)
        if (!data || typeof data !== 'object') return null
        const updatedAt = Number(data.updatedAt) || 0
        if (Date.now() - updatedAt > ttlMs) return null
        return data
    } catch (_) {
        return null
    }
}

export function createSleepInhibitor({
    platform = process.platform,
    env = process.env,
    spawnFn = spawn,
    existsSyncFn = fs.existsSync,
    stateDir = null
} = {}) {
    let childProcess = null
    let heartbeatTimer = null
    let activeStateDir = stateDir
    let currentState = {
        active: false,
        delegatedToHost: false,
        degraded: false,
        platform,
        method: 'none',
        reason: null,
        targetPid: null,
        inhibitorPid: null,
        startedAt: null,
        error: null
    }

    function getTaskRunningFilePath() {
        const dir = activeStateDir || env?.MS_SESSION_DIR
        return dir ? path.join(dir, TASK_RUNNING_STATE_FILENAME) : null
    }

    function getHostGuardFilePath() {
        const dir = activeStateDir || env?.MS_SESSION_DIR
        return dir ? path.join(dir, HOST_GUARD_STATE_FILENAME) : null
    }

    function writeTaskStateFile() {
        const filePath = getTaskRunningFilePath()
        if (!filePath) return
        try {
            fs.mkdirSync(path.dirname(filePath), { recursive: true })
            fs.writeFileSync(
                filePath,
                JSON.stringify({
                    active: true,
                    reason: currentState.reason || 'task',
                    targetPid: currentState.targetPid || process.pid,
                    startedAt: currentState.startedAt || Date.now(),
                    updatedAt: Date.now()
                }),
                'utf-8'
            )
        } catch (_) {}
    }

    function removeTaskStateFile() {
        const filePath = getTaskRunningFilePath()
        if (!filePath) return
        try {
            if (fs.existsSync(filePath)) {
                fs.unlinkSync(filePath)
            }
        } catch (_) {}
    }

    function stopHeartbeat() {
        if (heartbeatTimer) {
            clearInterval(heartbeatTimer)
            heartbeatTimer = null
        }
    }

    function startHeartbeat() {
        stopHeartbeat()
        writeTaskStateFile()
        heartbeatTimer = setInterval(() => {
            writeTaskStateFile()
        }, 10 * 1000)
        heartbeatTimer.unref?.()
    }

    function release() {
        stopHeartbeat()
        removeTaskStateFile()
        const proc = childProcess
        childProcess = null
        const wasActive = currentState.active || currentState.delegatedToHost
        currentState = {
            active: false,
            delegatedToHost: false,
            degraded: false,
            platform,
            method: 'none',
            reason: null,
            targetPid: null,
            inhibitorPid: null,
            startedAt: null,
            error: null
        }
        if (proc) {
            try {
                proc.kill('SIGTERM')
            } catch (_) {}
        }
        return wasActive
    }

    function acquire({ targetPid = process.pid, reason = 'task', sessionDir = null } = {}) {
        if (childProcess || heartbeatTimer) {
            release()
        }
        if (sessionDir) {
            activeStateDir = sessionDir
        }

        const startedAt = Date.now()

        if (isContainerEnvironment({ platform, env, existsSync: existsSyncFn })) {
            currentState = {
                active: false,
                delegatedToHost: true,
                degraded: false,
                platform,
                method: 'container-delegated',
                reason,
                targetPid,
                inhibitorPid: null,
                startedAt,
                error: null
            }
            startHeartbeat()
            return status()
        }

        const spec = buildInhibitorCommand({ platform, targetPid })
        if (!spec) {
            currentState = {
                active: false,
                delegatedToHost: false,
                degraded: true,
                platform,
                method: 'unsupported',
                reason,
                targetPid,
                inhibitorPid: null,
                startedAt: null,
                error: `Unsupported platform: ${platform}`
            }
            return status()
        }

        try {
            const proc = spawnFn(spec.command, spec.args, {
                stdio: 'ignore',
                windowsHide: true
            })
            childProcess = proc

            currentState = {
                active: true,
                delegatedToHost: false,
                degraded: false,
                platform,
                method: spec.method,
                reason,
                targetPid,
                inhibitorPid: proc?.pid || null,
                startedAt,
                error: null
            }

            startHeartbeat()

            proc.on?.('error', (err) => {
                if (childProcess === proc) {
                    childProcess = null
                    currentState = {
                        ...currentState,
                        active: false,
                        degraded: true,
                        inhibitorPid: null,
                        error: err?.message || 'spawn_error'
                    }
                }
            })

            proc.on?.('exit', () => {
                if (childProcess === proc) {
                    childProcess = null
                    currentState = {
                        ...currentState,
                        active: false,
                        inhibitorPid: null
                    }
                }
            })

            proc.unref?.()
        } catch (err) {
            childProcess = null
            currentState = {
                active: false,
                delegatedToHost: false,
                degraded: true,
                platform,
                method: spec.method,
                reason,
                targetPid,
                inhibitorPid: null,
                startedAt: null,
                error: err?.message || 'spawn_failed'
            }
        }

        return status()
    }

    function status() {
        const hostGuard = readFreshJsonState(getHostGuardFilePath(), TASK_STATE_TTL_MS)
        return {
            ...currentState,
            hostGuardActive: Boolean(currentState.active || hostGuard?.active),
            hostGuardPlatform: currentState.active ? currentState.platform : (hostGuard?.platform || null),
            hostGuardMethod: currentState.active ? currentState.method : (hostGuard?.method || null)
        }
    }

    return {
        acquire,
        release,
        status
    }
}
