import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { createRuntimeReplay } from './runtimeReplay.mjs'

test('reconnect preserves isolated running tasks and bounded logs, finish and new run reset lifecycle', () => {
    const store = createRuntimeReplay({ limit: 2 })
    store.record({ type: 'log', platform: 'desktop', msg: 'doctor idle' })
    store.record({ type: 'runState', platform: 'mobile', running: true })
    for (const msg of ['one', 'two', 'three']) store.record({ type: 'log', platform: 'mobile', msg })
    store.record({ type: 'taskStatus', platform: 'mobile', taskId: 'dailySet', itemId: 'a', status: 'RUNNING' })
    const snapshot = store.snapshot()
    assert.equal(snapshot.mobile.running, true)
    assert.equal(snapshot.desktop.running, false)
    assert.deepEqual(snapshot.desktop.logs, [])
    assert.deepEqual(snapshot.mobile.logs.map(x => x.msg), ['two', 'three'])
    assert.deepEqual(store.snapshot(), snapshot)
    snapshot.mobile.logs.length = 0
    assert.equal(store.snapshot().mobile.logs.length, 2)
    store.record({ type: 'finished', platform: 'mobile' })
    assert.equal(store.snapshot().mobile.running, false)
    assert.equal(Object.values(store.snapshot().mobile.tasks)[0].status, 'PENDING')
    store.record({ type: 'runState', platform: 'mobile', running: true })
    assert.deepEqual(store.snapshot().mobile.tasks, {})
})

test('day rollover expires logs without forgetting an active run; new service has no stale running state', () => {
    let date = new Date(2026, 8, 8, 23, 59)
    const store = createRuntimeReplay({ now: () => date })
    store.record({ type: 'runState', platform: 'desktop', running: true })
    store.record({ type: 'log', platform: 'desktop', msg: 'yesterday' })
    store.record({ type: 'taskStatus', platform: 'desktop', taskId: 'edge', status: 'RUNNING' })
    date = new Date(2026, 8, 9, 0, 1)
    assert.equal(store.snapshot().desktop.running, true)
    assert.equal(store.snapshot().desktop.logs.length, 0)
    assert.equal(Object.values(store.snapshot().desktop.tasks)[0].status, 'RUNNING')
    assert.equal(createRuntimeReplay().snapshot().desktop.running, false)
})

test('page restores both buttons and replaces replay logs on each connection', () => {
    const page = fs.readFileSync(new URL('../../public/index.html', import.meta.url), 'utf8')
    const source = page.slice(page.indexOf('function restoreRunState('), page.indexOf('async function toggleDesktopRun('))
    const elements = new Map()
    const document = { getElementById(id) {
        if (!elements.has(id)) elements.set(id, { style: {}, rows: [], replaceChildren() { this.rows = [] } })
        return elements.get(id)
    } }
    const tasks = { desktop: {}, mobile: {} }
    const restore = new Function('document', 'authorizationState', 'taskStatusState', 'appendDesktopLog', 'appendMobileLog', 'setTaskStatus',
        `let isDesktopRunning=false,isMobileRunning=false,isRunning=false; const runSeen={}; function renderRunSummary() {} ${source}; return restoreRuntimeSnapshot;`)(
        document, { desktop: true, mobile: true, accountMatches: true }, tasks,
        (_t, msg) => document.getElementById('desktopLogContainer').rows.push(msg),
        (_t, msg) => document.getElementById('mobileLogContainer').rows.push(msg),
        (p, id, status) => { tasks[p][id] = status }
    )
    const store = createRuntimeReplay()
    store.record({ type: 'runState', platform: 'desktop', running: true })
    store.record({ type: 'log', platform: 'desktop', msg: 'still running' })
    store.record({ type: 'taskStatus', platform: 'desktop', taskId: 'edge', status: 'RUNNING' })
    restore(store.snapshot()); restore(store.snapshot())
    assert.equal(document.getElementById('btnDesktopRun').textContent, '🛑 停止运行')
    assert.equal(document.getElementById('btnMobileRun').disabled, true)
    assert.deepEqual(document.getElementById('desktopLogContainer').rows, ['still running'])
    assert.equal(tasks.desktop.edge, 'RUNNING')
    store.record({ type: 'finished', platform: 'desktop' })
    restore(store.snapshot())
    assert.equal(document.getElementById('btnDesktopRun').textContent, '🚀 执行任务')
    assert.equal(document.getElementById('btnMobileRun').disabled, false)
})
