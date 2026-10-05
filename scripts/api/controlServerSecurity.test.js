import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import http from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import fs from 'node:fs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const projectRoot = path.resolve(__dirname, '../..')
const globalTrackedBotPids = new Set()

function isProcessAlive(pid) {
    if (!pid || typeof pid !== 'number') return false
    try {
        process.kill(pid, 0)
        return true
    } catch {
        return false
    }
}

process.on('exit', () => {
    for (const pid of globalTrackedBotPids) {
        try { process.kill(-pid, 'SIGKILL') } catch (_) {}
        try { process.kill(pid, 'SIGKILL') } catch (_) {}
    }
})

// 辅助函数：启动真实的 server.js 实例并等待其就绪
function launchServer({ token, port }) {
    return new Promise((resolve, reject) => {
        const dummyScript = path.join(__dirname, 'testDummyBot.js')
        assert.ok(fs.existsSync(dummyScript), 'testDummyBot.js 必须存在，以杜绝任何启动生产脚本的可能')

        const env = {
            ...process.env,
            API_HOST: '127.0.0.1',
            API_PORT: String(port),
            API_RUN_COMMAND: process.execPath,
            API_RUN_ARGS: JSON.stringify([dummyScript])
        }
        if (token === undefined) {
            env.API_TOKEN = ''
        } else {
            env.API_TOKEN = token
        }

        const args = [
            path.join(__dirname, 'server.js'),
            '--host', '127.0.0.1',
            '--port', String(port),
            '--token', token === undefined ? '' : token
        ]

        const proc = spawn('node', args, {
            cwd: projectRoot,
            env,
            detached: true,
            stdio: ['ignore', 'pipe', 'pipe']
        })

        const trackedBotPids = new Set()
        let ready = false
        let stdout = ''

        const timeout = setTimeout(() => {
            if (!ready) {
                try {
                    process.kill(-proc.pid, 'SIGKILL')
                } catch {
                    proc.kill('SIGKILL')
                }
                reject(new Error(`Server failed to start within 5000ms. Stdout: ${stdout}`))
            }
        }, 5000)

        proc.stdout.on('data', chunk => {
            stdout += chunk.toString()
            const match = stdout.match(/__API_READY__\s+(\{[^\n]+\})/)
            if (match && !ready) {
                ready = true
                clearTimeout(timeout)
                const info = JSON.parse(match[1])
                resolve({
                    proc,
                    port: info.port,
                    trackBotPid: (pid) => {
                        if (pid && typeof pid === 'number') {
                            trackedBotPids.add(pid)
                            globalTrackedBotPids.add(pid)
                        }
                    },
                    close: async () => {
                        // 1. 尝试通过 stop 接口优雅停止，严格限制 1000ms 短超时，防止 server 挂死卡住流程
                        try {
                            await httpRequest({
                                port: info.port,
                                path: '/stop',
                                method: 'POST',
                                headers: {
                                    Authorization: `Bearer ${token || ''}`,
                                    'Content-Type': 'application/json'
                                },
                                body: { force: true },
                                timeoutMs: 1000
                            }).catch(() => {})
                        } catch (_) {}

                        // 2. 无论 /stop 成功、失败还是超时，均立即进入强力清理：清理 ProcessManager 启动的子进程独立进程组与直接 PID
                        for (const bpid of trackedBotPids) {
                            try { process.kill(-bpid, 'SIGKILL') } catch (_) {}
                            try { process.kill(bpid, 'SIGKILL') } catch (_) {}
                        }

                        // 3. 强力清理 server 自身进程组与直接 PID
                        try {
                            if (proc.pid) {
                                try { process.kill(-proc.pid, 'SIGKILL') } catch (_) {}
                                try { proc.kill('SIGKILL') } catch (_) {}
                            }
                        } catch (_) {}

                        // 4. 关键等待：轮询确认所有追踪的 dummy 进程和 server 进程均已彻底退出
                        const waitPids = [...trackedBotPids, proc.pid].filter(p => typeof p === 'number' && p > 0)
                        const startWait = Date.now()
                        while (Date.now() - startWait < 3000) {
                            const stillAlive = waitPids.filter(p => isProcessAlive(p))
                            if (stillAlive.length === 0) break
                            for (const p of stillAlive) {
                                try { process.kill(-p, 'SIGKILL') } catch (_) {}
                                try { process.kill(p, 'SIGKILL') } catch (_) {}
                            }
                            await new Promise(r => setTimeout(r, 50))
                        }
                    }
                })
            }
        })

        proc.on('error', err => {
            clearTimeout(timeout)
            reject(err)
        })

        proc.on('exit', code => {
            clearTimeout(timeout)
            if (!ready) {
                reject(new Error(`Server exited prematurely with code ${code}. Stdout: ${stdout}`))
            }
        })
    })
}

// 辅助函数：发送 HTTP 请求，默认支持超时保护
function httpRequest({ host = '127.0.0.1', port, path, method = 'GET', headers = {}, body = null, timeoutMs = 5000 }) {
    return new Promise((resolve, reject) => {
        const reqHeaders = { ...headers }
        let payload = null
        if (body !== null) {
            payload = typeof body === 'string' ? body : JSON.stringify(body)
            reqHeaders['Content-Type'] ??= 'application/json'
            reqHeaders['Content-Length'] = Buffer.byteLength(payload)
        }

        const req = http.request({
            host,
            port,
            path,
            method,
            headers: reqHeaders
        }, res => {
            let data = ''
            res.on('data', chunk => data += chunk)
            res.on('end', () => {
                let json = null
                try {
                    json = JSON.parse(data)
                } catch {}
                resolve({
                    status: res.statusCode,
                    headers: res.headers,
                    body: data,
                    json
                })
            })
        })

        if (timeoutMs > 0) {
            req.setTimeout(timeoutMs, () => {
                req.destroy(Object.assign(new Error(`HTTP request timed out after ${timeoutMs}ms`), { code: 'ETIMEDOUT' }))
            })
        }

        req.on('error', reject)
        if (payload) req.write(payload)
        req.end()
    })
}

let nextPort = 42100

test('1. Unset API_TOKEN: control endpoints return 403 Forbidden with API_TOKEN_REQUIRED', async () => {
    const port = nextPort++
    const serverInstance = await launchServer({ token: undefined, port })
    try {
        const res = await httpRequest({
            port,
            path: '/start',
            method: 'POST',
            body: {}
        })

        assert.equal(res.status, 403)
        assert.ok(res.json)
        assert.equal(res.json.code, 'API_TOKEN_REQUIRED')
        assert.ok(res.json.hint.includes('No API_TOKEN set'))
    } finally {
        await serverInstance.close()
    }
})

test('2. Unset API_TOKEN: public healthcheck endpoint returns 200 OK', async () => {
    const port = nextPort++
    const serverInstance = await launchServer({ token: undefined, port })
    try {
        const res = await httpRequest({
            port,
            path: '/health',
            method: 'GET'
        })

        assert.equal(res.status, 200)
        assert.ok(res.json)
        assert.equal(res.json.ok, true)
    } finally {
        await serverInstance.close()
    }
})

test('3. Configured API_TOKEN: requests with missing or invalid token return 401 Unauthorized', async () => {
    const port = nextPort++
    const token = 'audit-secret-token-3'
    const serverInstance = await launchServer({ token, port })
    try {
        // 无 token
        const resNoToken = await httpRequest({
            port,
            path: '/start',
            method: 'POST',
            body: {}
        })
        assert.equal(resNoToken.status, 401)
        assert.equal(resNoToken.json?.error, 'Unauthorized')

        // 错误 token
        const resBadToken = await httpRequest({
            port,
            path: '/start',
            method: 'POST',
            headers: {
                Authorization: 'Bearer invalid-token'
            },
            body: {}
        })
        assert.equal(resBadToken.status, 401)
        assert.equal(resBadToken.json?.error, 'Unauthorized')
    } finally {
        await serverInstance.close()
    }
})

test('4. Configured API_TOKEN: requests with valid Bearer token are authorized', async () => {
    const port = nextPort++
    const token = 'audit-secret-token-4'
    const serverInstance = await launchServer({ token, port })
    let spawnedBotPid = null
    try {
        // 请求 /status 验证鉴权放行
        const resStatus = await httpRequest({
            port,
            path: '/status',
            method: 'GET',
            headers: {
                Authorization: `Bearer ${token}`
            }
        })
        assert.equal(resStatus.status, 200)
        assert.ok(resStatus.json)
        assert.equal(resStatus.json.state, 'idle')

        // 请求 POST /start 验证控制接口鉴权放行
        const resStart = await httpRequest({
            port,
            path: '/start',
            method: 'POST',
            headers: {
                Authorization: `Bearer ${token}`
            },
            body: {}
        })
        assert.equal(resStart.status, 202)
        assert.equal(resStart.json?.started, true)

        // 关键安全断言：启动的命令绝不能触发 dist/index.js，必须为 testDummyBot.js
        assert.equal(resStart.json.command, process.execPath)
        assert.ok(Array.isArray(resStart.json.args))
        assert.ok(resStart.json.args.some(a => a.includes('testDummyBot.js')), '必须启动安全 dummy 脚本')
        assert.equal(resStart.json.args.some(a => a.includes('dist/index.js')), false, '绝不能触发 dist/index.js')

        // 关键隔离追踪：提取 ProcessManager 的子进程 PID 并真实调用 trackBotPid 记录
        spawnedBotPid = resStart.json.pid
        assert.ok(typeof spawnedBotPid === 'number' && spawnedBotPid > 0, 'POST /start 必须返回合法的正整数 dummy pid')
        serverInstance.trackBotPid(spawnedBotPid)

        // 验证 dummy 子进程在启动后真实存在且运行
        assert.equal(isProcessAlive(spawnedBotPid), true, 'dummy 子进程启动后必须处于存活状态')

        // 请求 POST /stop 验证并确保 dummy 子进程被正常停止
        const resStop = await httpRequest({
            port,
            path: '/stop',
            method: 'POST',
            headers: {
                Authorization: `Bearer ${token}`
            },
            body: { force: true }
        })
        assert.equal(resStop.status, 202)
    } finally {
        await serverInstance.close()
        // 关键断言：验证测试结束后 dummy 子进程已被彻底清理，绝无残留
        if (spawnedBotPid) {
            assert.equal(isProcessAlive(spawnedBotPid), false, '测试结束后 dummy 子进程必须已被彻底清理退出')
        }
    }
})

test('5. Configured API_TOKEN: malicious command-line flags (-e, --eval) return 400 Bad Request', async () => {
    const port = nextPort++
    const token = 'audit-secret-token-5'
    const serverInstance = await launchServer({ token, port })
    try {
        // 尝试注入 Node -e 参数
        const resInjection = await httpRequest({
            port,
            path: '/start',
            method: 'POST',
            headers: {
                Authorization: `Bearer ${token}`
            },
            body: {
                args: ['dist/index.js', '-e', 'require("child_process").execSync("id")']
            }
        })

        assert.equal(resInjection.status, 400)
        assert.equal(resInjection.json?.code, 'BAD_REQUEST')
        assert.ok(resInjection.json?.error.includes('Arbitrary Node flags are not allowed'))

        // 尝试替换执行脚本
        const resReplaceScript = await httpRequest({
            port,
            path: '/start',
            method: 'POST',
            headers: {
                Authorization: `Bearer ${token}`
            },
            body: {
                args: ['evil_script.js']
            }
        })

        assert.equal(resReplaceScript.status, 400)
        assert.equal(resReplaceScript.json?.code, 'BAD_REQUEST')
        assert.ok(resReplaceScript.json?.error.includes('Replacing the target script is forbidden'))
    } finally {
        await serverInstance.close()
    }
})

test('6. Fault Injection: immediate crash right after /start still terminates dummy bot in finally', async () => {
    const port = nextPort++
    const token = 'audit-secret-token-6'
    const serverInstance = await launchServer({ token, port })
    let dummyPid = null
    let errorCaught = null

    try {
        // 1. 请求 POST /start 成功拉起 dummy 进程
        const resStart = await httpRequest({
            port,
            path: '/start',
            method: 'POST',
            headers: {
                Authorization: `Bearer ${token}`
            },
            body: {}
        })

        assert.equal(resStart.status, 202)
        assert.equal(resStart.json?.started, true)
        dummyPid = resStart.json?.pid
        assert.ok(typeof dummyPid === 'number' && dummyPid > 0, 'POST /start 必须返回合法的 dummy PID')

        // 2. 真实记录 dummy PID
        serverInstance.trackBotPid(dummyPid)

        // 3. 验证故障注入前 dummy 进程处于正常运行状态
        assert.equal(isProcessAlive(dummyPid), true, '故障注入前 dummy 进程必须真实存在且运行')

        // 4. 关键故障注入：模拟测试在 /start 成功响应后发生断言失败或未捕获崩溃，直接跳过正常的 /stop 请求
        throw new Error('Simulated test assertion crash immediately following /start')
    } catch (err) {
        errorCaught = err
    } finally {
        // 5. 验证在 finally 中异步等待清理彻底完成
        await serverInstance.close()
    }

    // 6. 验证模拟的故障确实抛出并被捕获
    assert.ok(errorCaught, '模拟测试故障应当被捕获')
    assert.equal(errorCaught.message, 'Simulated test assertion crash immediately following /start')

    // 7. 核心断言：即便测试流程突然抛错，finally 阶段的清理也必须彻底终结 dummy 子进程，绝无孤儿残留
    assert.ok(dummyPid, 'dummyPid 必须已被记录')
    assert.equal(isProcessAlive(dummyPid), false, '发生测试异常后 finally 清理必须保证 dummy 进程已彻底退出')
})

test('7. Hang Boundary: close() with hung server terminates dummy bot quickly without hanging forever', async () => {
    const port = nextPort++
    const token = 'audit-secret-token-7'
    const serverInstance = await launchServer({ token, port })
    let dummyPid = null

    try {
        // 1. 请求 POST /start 成功启动 dummy 进程
        const resStart = await httpRequest({
            port,
            path: '/start',
            method: 'POST',
            headers: {
                Authorization: `Bearer ${token}`
            },
            body: {}
        })

        assert.equal(resStart.status, 202)
        assert.equal(resStart.json?.started, true)
        dummyPid = resStart.json?.pid
        assert.ok(typeof dummyPid === 'number' && dummyPid > 0)
        serverInstance.trackBotPid(dummyPid)
        assert.equal(isProcessAlive(dummyPid), true, 'dummy 进程必须正常运行')

        // 2. 模拟服务器无响应挂死场景：发送 SIGSTOP 彻底冻结 server 进程，使其无法处理任何后续 HTTP 请求
        process.kill(serverInstance.proc.pid, 'SIGSTOP')
    } finally {
        // 3. 记录 close 耗时，验证其绝不会无限等待挂死，并在超时后立刻强制清理子进程组与 server 组
        const startClose = Date.now()
        await serverInstance.close()
        const duration = Date.now() - startClose

        // 4. 关键断言：
        // (a) close() 耗时必须有界（在 1000ms 超时 + 轮询清理后，应在 3500ms 内完成，绝不无限制卡住）
        assert.ok(duration < 3500, `close() 应在短时间内有界完成，实际耗时 ${duration}ms`)

        // (b) dummy 子进程必须已被强制清理退出
        assert.ok(dummyPid, 'dummyPid 必须已被记录')
        assert.equal(isProcessAlive(dummyPid), false, '即使 server 挂死，dummy 子进程也必须已被强制清理退出')

        // (c) 挂死的 server 进程自身也已被彻底销毁
        assert.equal(isProcessAlive(serverInstance.proc.pid), false, '挂死的 server 进程也必须已被强制销毁')
    }
})

