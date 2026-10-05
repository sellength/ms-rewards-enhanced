import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { DatabaseSync } from 'node:sqlite'
import { clearAccountSessionStorage, clearAccountLoginFiles } from './sessionLogout.mjs'

const webSource = fs.readFileSync(new URL('../../web.mjs', import.meta.url), 'utf8')
const pageSource = fs.readFileSync(new URL('../../public/index.html', import.meta.url), 'utf8')

function fixture() {
    const db = new DatabaseSync(':memory:')
    db.exec(`CREATE TABLE sessions (
        email TEXT NOT NULL,
        platform TEXT NOT NULL,
        storage_state TEXT,
        fingerprint TEXT,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (email, platform)
    )`)
    db.exec('CREATE TABLE account_metadata (email TEXT PRIMARY KEY, mobile_device_id TEXT)')
    db.prepare('INSERT INTO account_metadata VALUES (?, ?)').run('person@example.com', 'test-device')
    const insert = db.prepare('INSERT INTO sessions VALUES (?, ?, ?, ?, ?)')
    insert.run('person@example.com', 'desktop', '{"cookies":[1]}', '{"desktop":true}', 1)
    insert.run('person@example.com', 'mobile', '{"cookies":[2]}', '{"mobile":true}', 1)
    insert.run('other@example.com', 'desktop', '{"cookies":[3]}', '{"other":true}', 1)
    return db
}

test('logout deletes both sessions, fingerprints and metadata while preserving other accounts', () => {
    const db = fixture()
    assert.equal(clearAccountSessionStorage(db, 'PERSON@example.com'), 2)
    const rows = db.prepare('SELECT * FROM sessions').all()
    assert.equal(rows.length, 1)
    assert.equal(rows[0].email, 'other@example.com')
    assert.equal(rows[0].storage_state, '{"cookies":[3]}')
    assert.equal(db.prepare('SELECT count(*) AS n FROM account_metadata').get().n, 0)
    assert.equal(clearAccountSessionStorage(db, 'person@example.com'), 0)
    db.close()
})

test('logout removes saved and inherited credentials plus both caches without removing unrelated configuration', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rewards-logout-'))
    try {
        const envPath = path.join(dir, '.env')
        const caches = ['desktop.json', 'mobile.json'].map(name => path.join(dir, name))
        fs.writeFileSync(envPath, 'ACCOUNT_1_EMAIL=test@example.com\nACCOUNT_1_PASSWORD=fake\nACCOUNT_1_TOTP_SECRET=fake\nACCOUNT_1_RECOVERY_EMAIL=recovery@example.com\nACCOUNT_1_GEO_LOCALE=US\nACCOUNT_1_LANG_CODE=en\nOTHER_SETTING=keep\nACCOUNT_2_EMAIL=other@example.com\n')
        for (const file of caches) fs.writeFileSync(file, '{"account":"test@example.com"}')
        const environment = { ACCOUNT_1_EMAIL: 'test@example.com', ACCOUNT_1_PASSWORD: 'fake', OTHER_SETTING: 'keep' }
        clearAccountLoginFiles(envPath, caches, environment)
        assert.equal(fs.readFileSync(envPath, 'utf8'), 'OTHER_SETTING=keep\nACCOUNT_2_EMAIL=other@example.com\n')
        assert.deepEqual(environment, { OTHER_SETTING: 'keep' })
        assert.ok(caches.every(file => !fs.existsSync(file)))
        clearAccountLoginFiles(envPath, caches, environment)
    } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})

test('logout is idempotent when the account has no active session storage', () => {
    const db = fixture()
    assert.equal(clearAccountSessionStorage(db, 'missing@example.com'), 0)
    assert.equal(clearAccountSessionStorage(db, 'missing@example.com'), 0)
    db.close()
})

test('logout endpoint is local-only, blocked while work runs, and clears configuration and replay', () => {
    const start = webSource.indexOf("if (pathname === '/api/account/logout'")
    const end = webSource.indexOf("if (pathname === '/api/account'", start + 1)
    const route = webSource.slice(start, end)
    assert.ok(start >= 0 && end > start)
    assert.match(route, /activeBotProcess \|\| scheduledSyncRunning/)
    assert.match(route, /clearAccountSessionStorage\(db, account\.email\)/)
    assert.doesNotMatch(route, /saveAccount|fetch\(|runBotProcess/)
    assert.match(route, /activeCloudReads > 0/)
    assert.match(route, /clearAccountLoginFiles/)
    assert.match(route, /runtimeReplay.reset\(\)/)
    assert.match(route, /accountLoggedOut/)
})

test('account page exposes a confirmed logout action and refreshes authorization state', () => {
    assert.match(pageSource, /id="btnAccountLogout"[^>]*>退出登录<\/button>/)
    assert.match(pageSource, /id="accountLogoutFeedback"[^>]*role="status"[^>]*aria-live="polite"/)
    const start = pageSource.indexOf('async function logoutAccount()')
    const end = pageSource.indexOf('function initSSE()', start)
    const action = pageSource.slice(start, end)
    assert.match(action, /confirm\('退出后将删除本程序保存的当前账号/)
    assert.match(action, /fetch\('\/api\/account\/logout', \{ method: 'POST' \}\)/)
    assert.match(action, /applyAuthorizationState\(\)/)
    assert.match(action, /账号登录信息及任务缓存均已清除/)
    assert.match(action, /succeeded \? '已退出' : '退出登录'/)
})

function pageFixture(fetch, confirmed = true) {
    const elements = new Map()
    const document = { getElementById(id) {
        if (!elements.has(id)) elements.set(id, { style: {}, textContent: '', disabled: false, hidden: true })
        return elements.get(id)
    } }
    const apply = pageSource.slice(pageSource.indexOf('function applyAuthorizationState()'), pageSource.indexOf('function switchView(view)'))
    const logout = pageSource.slice(pageSource.indexOf('async function logoutAccount()'), pageSource.indexOf('function initSSE()'))
    const api = new Function('document', 'fetch', 'confirm', 'window', `
        let authorizationState = { configured: true, desktop: true, mobile: true, accountMatches: true };
        let authorizationRevision = 0, accountLogoutPending = false, view = 'dashboard';
        function switchView(value) { view = value; }
        ${apply}
        ${logout}
        return { logoutAccount, refreshAuthorizationState, state: () => ({...authorizationState}), view: () => view };
    `)(document, fetch, () => confirmed, { location: { reload() { elements.set('reloaded', true) } } })
    return { ...api, elements }
}

test('actual page logout completes without waiting for a second network request and disables both terminals', async () => {
    const calls = []
    const p = pageFixture(async url => {
        calls.push(url)
        assert.equal(url, '/api/account/logout')
        return { ok: true, json: async () => ({ success: true, cleared: 2 }) }
    })
    await p.logoutAccount()
    assert.deepEqual(calls, ['/api/account/logout'])
    assert.equal(p.elements.get('reloaded'), true)
    assert.equal(p.state().configured, false)
    assert.equal(p.elements.get('accLiveEmail').textContent, '未登录')
    for (const id of ['accEmail', 'accPassword', 'accTotpSecret', 'accRecoveryEmail']) assert.equal(p.elements.get(id).value, '')
    assert.equal(p.state().desktop, false)
    assert.equal(p.state().mobile, false)
    for (const id of ['btnDesktopRun', 'btnMobileRun', 'btnDesktopSync', 'btnMobileSync']) assert.equal(p.elements.get(id).disabled, true)
    assert.match(p.elements.get('accountLogoutFeedback').textContent, /均已清除/)
    assert.equal(p.elements.get('btnAccountLogout').textContent, '已退出')
})

test('an authorization response started before logout cannot restore the old login state', async () => {
    let release
    const p = pageFixture(url => url === '/api/account/status'
        ? new Promise(resolve => { release = resolve })
        : Promise.resolve({ ok: true, json: async () => ({ success: true }) }))
    const pending = p.refreshAuthorizationState()
    await p.logoutAccount()
    release({ ok: true, json: async () => ({ success: true, desktop: true, mobile: true, accountMatches: true }) })
    await pending
    assert.equal(p.state().desktop, false)
    assert.equal(p.state().mobile, false)
})

test('failed logout preserves login and shows a visible error; cancellation sends no request', async () => {
    const p = pageFixture(async () => ({ ok: false, json: async () => ({ error: 'logout_busy' }) }))
    await p.logoutAccount()
    assert.equal(p.state().desktop, true)
    assert.equal(p.elements.get('accountLogoutFeedback').hidden, false)
    assert.match(p.elements.get('accountLogoutFeedback').textContent, /正在运行/)
    const cancelled = pageFixture(() => assert.fail('cancel must not send a request'), false)
    await cancelled.logoutAccount()
    assert.equal(cancelled.state().desktop, true)
})

test('expired sessions with saved credentials still allow logout', async () => {
    const p = pageFixture(async url => ({ ok: true, json: async () => url === '/api/account/status'
        ? { configured: true, desktop: false, mobile: false, accountMatches: true }
        : { success: true } }))
    await p.refreshAuthorizationState()
    assert.equal(p.elements.get('btnAccountLogout').disabled, false)
    await p.logoutAccount()
    assert.equal(p.elements.get('reloaded'), true)
})

test('logout clears replay and probe state so a new page has no old account activity', async () => {
    const { createRuntimeReplay } = await import('./runtimeReplay.mjs')
    const { createDailySetProbeState } = await import('./dailySetProbeState.mjs')
    const replay = createRuntimeReplay()
    replay.record({ type: 'runState', platform: 'desktop', running: true })
    replay.record({ type: 'log', platform: 'desktop', msg: 'test account' })
    replay.reset()
    assert.deepEqual(replay.snapshot(), createRuntimeReplay().snapshot())
    const probes = createDailySetProbeState()
    probes.record('test', 'mobile', 'entry_probe_interaction_required offerId=abc appDate=09/14/2026')
    probes.clear()
    const state = probes.apply('test', 'mobile', { dailySetDate: '09/14/2026', dailySetCards: [{ offerId: 'abc', complete: false }] })
    assert.equal(state.dailySetCards[0].entryProbeResult, null)
})

test('actual logout route removes temporary persisted data and is safe to repeat; busy requests change nothing', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rewards-logout-route-'))
    try {
        fs.mkdirSync(path.join(dir, 'sessions'))
        const db = new DatabaseSync(path.join(dir, 'sessions', 'sessions.db'))
        db.exec("CREATE TABLE sessions (email TEXT, platform TEXT, storage_state TEXT); INSERT INTO sessions VALUES ('test@example.com', 'desktop', 'fake')")
        db.close()
        const envPath = path.join(dir, '.env')
        fs.writeFileSync(envPath, 'ACCOUNT_1_EMAIL=test@example.com\nACCOUNT_1_PASSWORD=fake\n')
        const caches = ['daily_state.json', 'mobile_state.json'].map(name => path.join(dir, 'sessions', name))
        for (const file of caches) fs.writeFileSync(file, '{"account":"test@example.com"}')
        const start = webSource.indexOf("    if (pathname === '/api/account/logout'")
        const route = webSource.slice(start, webSource.indexOf("    if (pathname === '/api/account'", start + 1))
        const readAccount = webSource.slice(webSource.indexOf('function getSavedAccount()'), webSource.indexOf('function saveAccount(acc)'))
        const events = []
        const invoke = new Function('fs', 'path', 'DatabaseSync', 'clearAccountSessionStorage', 'clearAccountLoginFiles', '__dirname', 'activeCloudReads', 'events', `
            const envFilePath = path.join(__dirname, '.env');
            const stateFilePath = path.join(__dirname, 'sessions', 'daily_state.json');
            const mobileStateFilePath = path.join(__dirname, 'sessions', 'mobile_state.json');
            const activeBotProcess = null, scheduledSyncRunning = false;
            let activeProbeAccount = 'test@example.com';
            const runtimeReplay = { reset() { events.push('replayReset') } };
            const dailySetProbeState = { clear() { events.push('probeClear') } };
            const broadcast = event => events.push(event.type);
            const pathname = '/api/account/logout', req = { method: 'POST' };
            const res = { writeHead(code) { events.push(code) }, end(body) { events.push(JSON.parse(body)) } };
            ${readAccount}
            ${route}
        `)
        const run = busy => invoke(fs, path, DatabaseSync, clearAccountSessionStorage,
            (env, paths) => clearAccountLoginFiles(env, paths, {}), dir, busy, events)
        run(1)
        assert.ok(events.includes(409))
        assert.match(fs.readFileSync(envPath, 'utf8'), /test@example.com/)
        assert.ok(caches.every(file => fs.existsSync(file)))
        events.length = 0
        run(0)
        assert.deepEqual(events, ['replayReset', 'probeClear', 200, { success: true, cleared: 1 }, 'accountLoggedOut'])
        assert.equal(fs.readFileSync(envPath, 'utf8'), '')
        assert.ok(caches.every(file => !fs.existsSync(file)))
        const checkDb = new DatabaseSync(path.join(dir, 'sessions', 'sessions.db'))
        assert.equal(checkDb.prepare('SELECT count(*) AS n FROM sessions').get().n, 0)
        checkDb.close()
        events.length = 0
        run(0)
        assert.ok(events.some(event => event?.success === true && event.cleared === 0))
    } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})
