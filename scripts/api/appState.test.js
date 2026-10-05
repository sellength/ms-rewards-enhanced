import test from 'node:test'
import assert from 'node:assert/strict'
import { generateKeyPairSync, privateDecrypt, constants as cryptoConstants } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
    findAppPromotions,
    findAppSearch,
    findMobileDailySet,
    findReadToEarn,
    progressOf,
    resolveAppDailySetDate
} from '../../dist/functions/activities/app/AppState.js'
import { AppPromotions } from '../../dist/functions/activities/app/AppPromotions.js'
import { buildAppActivityPayload, submitAppActivity } from '../../dist/functions/activities/app/AppActivity.js'
import { buildAppHeaders } from '../../dist/functions/activities/app/AppRequest.js'
import { AppReward } from '../../dist/functions/activities/app/AppReward.js'
import { MobileDailySet } from '../../dist/functions/activities/app/MobileDailySet.js'
import { ReadToEarn } from '../../dist/functions/activities/app/ReadToEarn.js'
import { SearchProgress } from '../../dist/functions/activities/search/SearchProgress.js'
import {
    closeSessionStore,
    getOrCreateMobileDeviceId,
    getOrCreateMobileSapphireId
} from '../../dist/util/SessionStore.js'

function promotion(name, attributes, priority = 1) {
    return { name, attributes, priority, tags: [] }
}

function appData(promotions) {
    return { response: { promotions, profile: { ruid: 'test-ruid' } } }
}

for (const destination of [
    'https://rewards.bing.com/refer',
    'https://www.bing.com/search?filters=PollScenarioId%3A%22CURRENT%22',
    'https://www.bing.com/rewards/checkuser?ru=%2Fsearch%3Frqpiodemo%3D1'
]) {
    test(`Daily Set probes entry without answering or blocking the next ordinary offer: ${destination}`, async () => {
        const appDate = '09/05/2026'
        const card = (id, url) => promotion(id, {
            type: 'urlreward', daily_set_date: appDate, offerid: id,
            max: '10', progress: '0', complete: 'False', destination: url
        })
        const interactive = card('interactive', destination)
        const ordinary = card('ordinary', 'https://www.bing.com/search?q=ordinary&filters=BTEPOKey:REWARDSQUIZ_DailySet_UrlOffer%20BTROID:%22ordinary%22')
        const submissions = [], opens = [], logs = []
        const bot = {
            isMobile: true, dailySetDate: appDate, userData: { langCode: 'en' },
            browser: { func: { getAppDashboardData: async () => appData([interactive, ordinary, promotion('BingFlyout_Layout_DailyCheckIn', { markettime: '20260905T12:00:00' })]) } },
            activities: { doAppActivity: async item => { submissions.push(item.attributes.offerid); return { status: 200 } } },
            logger: { info: (...args) => logs.push(args.join(' ')), warn: (...args) => logs.push(args.join(' ')) },
            utils: { wait: async () => {}, randomDelay: () => 0 }
        }
        const worker = new MobileDailySet(bot)
        bot.mainMobilePage = { isClosed: () => false, goto: async () => { opens.push('interactive'); return { status: () => 200 } } }
        worker.applyBingAppBrowserProfile = async () => {}
        // Isolate ordinary navigation; exercise the real interaction probe and verification.
        worker.executeDestination = async (resolved, id) => { assert.equal(resolved.kind, 'url'); opens.push(id) }
        worker.verifyOffer = async () => true
        await worker.run(appData([interactive, ordinary]))
        assert.deepEqual(submissions, ['ordinary'])
        assert.deepEqual(opens, ['interactive', 'ordinary'])
        assert.ok(logs.some(line => line.includes('entry_probe_interaction_required offerId=interactive')))
    })
}

test('Daily Set uses fresh interaction classification and completion takes priority', async () => {
    const appDate = '09/05/2026'
    const initial = promotion('changed', { type: 'urlreward', daily_set_date: appDate,
        offerid: 'changed', max: '10', progress: '0', destination: 'https://www.bing.com/search?q=ordinary' })
    for (const complete of ['False', 'True']) {
        const latest = { ...initial, attributes: { ...initial.attributes, complete,
            destination: 'https://rewards.bing.com/refer' } }
        const logs = []
        let writes = 0
        const worker = new MobileDailySet({
            isMobile: true, dailySetDate: appDate, userData: { langCode: 'en' },
            browser: { func: { getAppDashboardData: async () => appData([latest, promotion('BingFlyout_Layout_DailyCheckIn', { markettime: '20260905T12:00:00' })]) } },
            activities: { doAppActivity: async () => { writes++; return { status: 200 } } },
            logger: { info: (...args) => logs.push(args.join(' ')), warn() {} },
            utils: { wait: async () => {}, randomDelay: () => 0 }
        })
        let opened = 0
        worker.probeEntry = async () => { opened++; logs.push('entry_probe_interaction_required') }
        await worker.run(appData([initial]))
        assert.equal(opened, complete === 'True' ? 0 : 1)
        assert.equal(writes, 0)
        assert.ok(logs.some(line => line.includes(complete === 'True' ? 'skip_complete' : 'entry_probe_interaction_required')))
    }
})

test('App activity payload matches the Rewards mini-app encrypted meta contract', () => {
    const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
    const payload = buildAppActivityPayload({
        offerId: 'daily-current-1',
        country: 'HK',
        ruid: 'test-ruid',
        deviceId: '11111111-2222-4333-8444-555555555555',
        publicKey: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
        requestId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
        timestamp: 1788451200000
    })

    assert.equal(payload.id, 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee')
    assert.equal(payload.amount, 1)
    assert.equal(payload.type, 101)
    assert.equal(payload.country, 'HK')
    assert.equal(payload.channel, 'SAAndroid')
    assert.deepEqual(payload.risk_context, {})
    assert.equal(payload.attributes.offerid, 'daily-current-1')

    const clearMeta = JSON.parse(privateDecrypt({
        key: privateKey,
        padding: cryptoConstants.RSA_PKCS1_PADDING
    }, Buffer.from(payload.meta, 'base64')).toString('utf8'))
    assert.deepEqual(clearMeta, {
        userId: 'test-ruid',
        timestamp: 1788451200000,
        device_info: {
            isEmulator: false,
            location: { latitude: '', longitude: '' },
            device_id: '11111111-2222-4333-8444-555555555555'
        }
    })
})

test('mobile activity device id is anonymous, stable per account, and isolated across accounts', t => {
    const sessionPath = mkdtempSync(join(tmpdir(), 'ms-rewards-device-id-'))
    t.after(() => {
        closeSessionStore()
        rmSync(sessionPath, { recursive: true, force: true })
    })

    const first = getOrCreateMobileDeviceId(sessionPath, 'one@example.invalid')
    const repeated = getOrCreateMobileDeviceId(sessionPath, 'one@example.invalid')
    const second = getOrCreateMobileDeviceId(sessionPath, 'two@example.invalid')
    const sapphire = getOrCreateMobileSapphireId(sessionPath, 'one@example.invalid')
    const repeatedSapphire = getOrCreateMobileSapphireId(sessionPath, 'one@example.invalid')
    assert.match(first, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i)
    assert.equal(repeated, first)
    assert.notEqual(second, first)
    assert.equal(repeatedSapphire, sapphire)
    assert.notEqual(sapphire, first)
})

test('selects only the SAAndroid search offer matching the active level', () => {
    const data = appData([
        promotion('level_info', { level: 'newLevel3' }),
        promotion('WW_NewLevel2_search_PC', {
            type: 'search', offerid: 'WW_search_global_NewLevel2', max: '50', progress: '50', give_eligible: 'True'
        }, 10),
        promotion('WW_NewLevel3_search_PC', {
            type: 'search', offerid: 'WW_search_global_NewLevel3', max: '60', progress: '15', give_eligible: 'True'
        }, 5)
    ])

    const result = findAppSearch(data)
    assert.equal(result.earned, 15)
    assert.equal(result.max, 60)
    assert.equal(result.remaining, 45)
    assert.equal(result.promotion.attributes.offerid, 'WW_search_global_NewLevel3')
})

test('mobile Daily Set filters the exact App date and excludes adjacent cycles', () => {
    const data = appData([
        promotion('Global_DailySet_20260830_Child1', {
            daily_set_date: '08/30/2026', offerid: 'old', max: '10', progress: '10', complete: 'True'
        }),
        promotion('Global_DailySet_20260831_Child1', {
            daily_set_date: '08/31/2026', offerid: 'today-1', max: '10', progress: '0', complete: 'False'
        }),
        promotion('Global_DailySet_20260831_Child2', {
            daily_set_date: '08/31/2026', offerid: 'today-2', max: '10', progress: '10', complete: 'True'
        }),
        promotion('FutureOfficialTaskIdentifier', {
            type: 'urlreward', daily_set_date: '08/31/2026', offerid: 'today-3', max: '10', progress: '0', complete: 'False'
        }),
        promotion('Global_DailySet_20260901_Child1', {
            daily_set_date: '09/01/2026', offerid: 'future', max: '10', progress: '0', complete: 'False'
        })
    ])

    assert.deepEqual(
        findMobileDailySet(data, '08/31/2026').map(item => item.attributes.offerid),
        ['today-1', 'today-2', 'today-3']
    )
})

test('mobile Daily Set date follows SAAndroid market time instead of PC or host dates', () => {
    const data = appData([
        promotion('BingFlyout_Layout_DailyCheckIn', { markettime: '20260901T12:58:49', markettimeoffset: '+08:00' }),
        promotion('Global_DailySet_20260831_Child1', {
            daily_set_date: '08/31/2026', offerid: 'old', max: '10', complete: 'True'
        }),
        promotion('Global_DailySet_20260901_Child1', {
            daily_set_date: '09/01/2026', offerid: 'current', max: '10', complete: 'False'
        })
    ])

    assert.equal(resolveAppDailySetDate(data), '09/01/2026')
    assert.equal(resolveAppDailySetDate(appData(data.response.promotions.slice(1))), null)
})

test('mobile Daily Set date resolves from complete child set when BingFlyout_Layout_DailyCheckIn is absent', () => {
    const data = appData([
        promotion('Gamification_DailySet_20260929_Child1', { daily_set_date: '09/29/2026', offerid: 'Gamification_DailySet_20260929_Child1' }),
        promotion('Gamification_DailySet_20260929_Child2', { daily_set_date: '09/29/2026', offerid: 'Gamification_DailySet_20260929_Child2' }),
        promotion('Gamification_DailySet_20260929_Child3', { daily_set_date: '09/29/2026', offerid: 'Gamification_DailySet_20260929_Child3' }),
        promotion('Gamification_DailySet_20260930_Child1', { daily_set_date: '09/30/2026', offerid: 'Gamification_DailySet_20260930_Child1' }),
        promotion('Gamification_DailySet_20260930_Child2', { daily_set_date: '09/30/2026', offerid: 'Gamification_DailySet_20260930_Child2' }),
        promotion('Gamification_DailySet_20260930_Child3', { daily_set_date: '09/30/2026', offerid: 'Gamification_DailySet_20260930_Child3' })
    ])

    assert.equal(resolveAppDailySetDate(data), '09/29/2026')
})

test('mobile More activities excludes dated Daily Set but keeps repurposed no-date offer IDs', () => {
    const data = appData([
        promotion('Global_DailySet_20260831_Child1', {
            type: 'urlreward', daily_set_date: '08/31/2026', offerid: 'daily', max: '10', complete: 'False', give_eligible: 'True'
        }),
        promotion('Global_DailySet_20260901_Child1', {
            type: 'urlreward', daily_set_date: '09/01/2026', offerid: 'future-daily', max: '10', complete: 'False', give_eligible: 'True'
        }),
        promotion('Gamification_DailySet_20260828_Child2', {
            type: 'urlreward', offerid: 'historical-daily', max: '10', complete: 'False', give_eligible: 'True'
        }),
        promotion('ENstar_Rewards_DailyGlobalOffer_Evergreen_Monday', {
            type: 'urlreward', offerid: 'puzzle', title: 'Complete this puzzle', max: '5', progress: '5', complete: 'True', give_eligible: 'True'
        }),
        promotion('ENstar_Rewards_DailyGlobalOffer_Evergreen_Sunday', {
            type: 'urlreward', offerid: 'quiz', title: 'Do you know the answer?', max: '5', progress: '0', complete: 'False', give_eligible: 'True'
        }),
        promotion('Sapphire_Current_Bonus', {
            type: 'sapphire', offerid: 'visible-sapphire', title: 'Current bonus', max: '10', progress: '0', complete: 'False', give_eligible: 'True'
        }),
        promotion('Sapphire_AppNewBonus_addWidget_info', {
            type: 'sapphire', offerid: 'hidden-history', max: '50', progress: '50', complete: 'True', give_eligible: 'True', hidden: 'True'
        }),
        promotion('TrialUser_offer', {
            type: 'urlreward', offerid: 'trial', max: '200', complete: 'False', give_eligible: 'False'
        })
    ])

    assert.deepEqual(
        findAppPromotions(data).map(item => item.attributes.offerid),
        ['historical-daily', 'puzzle', 'quiz', 'visible-sapphire']
    )
})

test('AppPromotions submits ordinary pending offers but skips manual Bing App interactions', async () => {
    const complete = promotion('ENstar_completed', {
        type: 'urlreward', offerid: 'done', max: '5', progress: '5', complete: 'True', give_eligible: 'True'
    })
    const pending = promotion('ENstar_pending', {
        type: 'urlreward', offerid: 'pending', max: '5', progress: '0', complete: 'False', give_eligible: 'True'
    })
    const misleadingState = promotion('ENUS_exploreonbing_activation_Evergreen', {
        type: 'urlreward', offerid: 'state-is-not-completion', max: '10', progress: '0',
        complete: 'False', State: 'Complete', give_eligible: 'True', isExploreOnBingTask: 'True'
    })
    const fallbackInteractive = promotion('renamed-interactive-card', {
        type: 'urlreward', offerid: 'ENUS_exploreonbing_activation_new', max: '10', progress: '0',
        complete: 'False', give_eligible: 'True'
    })
    const daily = promotion('Global_DailySet_20260831_Child1', {
        type: 'urlreward', daily_set_date: '08/31/2026', offerid: 'daily', max: '10', progress: '0', complete: 'False', give_eligible: 'True'
    })
    const submitted = []
    const logs = []
    const bot = {
        isMobile: true,
        browser: { func: { getAppDashboardData: async () => appData([complete, pending, misleadingState, fallbackInteractive, daily]) } },
        activities: { doAppReward: async item => submitted.push(item.attributes.offerid) },
        logger: { info(_mobile, _tag, message) { logs.push(message) }, warn() {} },
        utils: { wait: async () => {}, randomDelay: () => 0 }
    }

    await new AppPromotions(bot).run(appData([complete, pending, misleadingState, fallbackInteractive, daily]))

    assert.deepEqual(submitted, ['pending'])
    assert.equal(logs.filter(message => message.includes('skip_manual_app_interaction')).length, 2)
})

test('AppPromotions executes Explore on Bing cards dynamically and only skips cards locked tomorrow by Microsoft', async () => {
    const cardDone1 = promotion('ENUS_exploreonbing_card1', {
        type: 'urlreward', offerid: 'card1', max: '10', progress: '10', complete: 'True', give_eligible: 'True', isExploreOnBingTask: 'True'
    })
    const cardDone2 = promotion('ENUS_exploreonbing_card2', {
        type: 'urlreward', offerid: 'card2', max: '10', progress: '10', complete: 'True', give_eligible: 'True', isExploreOnBingTask: 'True'
    })
    const cardPending3 = promotion('ENUS_exploreonbing_card3', {
        type: 'urlreward', offerid: 'card3', max: '10', progress: '0', complete: 'False', give_eligible: 'True', isExploreOnBingTask: 'True'
    })
    const cardPending4 = promotion('ENUS_exploreonbing_card4', {
        type: 'urlreward', offerid: 'card4', max: '10', progress: '0', complete: 'False', give_eligible: 'True', isExploreOnBingTask: 'True'
    })
    const cardLocked5 = promotion('ENUS_exploreonbing_card5', {
        type: 'urlreward', offerid: 'card5', max: '10', progress: '0', complete: 'False', give_eligible: 'True', isExploreOnBingTask: 'True',
        status: 'locked', subtext: 'unlocks tomorrow'
    })

    const executed = []
    const logs = []
    const bot = {
        isMobile: true,
        userData: { currentPoints: 1000 },
        config: { activities: { searchOnBing: true } },
        browser: { func: { getAppDashboardData: async () => appData([cardDone1, cardDone2, cardPending3, cardPending4, cardLocked5]) } },
        activities: {
            doSearchOnBing: async (promo) => {
                executed.push(promo.offerId)
                bot.userData.currentPoints += 10
                return true
            },
            doAppReward: async () => {}
        },
        logger: { info(_mobile, _tag, message) { logs.push(message) }, warn() {} },
        utils: { wait: async () => {}, randomDelay: () => 0 }
    }

    await new AppPromotions(bot).run(appData([cardDone1, cardDone2, cardPending3, cardPending4, cardLocked5]))

    assert.deepEqual(executed, ['card3', 'card4'], 'Should execute card3 and card4 without artificial 2-card quota limit')
    assert.ok(logs.some(msg => msg.includes('[PLAN] appPromotion skip_tomorrow_locked offerId=card5')))
})

test('AppPromotions fuses subsequent Explore on Bing cards when consecutive executions yield 0 points', async () => {
    const card1 = promotion('ENUS_exploreonbing_card1', {
        type: 'urlreward', offerid: 'card1', max: '10', progress: '0', complete: 'False', give_eligible: 'True', isExploreOnBingTask: 'True'
    })
    const card2 = promotion('ENUS_exploreonbing_card2', {
        type: 'urlreward', offerid: 'card2', max: '10', progress: '0', complete: 'False', give_eligible: 'True', isExploreOnBingTask: 'True'
    })
    const card3 = promotion('ENUS_exploreonbing_card3', {
        type: 'urlreward', offerid: 'card3', max: '10', progress: '0', complete: 'False', give_eligible: 'True', isExploreOnBingTask: 'True'
    })

    const executed = []
    const logs = []
    const bot = {
        isMobile: true,
        userData: { currentPoints: 1000 },
        config: { activities: { searchOnBing: true } },
        browser: { func: { getAppDashboardData: async () => appData([card1, card2, card3]) } },
        activities: {
            doSearchOnBing: async (promo) => {
                executed.push(promo.offerId)
                // 模拟触及微软云端冷却或配额导致加 0 分返回 false
                return false
            },
            doAppReward: async () => {}
        },
        logger: { info(_mobile, _tag, message) { logs.push(message) }, warn() {} },
        utils: { wait: async () => {}, randomDelay: () => 0 }
    }

    await new AppPromotions(bot).run(appData([card1, card2, card3]))

    assert.deepEqual(executed, ['card1', 'card2'], 'Only card1 and card2 should be attempted; card3 should be skipped by consecutive 0 points fuse')
    assert.ok(logs.some(msg => msg.includes('Explore on Bing cloud cooldown or limit reached after consecutive zero gains, skipping | offerId=card3')))
})

test('Read state prefers point progress fields and respects completion', () => {
    const data = appData([
        promotion('read', {
            type: 'msnreadearn', offerid: 'ENUS_readarticle3_30points', pointmax: '30', pointprogress: '12', complete: 'False'
        })
    ])
    assert.deepEqual(findReadToEarn(data), {
        earned: 12,
        max: 30,
        remaining: 18,
        complete: false,
        promotion: data.response.promotions[0]
    })
    assert.equal(progressOf(promotion('done', { max: '10', progress: '0', complete: 'True' })).remaining, 0)
})

test('ReadToEarn posts the current SAAndroid offer id instead of a fixed historical id', async () => {
    const offerId = 'future_dynamic_read_offer_42'
    const pending = promotion('renamed-read-task', {
        type: 'msnreadearn', offerid: offerId, pointmax: '3', pointprogress: '0', complete: 'False'
    })
    const completed = promotion('renamed-read-task', {
        type: 'msnreadearn', offerid: offerId, pointmax: '3', pointprogress: '3', complete: 'True'
    })
    let current = pending
    const requests = []
    const bot = {
        isMobile: true,
        accessToken: 'test-token',
        config: { searchSettings: { readDelay: { min: 0, max: 0 } } },
        userData: { currentPoints: 100, gainedPoints: 0, geoLocale: 'HK', langCode: 'en' },
        browser: { func: { getAppDashboardData: async () => appData([current]) } },
        http: {
            request: async request => {
                requests.push(request)
                current = completed
                return { status: 200, data: { response: { balance: 103 } } }
            }
        },
        logger: { debug() {}, info() {}, warn() {}, error() {} },
        utils: { wait: async () => {}, randomDelay: () => 0 }
    }

    await new ReadToEarn(bot).doReadToEarn()

    assert.equal(requests.length, 1)
    assert.equal(JSON.parse(requests[0].data).attributes.offerid, offerId)
    assert.equal(bot.userData.currentPoints, 103)
})

test('ReadToEarn fails closed when the current SAAndroid offer has no offer id', async () => {
    const requests = []
    const warnings = []
    const bot = {
        isMobile: true,
        accessToken: 'test-token',
        config: { searchSettings: { readDelay: { min: 0, max: 0 } } },
        userData: { currentPoints: 100, gainedPoints: 0, geoLocale: 'HK', langCode: 'en' },
        browser: { func: { getAppDashboardData: async () => appData([
            promotion('read-without-id', { type: 'msnreadearn', pointmax: '30', pointprogress: '0' })
        ]) } },
        http: { request: async request => requests.push(request) },
        logger: { debug() {}, info() {}, warn(_mobile, _tag, message) { warnings.push(message) }, error() {} },
        utils: { wait: async () => {}, randomDelay: () => 0 }
    }

    await new ReadToEarn(bot).doReadToEarn()

    assert.equal(requests.length, 0)
    assert.match(warnings.join('\n'), /current_offer_id_missing/)
})

test('SAAndroid State does not override explicit task completion and progress', () => {
    const misleadingState = promotion('explore', {
        type: 'urlreward', offerid: 'explore', max: '10', progress: '0', complete: 'False', State: 'Complete'
    })
    const fullProgress = promotion('full', {
        type: 'urlreward', offerid: 'full', max: '10', progress: '10', complete: 'False', State: 'Default'
    })

    assert.equal(progressOf(misleadingState).complete, false)
    assert.equal(progressOf(misleadingState).earned, 0)
    assert.equal(progressOf(fullProgress).complete, true)
})

test('App headers contain protocol context without a real device model or Build', () => {
    const headers = buildAppHeaders({
        accessToken: 'test-token',
        userData: { geoLocale: 'HK', langCode: 'en' }
    })

    assert.equal(headers['X-Rewards-PartnerId'], 'startapp')
    assert.equal(headers['X-Rewards-Flights'], 'rwgobig')
    assert.equal(headers['X-Rewards-AppId'], 'SAAndroid/34.0.440821006')
    assert.equal(headers['X-Rewards-Country'], 'HK')
    assert.doesNotMatch(headers['User-Agent'], /Build\//)
})

test('mobile SearchProgress reads SAAndroid and does not consult Rewards Web counters', async () => {
    let webReads = 0
    const bot = {
        browser: {
            func: {
                getAppDashboardData: async () => appData([
                    promotion('level_info', { level: 'newLevel3' }),
                    promotion('WW_NewLevel3_search_PC', {
                        type: 'search', offerid: 'WW_search_global_NewLevel3', max: '60', progress: '30', give_eligible: 'True'
                    })
                ]),
                getDashboardData: async () => {
                    webReads++
                    throw new Error('Rewards Web must not be used for mobile search')
                }
            }
        }
    }

    const missing = await new SearchProgress(bot).getMissing(true)
    assert.equal(missing.mobilePoints, 30)
    assert.equal(missing.totalPoints, 30)
    assert.equal(webReads, 0)
})

test('mobile Daily Set fails closed instead of sending an unverified generic AppReward', async () => {
    const appDate = '08/31/2026'
    const appDateId = appDate.replace(/(\d{2})\/(\d{2})\/(\d{4})/, '$3$1$2')
    const pending = promotion(`Gamification_DailySet_${appDateId}_Child1`, {
        daily_set_date: appDate, offerid: 'today-1', max: '10', progress: '0', complete: 'False'
    })
    let appReads = 0
    let appSubmissions = 0
    let webReads = 0
    let destinationOpens = 0
    const warnings = []
    const bot = {
        isMobile: true,
        dailySetDate: appDate,
        browser: {
            func: {
                getAppDashboardData: async () => {
                    appReads++
                    return appData([pending])
                },
                getDashboardData: async () => {
                    webReads++
                    throw new Error('PC Rewards Web must not be used for mobile Daily Set')
                }
            }
        },
        activities: {
            doAppActivity: async item => {
                appSubmissions++
                assert.equal(item.attributes.offerid, 'today-1')
                return { status: 200 }
            }
        },
        mainMobilePage: {
            goto: async () => {
                destinationOpens++
            }
        },
        logger: { info() {}, warn(...args) { warnings.push(args.join(' ')) } },
        utils: { wait: async () => {}, randomDelay: () => 0 }
    }

    await new MobileDailySet(bot).run(appData([pending]))

    assert.equal(appSubmissions, 0)
    assert.equal(appReads, 1)
    assert.equal(webReads, 0)
    assert.equal(destinationOpens, 0)
    assert.ok(warnings.some(message => message.includes('skip_manual_required')))
})





test('mobile Daily Set rejects a destination linked to a different offer ID', async () => {
    const appDate = '08/31/2026'
    const pending = promotion('DynamicDailySetChild', {
        type: 'urlreward', daily_set_date: appDate, offerid: 'today-1', max: '10', progress: '0', complete: 'False',
        destination: 'https://www.bing.com/search?q=task&filters=BTDSUOID%3A%22another-offer%22'
    })
    let destinationOpens = 0
    const warnings = []
    const bot = {
        isMobile: true,
        dailySetDate: appDate,
        browser: { func: { getAppDashboardData: async () => appData([pending]) } },
        mainMobilePage: { goto: async () => { destinationOpens++ } },
        logger: { info() {}, warn(...args) { warnings.push(args.join(' ')) } },
        utils: { wait: async () => {}, randomDelay: () => 0 }
    }

    await new MobileDailySet(bot).run(appData([pending]))

    assert.equal(destinationOpens, 0)
    assert.ok(warnings.some(message => message.includes('missing_or_untrusted_destination')))
})

test('mobile Daily Set skips a card that became complete after the initial snapshot', async () => {
    const appDate = '08/31/2026'
    const appDateId = appDate.replace(/(\d{2})\/(\d{2})\/(\d{4})/, '$3$1$2')
    const pending = promotion(`Global_DailySet_${appDateId}_Child1`, {
        daily_set_date: appDate, offerid: 'today-1', max: '10', progress: '0', complete: 'False'
    })
    const completed = promotion(`Global_DailySet_${appDateId}_Child1`, {
        daily_set_date: appDate, offerid: 'today-1', max: '10', progress: '10', complete: 'True'
    })
    let appSubmissions = 0
    const bot = {
        isMobile: true,
        dailySetDate: appDate,
        browser: { func: { getAppDashboardData: async () => appData([completed]) } },
        activities: { doAppActivity: async () => { appSubmissions++; return { status: 200 } } },
        logger: { info() {}, warn() {} },
        utils: { wait: async () => {}, randomDelay: () => 0 }
    }

    await new MobileDailySet(bot).run(appData([pending]))

    assert.equal(appSubmissions, 0)
})

test('AppReward reports one offer with the complete SAAndroid activity payload and verifies the same offer', async t => {
    const pending = promotion('Global_DailySet_Child1', {
        offerid: 'today-1', max: '10', progress: '0', complete: 'False'
    })
    const completed = promotion('Global_DailySet_Child1', {
        offerid: 'today-1', max: '10', progress: '10', complete: 'True'
    })
    const requests = []
    const sessionPath = mkdtempSync(join(tmpdir(), 'ms-rewards-app-activity-'))
    t.after(() => {
        closeSessionStore()
        rmSync(sessionPath, { recursive: true, force: true })
    })
    const bot = {
        isMobile: true,
        accessToken: 'test-token',
        currentAccountEmail: 'tester@example.invalid',
        config: { sessionPath },
        userData: { currentPoints: 100, gainedPoints: 0, geoLocale: 'HK', langCode: 'en' },
        http: {
            request: async request => {
                requests.push(request)
                return { status: 200, data: { response: { balance: 110 } } }
            }
        },
        browser: { func: { getAppDashboardData: async () => appData([completed]) } },
        logger: { debug() {}, info() {}, warn() {}, error() {} },
        utils: { wait: async () => {} }
    }

    await new AppReward(bot).doAppReward(pending)

    assert.equal(requests.length, 1)
    assert.equal(requests[0].method, 'POST')
    assert.equal(requests[0].headers['X-Rewards-AppId'], 'SAAndroid/34.0.440821006')
    assert.match(requests[0].headers['sapphire-id'], /^[0-9a-f-]{36}$/i)
    assert.match(requests[0].headers['session-id'], /^[0-9a-f-]{36}$/i)
    assert.equal(requests[0].headers.os, 'android')
    const body = JSON.parse(requests[0].data)
    assert.equal(body.amount, 1)
    assert.equal(body.type, 101)
    assert.equal(body.country, 'HK')
    assert.equal(body.channel, 'SAAndroid')
    assert.deepEqual(body.risk_context, {})
    assert.equal(typeof body.meta, 'string')
    assert.ok(body.meta.length > 100)
    assert.equal(body.attributes.offerid, 'today-1')
    assert.match(body.id, /^[0-9a-f]{8}-[0-9a-f-]{27}$/i)
    assert.equal(bot.userData.currentPoints, 110)
    assert.equal(bot.userData.gainedPoints, 10)
})


test('submitAppActivity falls back to profile endpoint when ruid is missing in initial appData', async t => {
    const pending = promotion('Gamification_DailySet_20260905_Child2', {
        offerid: 'child-2', max: '10', progress: '0', complete: 'False'
    })
    const sessionPath = mkdtempSync(join(tmpdir(), 'ms-rewards-fallback-'))
    t.after(() => {
        closeSessionStore()
        rmSync(sessionPath, { recursive: true, force: true })
    })
    const requests = []
    const bot = {
        isMobile: true,
        accessToken: 'test-token',
        currentAccountEmail: 'tester@example.invalid',
        config: { sessionPath },
        userData: { currentPoints: 100, gainedPoints: 0, geoLocale: 'HK', langCode: 'en' },
        http: {
            request: async request => {
                requests.push(request)
                if (request.url.includes('/dapi/me?channel=SAAndroid&options=1')) {
                    return {
                        status: 200,
                        data: {
                            response: {
                                profile: {
                                    ruid: 'fallback-ruid-123',
                                    attributes: { country: 'HK' }
                                }
                            }
                        }
                    }
                }
                return { status: 200, data: { response: { balance: 110 } } }
            }
        }
    }

    const appDataWithoutProfile = { response: { promotions: [pending] } }
    const res = await submitAppActivity(bot, pending, appDataWithoutProfile)

    assert.equal(res.status, 200)
    assert.equal(requests.length, 2)
    assert.ok(requests[0].url.includes('options=1'))
    assert.equal(requests[1].url, 'https://prod.rewardsplatform.microsoft.com/dapi/me/activities')
    const body = JSON.parse(requests[1].data)
    assert.equal(body.attributes.offerid, 'child-2')
})

test('Explore on Bing correctly classifies tasks and reports tomorrow_locked, completed, activated, and pending_activation states', async () => {
    const { isExploreOnBingPromotion, getExploreOnBingStatus, isTomorrowLockedPromotion } = await import('../../promotion-classification.mjs')

    const exploreNormal = promotion('ENUS_exploreonbing_vocab_10pts', {
        type: 'urlreward', offerid: 'ENUS_exploreonbing_vocab_10pts', max: '10', progress: '0', complete: 'False', title: 'Expand your vocabulary'
    })
    const exploreLocked = promotion('ENUS_exploreonbing_timezone_10pts', {
        type: 'urlreward', offerid: 'ENUS_exploreonbing_timezone_10pts', max: '10', progress: '0', complete: 'False', status: 'locked', title: 'What is the time?'
    })
    const exploreActive = promotion('ENUS_exploreonbing_coupons_10pts', {
        type: 'urlreward', offerid: 'ENUS_exploreonbing_coupons_10pts', max: '10', progress: '0', complete: 'False', title: 'Find discount coupons'
    })
    const exploreDone = promotion('ENUS_exploreonbing_hotels_10pts', {
        type: 'urlreward', offerid: 'ENUS_exploreonbing_hotels_10pts', max: '10', progress: '10', complete: 'True', title: 'Compare hotel rates'
    })
    const unrelatedPromo = promotion('ENUS_daily_quiz', {
        type: 'urlreward', offerid: 'daily_quiz', max: '30', progress: '0', complete: 'False', title: 'Daily Quiz'
    })

    assert.equal(isExploreOnBingPromotion(exploreNormal), true)
    assert.equal(isExploreOnBingPromotion(exploreLocked), true)
    assert.equal(isExploreOnBingPromotion(exploreActive), true)
    assert.equal(isExploreOnBingPromotion(exploreDone), true)
    assert.equal(isExploreOnBingPromotion(unrelatedPromo), false)

    assert.equal(isTomorrowLockedPromotion(exploreLocked), true)
    assert.equal(isTomorrowLockedPromotion(exploreNormal), false)

    assert.equal(getExploreOnBingStatus(exploreLocked), 'tomorrow_locked')
    assert.equal(getExploreOnBingStatus(exploreDone), 'completed')
    assert.equal(getExploreOnBingStatus(exploreActive, { activeExploreOfferIds: ['ENUS_exploreonbing_coupons_10pts'] }), 'activated')
    assert.equal(getExploreOnBingStatus(exploreNormal), 'pending_activation')
})

test('isTomorrowLockedPromotion detects Chinese keywords, English status and exclusive locked feature status', async () => {
    const { isTomorrowLockedPromotion } = await import('../../promotion-classification.mjs')

    // 1. 中文常见描述
    assert.equal(isTomorrowLockedPromotion({ title: '明天激活 10 积分' }), true)
    assert.equal(isTomorrowLockedPromotion({ title: '明日激活' }), true)
    assert.equal(isTomorrowLockedPromotion({ attributes: { description: '此任务明天解锁' } }), true)
    assert.equal(isTomorrowLockedPromotion({ attributes: { subtext: '次日解锁后可获得积分' } }), true)

    // 2. 官方属性
    assert.equal(isTomorrowLockedPromotion({ attributes: { status: 'locked' } }), true)
    assert.equal(isTomorrowLockedPromotion({ attributes: { activity_status: 'locked' } }), true)
    assert.equal(isTomorrowLockedPromotion({ attributes: { category: 'tomorrow' } }), true)
    assert.equal(isTomorrowLockedPromotion({ exclusiveLockedFeatureStatus: 'locked' }), true)

    // 3. 正常待完成任务不误报
    assert.equal(isTomorrowLockedPromotion({ title: '每日签到', attributes: { status: 'active' } }), false)
    assert.equal(isTomorrowLockedPromotion({ title: '必应搜索 10 积分', attributes: {} }), false)
})

test('Explore on Bing correctly classifies live SAAndroid attributes (is_unlocked False for tomorrow, isInProgress True for activated)', async () => {
    const { getExploreOnBingStatus, isTomorrowLockedPromotion } = await import('../../promotion-classification.mjs')

    const exploreTomorrowLocked = {
        name: 'ENUS_airlinetickets_exploreonbing_activation_Evergreen',
        attributes: {
            offerid: 'ENUS_airlinetickets_exploreonbing_activation_Evergreen',
            title: 'Take off soon',
            complete: 'False',
            is_unlocked: 'False',
            isInProgress: 'False',
            locked_category_criteria: 'tomorrow',
            max: '10',
            progress: '0'
        }
    }

    const exploreActivated = {
        name: 'ENUS_bankaccounts_exploreonbing_activation_Evergreen',
        attributes: {
            offerid: 'ENUS_bankaccounts_exploreonbing_activation_Evergreen',
            title: 'Bank smarter',
            complete: 'False',
            State: 'Complete',
            is_unlocked: 'True',
            isInProgress: 'True',
            max: '10',
            progress: '0'
        }
    }

    const explorePending = {
        name: 'ENUS_concerttickets_exploreonbing_activation_Evergreen',
        attributes: {
            offerid: 'ENUS_concerttickets_exploreonbing_activation_Evergreen',
            title: 'Catch the show',
            complete: 'False',
            State: 'Default',
            is_unlocked: 'True',
            isInProgress: 'False',
            max: '10',
            progress: '0'
        }
    }

    assert.equal(isTomorrowLockedPromotion(exploreTomorrowLocked), true)
    assert.equal(isTomorrowLockedPromotion(exploreActivated), false)
    assert.equal(isTomorrowLockedPromotion(explorePending), false)

    assert.equal(getExploreOnBingStatus(exploreTomorrowLocked), 'tomorrow_locked')
    assert.equal(getExploreOnBingStatus(exploreActivated), 'activated')
    assert.equal(getExploreOnBingStatus(explorePending), 'pending_activation')
})

test('activateSearchOnBing automatically activates unactivated explore card via mobile submitAppActivity', async () => {
    const { activateSearchOnBing } = await import('../../dist/functions/activities/search/SearchOnBingShared.js')

    const submitted = []
    const bot = {
        isMobile: true,
        accessToken: 'mock-token',
        currentAccountEmail: 'test@example.com',
        userData: { currentPoints: 100, gainedPoints: 0, geoLocale: 'US' },
        logger: {
            info: () => {},
            warn: () => {},
            error: () => {}
        },
        browser: {
            func: {
                getAppDashboardData: async () => ({
                    response: {
                        profile: { ruid: 'test-ruid-123', attributes: { country: 'US' } },
                        promotions: []
                    }
                })
            }
        },
        http: {
            request: async (req) => {
                submitted.push(req)
                return { status: 200, data: { response: { balance: 100 } } }
            }
        },
        config: { sessionPath: 'sessions' }
    }

    // 1. When already activated in cloud: returns true without calling HTTP
    const alreadyActive = {
        offerId: 'ENUS_bankaccounts_exploreonbing_activation_Evergreen',
        attributes: {
            offerid: 'ENUS_bankaccounts_exploreonbing_activation_Evergreen',
            isInProgress: 'True',
            State: 'Complete'
        },
        complete: false
    }
    const res1 = await activateSearchOnBing(bot, alreadyActive)
    assert.equal(res1, true)
    assert.equal(submitted.length, 0)

    // 2. When pending activation: calls submitAppActivity and activates
    const pendingActive = {
        offerId: 'ENUS_concerttickets_exploreonbing_activation_Evergreen',
        attributes: {
            offerid: 'ENUS_concerttickets_exploreonbing_activation_Evergreen',
            isInProgress: 'False',
            State: 'Default'
        },
        complete: false
    }
    const res2 = await activateSearchOnBing(bot, pendingActive)
    assert.equal(res2, true)
    assert.equal(submitted.length, 1)
    assert.ok(submitted[0].url.includes('/dapi/me/activities'))
    const payload = JSON.parse(submitted[0].data)
    assert.equal(payload.attributes.offerid, 'ENUS_concerttickets_exploreonbing_activation_Evergreen')
})


