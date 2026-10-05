import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { createLiveRunSync, shouldRefreshRun } from './liveRunSync.mjs'

function harness(refresh) {
    let time = 0, timer = null
    const errors = []
    const sync = createLiveRunSync({ refresh, onError: e => errors.push(e), now: () => time,
        setTimer: (fn, delay) => { timer = { fn, at: time + delay }; return timer },
        clearTimer: () => { timer = null } })
    return { sync, errors, get timer() { return timer }, async fire() {
        assert.ok(timer)
        const current = timer; timer = null; time = current.at; current.fn()
        for (let i = 0; i < 10; i++) await Promise.resolve()
    } }
}

test('only progress and completion hints request fresh truth', () => {
    for (const line of ['Completed UrlReward | pointsGained=0', 'Read article verified by SAAndroid',
        'Search progress | pointsGained=3', 'Submitted Edge browsing report',
        "Daily Check-In verified by today's SAAndroid counter"]) assert.equal(shouldRefreshRun(line), true)
    for (const line of ['Starting Bing searches | currentBalance=100', '[PLAN] skip_complete',
        'Response | status=200 | pointsGained=0', 'Search query: hello']) assert.equal(shouldRefreshRun(line), false)
})

test('burst coalesces, never overlaps and trailing update respects cooldown', async () => {
    let calls = 0, release
    const h = harness(async () => { calls++; if (calls === 1) await new Promise(resolve => { release = resolve }) })
    h.sync.request(); h.sync.request()
    assert.equal(h.timer.at, 2000)
    await h.fire()
    h.sync.request(); h.sync.request()
    assert.equal(h.timer, null)
    assert.equal(calls, 1)
    release()
    for (let i = 0; i < 10; i++) await Promise.resolve()
    assert.equal(h.timer.at, 32000)
    await h.fire()
    assert.equal(calls, 2)
    await h.sync.stop()
})

test('failure backs off and stop cancels retry without throwing into worker', async () => {
    const h = harness(async () => { throw new Error('offline') })
    h.sync.request(); await h.fire()
    assert.equal(h.errors.length, 1)
    assert.equal(h.timer.at, 62000)
    h.sync.request()
    assert.equal(h.timer.at, 62000)
    await h.fire()
    assert.equal(h.timer.at, 182000)
    await h.sync.stop()
    assert.equal(h.timer, null)
    h.sync.request()
    assert.equal(h.timer, null)
})

test('stop drains an in-flight read before final sync and cancels trailing refresh', async () => {
    let release, stopped = false
    const h = harness(() => new Promise(resolve => { release = resolve }))
    h.sync.request(); await h.fire(); h.sync.request()
    const stop = h.sync.stop().then(() => { stopped = true })
    await Promise.resolve()
    assert.equal(stopped, false)
    release(); await stop
    assert.equal(stopped, true)
    assert.equal(h.timer, null)
})

test('web uses isolated official reads and drains before final read, never writes log balances', () => {
    const source = fs.readFileSync(new URL('../../web.mjs', import.meta.url), 'utf8')
    const live = source.slice(source.indexOf('const liveSync ='), source.indexOf("activeBotProcess.stdout.on"))
    assert.match(live, /mode === 'mobile' \? await fetchLiveMobileState\(\) : await fetchLiveMicrosoftState\(\)/)
    assert.match(live, /mode === 'mobile' \? saveMobileState\(live\) : saveState\(live\)/)
    const closing = source.slice(source.indexOf("activeBotProcess.on('close'"))
    assert.ok(closing.indexOf('await liveSync.stop()') < closing.indexOf('refreshed = mode'))
    const flow = source.slice(source.indexOf('const flowMatch'), source.indexOf('// Check current action / search'))
    assert.doesNotMatch(flow, /saveState\(/)
})
