import test from 'node:test'
import assert from 'node:assert/strict'
import { Search } from '../../dist/functions/activities/search/BrowserSearch.js'

function fixture({ recover = true, kind = 'normal', enterFails = false, redirected = false, navigationFails = false, status = 200, landingUrl, incidentalChallenge = false, transientVerification = false } = {}) {
    let visible = false, navigations = 0, submissions = 0, url = 'https://www.bing.com/search?q=private-query'
    let postNavigationVerificationChecks = 0
    const logs = []
    const targets = []
    if (kind === 'login') url = 'https://login.live.com/?token=private-token'
    const bot = {
        config: { searchSettings: { scrollRandomResults: false, clickRandomResults: false, searchDelay: { min: 1, max: 1 } } },
        logger: { warn: (...args) => logs.push(args.join(' ')), info: (...args) => logs.push(args.join(' ')) },
        utils: { wait: async () => {}, randomDelay: () => 1 },
        browser: { utils: { ghostClick: async () => {}, tryDismissAllMessages: async () => {} } }
    }
    const page = {
        isClosed: () => kind === 'closed', url: () => url,
        locator: selector => {
            const box = selector === '#sb_form_q'
            const locator = { first: () => locator, nth: () => locator, count: async () => box && visible ? 1 : 0,
                isEditable: async () => true, focus: async () => {},
                isVisible: async () => box ? visible :
                    (selector.includes('captcha') && (kind === 'verification' ||
                        (transientVerification && navigations > 0 && postNavigationVerificationChecks++ === 0))) ||
                    (selector.includes('iframe[src*="challenge"]') && incidentalChallenge),
                waitFor: async () => { if (!visible) throw new Error('timeout with private-query') }, fill: async () => {} }
            return locator
        },
        evaluate: async () => {},
        keyboard: { type: async () => {}, press: async key => { if (key === 'Enter') { submissions++; if (enterFails) throw new Error('uncertain submission') } } },
        goto: async target => {
            navigations++
            targets.push(target)
            if (navigationFails) throw new Error('timeout with private-query and private-token')
            url = landingUrl ?? (redirected ? 'https://login.live.com/' : target)
            visible = recover
            return { status: () => status }
        }
    }
    return { search: new Search(bot), page, logs, targets, counts: () => ({ navigations, submissions }) }
}

for (const mobile of [false]) {
    test(`${mobile ? 'mobile' : 'desktop'} recovers missing input before submission`, async () => {
        const f = fixture()
        await f.search.bingSearch(f.page, 'sample', mobile)
        assert.deepEqual(f.counts(), { navigations: 1, submissions: 1 })
        assert.match(f.logs.join('\n'), /searchBoxes=0/)
        assert.doesNotMatch(f.logs.join('\n'), /\b(error|failed|failure|unable|unavailable)\b/i)
        assert.doesNotMatch(f.logs.join('\n'), /private-query|private-token/)
    })
}
test('persistent missing input stops after two recoveries', async () => {
    const f = fixture({ recover: false })
    await assert.rejects(f.search.bingSearch(f.page, 'sample', false), /recovery_exhausted/)
    assert.deepEqual(f.counts(), { navigations: 2, submissions: 0 })
})
for (const mobile of [false, true]) for (const kind of ['login', 'verification', 'closed']) {
    test(`${mobile ? 'mobile' : 'desktop'} ${kind} requires attention without navigation or submission`, async () => {
        const f = fixture({ kind })
        await assert.rejects(f.search.bingSearch(f.page, 'sample', mobile), /manual_required/)
        assert.deepEqual(f.counts(), { navigations: 0, submissions: 0 })
        assert.doesNotMatch(f.logs.join('\n'), /private-token/)
    })
}
test('recovery redirected to login stops before another input attempt', async () => {
    const f = fixture({ redirected: true })
    await assert.rejects(f.search.bingSearch(f.page, 'sample', false), /manual_required:login/)
    assert.deepEqual(f.counts(), { navigations: 1, submissions: 0 })
})
test('uncertain Enter submission is never repeated', async () => {
    const f = fixture({ enterFails: true })
    await assert.rejects(f.search.bingSearch(f.page, 'sample', false), /submission_uncertain/)
    assert.deepEqual(f.counts(), { navigations: 1, submissions: 1 })
})

test('mobile submits consecutive searches on the same page without an input or homepage recovery', async () => {
    const f = fixture({ recover: false })
    f.page.keyboard.press = async () => assert.fail('mobile must not use the keyboard')
    f.page.keyboard.type = async () => assert.fail('mobile must not type into an input')
    for (let i = 0; i < 11; i++) await f.search.bingSearch(f.page, `sample ${i}`, true)
    assert.deepEqual(f.counts(), { navigations: 11, submissions: 0 })
    assert.ok(f.targets.every(target => new URL(target).pathname === '/search'))
    assert.equal(new URL(f.targets[10]).searchParams.get('q'), 'sample 10')
    assert.doesNotMatch(f.logs.join('\n'), /Recovering|private-query|private-token/)
})

test('mobile accepts a normal Bing result page that contains an unrelated challenge iframe', async () => {
    const f = fixture({ incidentalChallenge: true })
    await f.search.bingSearch(f.page, 'sample', true)
    assert.deepEqual(f.counts(), { navigations: 1, submissions: 0 })
    assert.doesNotMatch(f.logs.join('\n'), /manual_required|failed/)
})

test('mobile confirms a normal result page after one transient verification diagnostic', async () => {
    const f = fixture({ transientVerification: true })
    await f.search.bingSearch(f.page, 'sample', true)
    assert.deepEqual(f.counts(), { navigations: 1, submissions: 0 })
    assert.doesNotMatch(f.logs.join('\n'), /manual_required|failed/)
})

test('mobile encodes the whole query without adding source or offer parameters', async () => {
    const f = fixture()
    const query = '中文 &q=other#hash + % ? https://example.com/'
    await f.search.bingSearch(f.page, query, true)
    const target = new URL(f.targets[0])
    assert.equal(target.origin, 'https://www.bing.com')
    assert.equal(target.pathname, '/search')
    assert.deepEqual([...target.searchParams], [['q', query]])
    assert.equal(target.hash, '')
    assert.ok(!f.logs.join('\n').includes(query))
})

for (const scenario of [
    { navigationFails: true },
    { status: 429 },
    { landingUrl: 'https://example.com/' },
    { landingUrl: 'https://www.bing.com/' }
]) test(`mobile uncertain navigation stops without retry: ${JSON.stringify(scenario)}`, async () => {
    const f = fixture(scenario)
    await assert.rejects(f.search.bingSearch(f.page, 'sample', true), /submission_uncertain/)
    assert.deepEqual(f.counts(), { navigations: 1, submissions: 0 })
    assert.doesNotMatch(f.logs.join('\n'), /private-query|private-token/)
})

for (const landingUrl of ['https://login.live.com/', 'https://www.bing.com/challenge']) {
    test(`mobile stops when navigation reaches ${new URL(landingUrl).hostname}${new URL(landingUrl).pathname}`, async () => {
        const f = fixture({ landingUrl })
        await assert.rejects(f.search.bingSearch(f.page, 'sample', true), /manual_required/)
        assert.deepEqual(f.counts(), { navigations: 1, submissions: 0 })
    })
}
