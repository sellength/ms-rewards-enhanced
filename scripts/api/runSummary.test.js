import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

const page = fs.readFileSync(new URL('../../public/index.html', import.meta.url), 'utf8')
const summarySource = page.slice(page.indexOf('function runSummary('), page.indexOf('function renderRunSummary('))
const summarize = new Function(`${summarySource}; return runSummary`)()

for (const platform of ['desktop', 'mobile']) {
    test(`${platform}: official progress, manual tasks and runtime remain separate`, () => {
        const state = { tasks: { dailySet: { status: 'PENDING' }, edgeBrowsing: { status: 'PENDING', progress: '25/30' } },
            dailySetCards: [{ id: 'a', points: 10, complete: true }, { id: 'b', points: 10, requiresAppInteraction: true }] }
        const runtime = { dailySet: { status: 'ERROR' }, edgeBrowsing: { status: 'RUNNING' } }
        const result = summarize(state, runtime, true, platform)
        assert.equal(result.tone, 'running')
        assert.match(result.text, /已完成 1\/3 项，剩余自动任务 1 项；人工\/交互待办 1 项/)
        assert.match(result.text, /Edge 浏览 25\/30/)
        assert.doesNotMatch(result.text, /Daily Set/)
        assert.equal(summarize(state, {}, false, platform).tone, 'idle')
        assert.equal(summarize(state, {}, false, platform, true).tone, 'pending')
        state.tasks.edgeBrowsing.status = 'DONE'
        state.dailySetCards[1].complete = true
        state.tasks.dailySet.status = 'DONE'
        assert.equal(summarize(state, runtime, false, platform).tone, 'done')
        assert.equal(summarize(state, runtime, true, platform).tone, 'running')
    })

    test(`${platform}: unknown is not complete; official DONE wins over errors`, () => {
        assert.notEqual(summarize({}, {}, false, platform).tone, 'done')
        assert.notEqual(summarize({ tasks: { x: { status: 'UNAVAILABLE' } } }, {}, false, platform).tone, 'done')
        assert.equal(summarize({ tasks: { x: { status: 'PENDING' } } }, { x: { status: 'ERROR' } }, false, platform).tone, 'error')
        assert.equal(summarize({ tasks: { x: { status: 'DONE' } } }, { x: { status: 'ERROR' } }, false, platform).tone, 'done')
    })

    test(`${platform}: sync during execution only calls sync and suppresses duplicate clicks`, async () => {
        const start = page.indexOf(`async function trigger${platform === 'mobile' ? 'Mobile' : 'Desktop'}Sync(`)
        const end = page.indexOf('\n        async function ', start + 1)
        const calls = [], feedback = { desktop: '', mobile: '' }, busy = { desktop: false, mobile: false }
        let release
        const fetch = async url => { calls.push(url); await new Promise(resolve => { release = resolve }); return { ok: true, json: async () => ({ success: true, live: true, state: {} }) } }
        const noop = () => {}
        const trigger = new Function('fetch', 'syncFeedback', 'manualSyncBusy', 'renderRunSummary', `
            const authorizationState={desktop:true,mobile:true,accountMatches:true};
            const isDesktopRunning=true,isMobileRunning=true;
            const document={getElementById:()=>null}, manualSyncLastStartedAt={};
            const manualSyncRetrySeconds=()=>0, appendDesktopLog=()=>{},appendMobileLog=()=>{},updateUI=()=>{},updateMobileUI=()=>{},applyAuthorizationState=()=>{};
            const setTimeout=fn=>fn();
            ${page.slice(start, end)}
            return trigger${platform === 'mobile' ? 'Mobile' : 'Desktop'}Sync;
        `)(fetch, feedback, busy, noop)
        const pending = trigger()
        await trigger()
        assert.deepEqual(calls, [platform === 'mobile' ? '/api/mobile/sync' : '/api/sync'])
        assert.match(feedback[platform], /不影响后台任务/)
        release()
        await pending
        assert.equal(feedback[platform], '数据同步成功')
        assert.equal(busy[platform], false)
        assert.equal(feedback[platform === 'mobile' ? 'desktop' : 'mobile'], '')
    })
}

test('mobile More cards are counted once and manual pending is not an error', () => {
    const state = { tasks: { appPromotions: { status: 'PENDING' } }, promoCards: [
        { offerId: 'a', points: 10, requiresManualInteraction: true },
        { offerId: 'a', points: 10, requiresManualInteraction: true }, { points: 0 }
    ] }
    const result = summarize(state, { appPromotions: { status: 'ERROR' } }, false, 'mobile', true)
    assert.equal(result.tone, 'pending')
    assert.match(result.text, /已完成 0\/1 项，剩余自动任务 0 项；人工\/交互待办 1 项/)
    assert.match(page, /prefers-reduced-motion: reduce/)
})
