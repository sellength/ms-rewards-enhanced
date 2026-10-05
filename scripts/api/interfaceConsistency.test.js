import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { earnKeepEarningIds, selectPcKeepEarningPromotions, appProgressFields,
    isCurrentAppDailySetCandidate, edgeWebProgress } from '../../promotion-classification.mjs'
import { findMobileDailySet, progressOf } from '../../dist/functions/activities/app/AppState.js'
import { EdgeBrowsing } from '../../dist/functions/activities/experimental/EdgeBrowsing.js'
import { MorePromotions } from '../../dist/functions/activities/rewards/MorePromotions.js'

const flight = rows => Object.entries(rows).map(([id, value]) => `${id}:${JSON.stringify(value)}`).join('\n')
test('Earn scope resolves streamed section references, not unrelated offers or fallback skeletons', () => {
    const raw = flight({
        a: ['$', '$Lff', null, { messages: { Earn: { MoreActivities: {} } }, children: '$Lb' }],
        b: ['$', '$Lcc', null, { activityCards: [{ offerId: 'current' }, { offerId: 'daily' }] }],
        c: { offerId: 'legacy' },
        d: { fallback: { id: 'moreactivities', children: '$Lmissing' } }
    })
    const html = `<script>self.__next_f.push([1,${JSON.stringify(raw.slice(0, 40))}])</script>` +
        `<script>self.__next_f.push([1,${JSON.stringify(raw.slice(40))}])</script>`
    for (const input of [raw, html]) {
        const ids = earnKeepEarningIds(input)
        assert.deepEqual(ids, ['current', 'daily'])
        assert.deepEqual(selectPcKeepEarningPromotions(
            ['current', 'legacy', 'daily'].map(offerId => ({ offerId })), [{ offerId: 'daily' }], ids),
        [{ offerId: 'current' }])
    }
})
test('unknown Earn collection is distinct from a confirmed empty collection', () => {
    assert.equal(earnKeepEarningIds('<html>login</html>'), null)
    assert.equal(earnKeepEarningIds(flight({ a: { id: 'moreactivities', children: '$Lb' } })), null)
    assert.deepEqual(earnKeepEarningIds(flight({ a: { id: 'moreactivities', children: [] } })), [])
    assert.deepEqual(selectPcKeepEarningPromotions([{ offerId: 'legacy' }], [], null), [])
})
test('mobile display and worker use the same numeric fields including explicit zero', () => {
    const attrs = { pointmax: '10', max: '50', pointprogress: '0', progress: '50', complete: 'False' }
    assert.deepEqual(appProgressFields(attrs), { max: 10, progress: 0, complete: false })
    assert.equal(progressOf({ attributes: attrs }).complete, false)
    assert.equal(progressOf({ attributes: attrs }).max, 10)
    assert.equal(appProgressFields({ ...attrs, pointprogress: '10' }).complete, true)
    assert.equal(appProgressFields({ complete: 'Complete', max: '10' }).complete, false)
})
test('mobile Daily Set excludes hidden and ineligible cards in both consumers', () => {
    const date = '09/10/2026'
    const card = { name: 'sample', attributes: { offerid: 'a', daily_set_date: date, pointmax: '10', type: 'urlreward' } }
    const cards = [card, ...[{ hidden: 'True' }, { give_eligible: 'False' }].map(extra =>
        ({ ...card, attributes: { ...card.attributes, ...extra } }))]
    assert.deepEqual(cards.map(p => isCurrentAppDailySetCandidate(p, date)), [true, false, false])
    assert.deepEqual(findMobileDailySet({ response: { promotions: cards } }, date), [card])
})
test('Edge Web counter remains independent of reporting completion', async () => {
    const raw = '"EarnStreaksSection_StreakCard","data":{"partner":"edge","complete":25,"total":30}'
    assert.deepEqual(edgeWebProgress(raw), { earned: 25, max: 30, complete: false })
    assert.equal(edgeWebProgress('unavailable'), null)
    const logs = []
    const bot = { isMobile: false, browser: { func: { getEdgeWebProgress: async () => edgeWebProgress(raw) } },
        logger: { info: (_m, _t, msg) => logs.push(msg) } }
    const worker = new EdgeBrowsing(bot)
    assert.equal(await worker.verifyWebCompletion(), false)
    assert.match(logs[0], /webProgress=25\/30.*verification=pending/)
})
test('SAAndroid task read uses 612 while profile metadata retains its separate endpoint', () => {
    const urls = fs.readFileSync(new URL('../../src/constants/urls.ts', import.meta.url), 'utf8')
    assert.match(urls, /me:.*options=612/)
    const activity = fs.readFileSync(new URL('../../src/functions/activities/app/AppActivity.ts', import.meta.url), 'utf8')
    assert.match(activity, /URLs.platform.profile\(BING_APP_CHANNEL\)/)
})

test('unknown Earn collection stops the worker without posting or claiming all complete', async () => {
    const messages = []
    const bot = { isMobile: false, browser: { func: { getKeepEarningOfferIds: async () => null } },
        logger: { warn: (_m, _t, message) => messages.push(message) } }
    await new MorePromotions(bot).run({ dashboard: { morePromotions: [{ offerId: 'legacy' }] } })
    assert.match(messages[0], /skip_state_unavailable/)
})

test('EdgeHub completion stops reports but does not claim Web completion at 25/30', async () => {
    const messages = []
    let posts = 0
    const bot = { isMobile: false, accessToken: 'test-only', reactSnapshots: { desktop: null },
        utils: { randomDelay: () => 0 },
        browser: { func: { getEdgeWebProgress: async () => ({ earned: 25, max: 30, complete: false }) } },
        logger: Object.fromEntries(['info', 'warn', 'error', 'debug'].map(key =>
            [key, (_m, _t, message) => messages.push(message)])) }
    const worker = new EdgeBrowsing(bot)
    worker.getEdgeProfile = async () => ({})
    worker.findPromotion = () => ({ attributes: {} })
    worker.resolveSettings = () => ({ offerId: 'sample', activityType: '29', reportIntervalMinutes: 5, promotion: { attributes: {} } })
    worker.wait = async () => true
    worker.submitReport = async () => { posts++; return { status: 200, duplicate: false, cookieNames: [] } }
    worker.refreshServerCompletion = async () => true
    await worker.run({})
    assert.equal(posts, 1)
    assert.ok(messages.some(m => /serverComplete=false \| edgeHubComplete=true/.test(m)))
    assert.ok(messages.some(m => /verification=pending/.test(m)))
    assert.ok(!messages.some(m => /Microsoft reports Edge browsing activity complete/.test(m)))
})
