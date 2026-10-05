import assert from 'node:assert/strict'
import test from 'node:test'
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// =========================================================================
// 测试隔离前移：在加载 web.mjs 之前无条件预设独立临时隔离环境，绝不触碰真实 sessions 或外部目录
// =========================================================================
const origPreEnvSessionDir = process.env.MS_SESSION_DIR
const origPreEnvSessionDbPath = process.env.MS_SESSION_DB_PATH
const origPreEnvPairingSecret = process.env.MS_WEB_PAIRING_SECRET

const preImportTempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ms-rewards-bodylimit-preimport-'))
process.env.MS_SESSION_DIR = preImportTempDir
process.env.MS_SESSION_DB_PATH = path.join(preImportTempDir, 'sessions.db')
process.env.MS_WEB_PAIRING_SECRET = 'fictional-preimport-secret-limit1234567890'

const { readRequestBody } = await import('../../web.mjs')

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

test('readRequestBody successfully reads normal payload within 1MB', async () => {
    let serverRes
    const server = http.createServer(async (req, res) => {
        try {
            const body = await readRequestBody(req, res, { maxSize: 1024 * 1024 })
            res.writeHead(200, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ receivedLen: body.length }))
        } catch (_) {}
    })

    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
    const port = server.address().port

    try {
        const payload = JSON.stringify({ hello: 'world', repeat: 'a'.repeat(5000) })
        const res = await new Promise((resolve, reject) => {
            const req = http.request({
                host: '127.0.0.1',
                port,
                method: 'POST',
                headers: { 'Content-Type': 'application/json' }
            }, (res) => {
                let data = ''
                res.on('data', chunk => data += chunk)
                res.on('end', () => resolve({ status: res.statusCode, body: data }))
            })
            req.on('error', reject)
            req.write(payload)
            req.end()
        })

        assert.equal(res.status, 200)
        const parsed = JSON.parse(res.body)
        assert.equal(parsed.receivedLen, payload.length)
    } finally {
        server.close()
    }
})

test('readRequestBody rejects and responds 413 when payload exceeds 1MB limit', async () => {
    const server = http.createServer(async (req, res) => {
        try {
            await readRequestBody(req, res, { maxSize: 1024 * 1024 })
        } catch (_) {}
    })

    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
    const port = server.address().port

    try {
        // Send slightly more than 1MB
        const payload = Buffer.alloc(1024 * 1024 + 1024, 'x')
        const res = await new Promise((resolve, reject) => {
            let httpResponse = null
            const req = http.request({
                host: '127.0.0.1',
                port,
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Content-Length': payload.length
                }
            }, (res) => {
                let data = ''
                res.on('data', chunk => data += chunk)
                res.on('end', () => {
                    httpResponse = { status: res.statusCode, body: data }
                    resolve(httpResponse)
                })
            })
            req.on('error', (err) => {
                setTimeout(() => {
                    if (httpResponse) {
                        resolve(httpResponse)
                    } else {
                        reject(err)
                    }
                }, 300)
            })
            req.write(payload)
            req.end()
        })

        assert.equal(res.status, 413)
        assert.ok(res.body.includes('payload_too_large'))
    } finally {
        server.close()
    }
})

test('readRequestBody rejects and responds 408 when request hangs and times out', async () => {
    const server = http.createServer(async (req, res) => {
        try {
            // Test with a short 200ms timeout
            await readRequestBody(req, res, { timeoutMs: 200 })
        } catch (_) {}
    })

    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
    const port = server.address().port

    try {
        const res = await new Promise((resolve, reject) => {
            const req = http.request({
                host: '127.0.0.1',
                port,
                method: 'POST',
                headers: { 'Content-Type': 'application/json' }
            }, (res) => {
                let data = ''
                res.on('data', chunk => data += chunk)
                res.on('end', () => resolve({ status: res.statusCode, body: data }))
            })
            req.on('error', reject)
            // Write first chunk but never call req.end()
            req.write('hanging data...')
        })

        assert.equal(res.status, 408)
        assert.ok(res.body.includes('request_timeout'))
    } finally {
        server.close()
    }
})
