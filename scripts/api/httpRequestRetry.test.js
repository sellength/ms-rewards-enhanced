import assert from 'node:assert/strict'
import test from 'node:test'
import http from 'node:http'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const HttpModule = require('../../dist/util/Http')
const HttpClient = HttpModule.HttpClient || HttpModule.default

test('POST requests do NOT retry on 500 error by default', async () => {
    let requestCount = 0

    const server = http.createServer((req, res) => {
        requestCount++
        res.writeHead(500, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'internal_error' }))
    })

    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
    const port = server.address().port

    try {
        const client = new HttpClient({})
        await assert.rejects(
            async () => {
                await client.request({
                    url: `http://127.0.0.1:${port}/test`,
                    method: 'POST',
                    data: { foo: 'bar' }
                })
            },
            /Request failed with status code 500/
        )
        // Must only be called once, no retries for side-effectful POST requests
        assert.equal(requestCount, 1)
    } finally {
        server.close()
    }
})

test('POST requests retry when retryable is explicitly enabled', async () => {
    let requestCount = 0

    const server = http.createServer((req, res) => {
        requestCount++
        if (requestCount <= 2) {
            res.writeHead(503, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ error: 'temporarily_unavailable' }))
        } else {
            res.writeHead(200, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ success: true }))
        }
    })

    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
    const port = server.address().port

    try {
        const client = new HttpClient({})
        const res = await client.request({
            url: `http://127.0.0.1:${port}/test`,
            method: 'POST',
            data: { foo: 'bar' },
            retryable: true
        })
        assert.equal(res.status, 200)
        assert.equal(requestCount, 3)
    } finally {
        server.close()
    }
})

test('GET requests retry on 503 error by default', async () => {
    let requestCount = 0

    const server = http.createServer((req, res) => {
        requestCount++
        if (requestCount <= 1) {
            res.writeHead(503, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ error: 'unavailable' }))
        } else {
            res.writeHead(200, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ data: 'ok' }))
        }
    })

    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
    const port = server.address().port

    try {
        const client = new HttpClient({})
        const res = await client.request({
            url: `http://127.0.0.1:${port}/get-test`,
            method: 'GET'
        })
        assert.equal(res.status, 200)
        assert.equal(requestCount, 2)
    } finally {
        server.close()
    }
})
