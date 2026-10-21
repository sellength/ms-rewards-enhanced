import fs from 'node:fs'
import path from 'node:path'
import { spawn, type ChildProcess } from 'node:child_process'

export interface SleepInhibitorStatus {
    active: boolean
    delegatedToHost: boolean
    platform: string
    method: string
    targetPid: number
}

const TASK_RUNNING_FILENAME = '.task_running.json'

function isRunningInContainer(): boolean {
    if (process.env.DOCKER_CONTAINER === 'true' || process.env.DOCKER_CONTAINER === '1') {
        return true
    }
    if (process.platform === 'linux') {
        try {
            if (fs.existsSync('/.dockerenv') || fs.existsSync('/run/.containerenv')) {
                return true
            }
        } catch {
            // Ignore filesystem probe errors
        }
    }
    return false
}

export class SystemSleepInhibitor {
    private child: ChildProcess | null = null
    private heartbeatTimer: ReturnType<typeof setInterval> | null = null
    private method = 'none'
    private ownsTaskStateFile = false

    private getTaskRunningFilePath(): string {
        const sessionDir = process.env.MS_SESSION_DIR || path.join(process.cwd(), 'sessions')
        return path.join(sessionDir, TASK_RUNNING_FILENAME)
    }

    private writeTaskRunningState(targetPid: number): void {
        if (!this.ownsTaskStateFile) return
        try {
            const filePath = this.getTaskRunningFilePath()
            fs.mkdirSync(path.dirname(filePath), { recursive: true })
            fs.writeFileSync(
                filePath,
                JSON.stringify({
                    active: true,
                    reason: process.env.REWARDS_MODE || 'cli',
                    targetPid,
                    startedAt: Date.now(),
                    updatedAt: Date.now()
                }),
                'utf-8'
            )
        } catch {
            // Best-effort state file update
        }
    }

    private removeTaskRunningState(): void {
        if (!this.ownsTaskStateFile) return
        this.ownsTaskStateFile = false
        try {
            const filePath = this.getTaskRunningFilePath()
            if (fs.existsSync(filePath)) {
                fs.unlinkSync(filePath)
            }
        } catch {
            // Ignore cleanup errors
        }
    }

    private startHeartbeat(targetPid: number): void {
        this.stopHeartbeat()
        this.ownsTaskStateFile = true
        this.writeTaskRunningState(targetPid)
        this.heartbeatTimer = setInterval(() => {
            this.writeTaskRunningState(targetPid)
        }, 10 * 1000)
        this.heartbeatTimer.unref?.()
    }

    private stopHeartbeat(): void {
        if (this.heartbeatTimer) {
            clearInterval(this.heartbeatTimer)
            this.heartbeatTimer = null
        }
    }

    public acquire(targetPid: number = process.pid): SleepInhibitorStatus {
        this.release()

        const platform = process.platform
        const safePid = Math.max(1, Math.trunc(targetPid) || process.pid)

        if (process.env.REWARDS_SLEEP_INHIBITED_BY_PARENT === '1') {
            this.method = 'parent-managed'
            return {
                active: false,
                delegatedToHost: true,
                platform,
                method: this.method,
                targetPid: safePid
            }
        }

        this.startHeartbeat(safePid)

        if (isRunningInContainer()) {
            this.method = 'container-delegated'
            return {
                active: false,
                delegatedToHost: true,
                platform,
                method: this.method,
                targetPid: safePid
            }
        }

        try {
            if (platform === 'darwin') {
                this.method = 'caffeinate'
                this.child = spawn('caffeinate', ['-i', '-s', '-w', String(safePid)], {
                    stdio: 'ignore',
                    windowsHide: true
                })
            } else if (platform === 'win32') {
                this.method = 'win32-execution-state'
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
                this.child = spawn(
                    'powershell.exe',
                    ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', psScript],
                    { stdio: 'ignore', windowsHide: true }
                )
            } else if (platform === 'linux') {
                this.method = 'systemd-inhibit'
                this.child = spawn(
                    'systemd-inhibit',
                    [
                        '--what=sleep:idle',
                        '--who=ms-rewards-enhanced',
                        '--why=Running Microsoft Rewards automation task',
                        '--mode=block',
                        'sh',
                        '-c',
                        `while kill -0 ${safePid} 2>/dev/null; do sleep 2; done`
                    ],
                    { stdio: 'ignore', windowsHide: true }
                )
            }

            if (this.child) {
                const currentChild = this.child
                currentChild.on('error', () => {
                    if (this.child === currentChild) {
                        this.child = null
                    }
                })
                currentChild.on('exit', () => {
                    if (this.child === currentChild) {
                        this.child = null
                    }
                })
                currentChild.unref()
                return {
                    active: true,
                    delegatedToHost: false,
                    platform,
                    method: this.method,
                    targetPid: safePid
                }
            }
        } catch {
            this.child = null
        }

        return {
            active: false,
            delegatedToHost: false,
            platform,
            method: this.method,
            targetPid: safePid
        }
    }

    public release(): void {
        this.stopHeartbeat()
        this.removeTaskRunningState()
        if (!this.child) return
        const proc = this.child
        this.child = null
        try {
            proc.kill('SIGTERM')
        } catch {
            // Ignore kill errors if process already exited
        }
    }
}
