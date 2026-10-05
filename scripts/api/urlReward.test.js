import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import test from 'node:test'

const require = createRequire(import.meta.url)
const { UrlReward } = require('../../dist/functions/activities/api/UrlReward')

test('UrlReward uses the dashboard promotion hash when the mobile page snapshot has no hash', async () => {
    let submittedBody
    let destinationOpened = false
    let ensureOfferCallCount = 0

    const bot = {
        isMobile: true,
        nextActions: { reportActivity: 'action-id' },
        config: { skipNonPointTasks: true },
        userData: {
            currentPoints: 100,
            gainedPoints: 0,
            geoLocale: 'US',
            timezoneOffset: '-480'
        },
        logger: {
            debug() {},
            info() {},
            warn() {},
            error() {}
        },
        browser: {
            func: {
                ensureOffer: async () => {
                    ensureOfferCallCount++
                    if (ensureOfferCallCount === 1) return null
                    return { isCompleted: true, points: 10 }
                },
                reportServerAction: async (_actionId, body) => {
                    submittedBody = body
                    return { status: 200, acknowledged: true, availablePoints: 110 }
                }
            },
            react: { routerStateTree: () => 'router-state' }
        },
        mainMobilePage: {
            goto: async () => {
                destinationOpened = true
            }
        },
        utils: {
            wait: async () => {},
            randomDelay: () => 0
        },
        refreshCurrentRewardsContext: async () => false
    }

    const promotion = {
        offerId: 'Global_DailySet_20260830_Child1',
        hash: 'dashboard-hash',
        complete: false,
        pointProgress: 0,
        pointProgressMax: 10,
        activityType: '11',
        destinationUrl: 'https://www.bing.com/search?q=test',
        exclusiveLockedFeatureStatus: ''
    }

    const completed = await new UrlReward(bot).doUrlReward(promotion)

    assert.equal(completed, true)
    assert.equal(submittedBody[0], 'dashboard-hash')
    assert.equal(submittedBody[2].offerid, promotion.offerId)
    assert.equal(destinationOpened, false)
    assert.equal(bot.userData.currentPoints, 110)
    assert.equal(bot.userData.gainedPoints, 10)
})

test('UrlReward does not report success when a destination visit remains incomplete in the cloud', async () => {
    let destinationOpened = false
    const warnings = []

    const bot = {
        isMobile: true,
        nextActions: { reportActivity: 'action-id' },
        config: { skipNonPointTasks: true },
        userData: {
            currentPoints: 100,
            gainedPoints: 0,
            geoLocale: 'US',
            timezoneOffset: '-480'
        },
        logger: {
            debug() {},
            info() {},
            warn(_mobile, _source, message) {
                warnings.push(message)
            },
            error() {}
        },
        browser: {
            func: {
                ensureOffer: async () => null,
                synchronizeActiveBrowserCookies: async () => true,
                getDashboardData: async () => ({
                    dashboard: {
                        userStatus: { availablePoints: 100 },
                        dailySetPromotions: {
                            '08/30/2026': [
                                {
                                    offerId: 'Global_DailySet_20260830_Child1',
                                    complete: false,
                                    pointProgress: 0,
                                    pointProgressMax: 10
                                }
                            ]
                        }
                    }
                })
            },
            react: { routerStateTree: () => 'router-state' }
        },
        mainMobilePage: {
            goto: async () => {
                destinationOpened = true
            }
        },
        utils: {
            wait: async () => {},
            randomDelay: () => 0
        },
        refreshCurrentRewardsContext: async () => false
    }

    const completed = await new UrlReward(bot).doUrlReward({
        offerId: 'Global_DailySet_20260830_Child1',
        hash: '',
        complete: false,
        pointProgress: 0,
        pointProgressMax: 10,
        activityType: '11',
        destinationUrl: 'https://www.bing.com/search?q=test',
        exclusiveLockedFeatureStatus: ''
    })

    assert.equal(destinationOpened, true)
    assert.equal(completed, false)
    assert.ok(warnings.some(message => message.includes('Microsoft still reports incomplete')))
})

test('UrlReward rejects completion when total points increase but official offer remains incomplete', async () => {
    let destinationOpened = false
    const warnings = []

    const bot = {
        isMobile: true,
        nextActions: { reportActivity: 'action-id' },
        config: { skipNonPointTasks: true },
        userData: {
            currentPoints: 100,
            gainedPoints: 0,
            geoLocale: 'US',
            timezoneOffset: '-480'
        },
        logger: {
            debug() {},
            info() {},
            warn(_mobile, _source, message) {
                warnings.push(message)
            },
            error() {}
        },
        browser: {
            func: {
                ensureOffer: async () => ({ isCompleted: false, points: 10, hash: 'test-hash' }),
                reportServerAction: async () => ({
                    status: 200,
                    acknowledged: true,
                    availablePoints: 110
                }),
                synchronizeActiveBrowserCookies: async () => true,
                getDashboardData: async () => ({
                    dashboard: {
                        userStatus: { availablePoints: 110 },
                        dailySetPromotions: {
                            '08/30/2026': [
                                {
                                    offerId: 'Global_DailySet_20260830_Child1',
                                    complete: false,
                                    pointProgress: 0,
                                    pointProgressMax: 10
                                }
                            ]
                        }
                    }
                })
            },
            react: { routerStateTree: () => 'router-state' }
        },
        mainMobilePage: {
            goto: async () => {
                destinationOpened = true
            }
        },
        utils: {
            wait: async () => {},
            randomDelay: () => 0
        },
        refreshCurrentRewardsContext: async () => false
    }

    const completed = await new UrlReward(bot).doUrlReward({
        offerId: 'Global_DailySet_20260830_Child1',
        hash: 'test-hash',
        complete: false,
        pointProgress: 0,
        pointProgressMax: 10,
        activityType: '11',
        destinationUrl: 'https://www.bing.com/search?q=test',
        exclusiveLockedFeatureStatus: ''
    })

    assert.equal(destinationOpened, true)
    assert.equal(completed, false)
    assert.ok(warnings.some(m => m.includes('offer not verified complete') || m.includes('Microsoft still reports incomplete')))
})

test('UrlReward rejects browser fallback when total balance increases but official offer remains incomplete', async () => {
    let destinationOpened = false
    const warnings = []

    const bot = {
        isMobile: true,
        nextActions: { reportActivity: 'action-id' },
        config: { skipNonPointTasks: true },
        userData: {
            currentPoints: 100,
            gainedPoints: 0,
            geoLocale: 'US',
            timezoneOffset: '-480'
        },
        logger: {
            debug() {},
            info() {},
            warn(_mobile, _source, message) {
                warnings.push(message)
            },
            error() {}
        },
        browser: {
            func: {
                ensureOffer: async () => null,
                synchronizeActiveBrowserCookies: async () => true,
                getDashboardData: async () => ({
                    dashboard: {
                        userStatus: { availablePoints: 120 },
                        dailySetPromotions: {
                            '08/30/2026': [
                                {
                                    offerId: 'Global_DailySet_20260830_Child1',
                                    complete: false,
                                    pointProgress: 0,
                                    pointProgressMax: 10
                                }
                            ]
                        }
                    }
                })
            },
            react: { routerStateTree: () => 'router-state' }
        },
        mainMobilePage: {
            goto: async () => {
                destinationOpened = true
            }
        },
        utils: {
            wait: async () => {},
            randomDelay: () => 0
        },
        refreshCurrentRewardsContext: async () => false
    }

    const completed = await new UrlReward(bot).doUrlReward({
        offerId: 'Global_DailySet_20260830_Child1',
        hash: '',
        complete: false,
        pointProgress: 0,
        pointProgressMax: 10,
        activityType: '11',
        destinationUrl: 'https://www.bing.com/search?q=test',
        exclusiveLockedFeatureStatus: ''
    })

    assert.equal(destinationOpened, true)
    assert.equal(completed, false)
    assert.ok(warnings.some(m => m.includes('Microsoft still reports incomplete')))
})

