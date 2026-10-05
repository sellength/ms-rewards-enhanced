import assert from 'node:assert/strict'
import test from 'node:test'

import {
    dailySetDateFromOfferId,
    resolveOfficialDailySetDate
} from '../../dist/util/DailySetCycle.js'

test('converts the official Dashboard offer id into the Rewards display date', () => {
    assert.equal(dailySetDateFromOfferId('Global_DailySet_20260831_Child2'), '08/31/2026')
    assert.equal(dailySetDateFromOfferId('Gamification_DailySet_20260901_Child3'), '09/01/2026')
    assert.equal(dailySetDateFromOfferId('FuturePrefix_DailySet_20261205_Child12'), '12/05/2026')
    assert.equal(dailySetDateFromOfferId('not-a-daily-set'), null)
    assert.equal(dailySetDateFromOfferId('FuturePrefix_DailySet_20261340_Child1'), null)
    assert.equal(dailySetDateFromOfferId('FuturePrefix_20260901_Child1'), null)
})

test('selects the official Dashboard cycle instead of the host local date', () => {
    const availableDates = ['08/31/2026', '09/01/2026', '09/02/2026']
    const dashboardOfferIds = [
        'Global_DailySet_20260831_Child1',
        'Global_DailySet_20260831_Child2',
        'Global_DailySet_20260831_Child3'
    ]

    assert.equal(resolveOfficialDailySetDate(availableDates, dashboardOfferIds), '08/31/2026')
})

test('resolves a renamed official Daily Set prefix without accepting mixed cycles', () => {
    const availableDates = ['09/01/2026', '09/02/2026']
    assert.equal(
        resolveOfficialDailySetDate(availableDates, [
            'Gamification_DailySet_20260901_Child1',
            'Gamification_DailySet_20260901_Child2',
            'Gamification_DailySet_20260901_Child3'
        ]),
        '09/01/2026'
    )
    assert.equal(
        resolveOfficialDailySetDate(availableDates, [
            'FuturePrefix_DailySet_20260901_Child1',
            'FuturePrefix_DailySet_20260902_Child1'
        ]),
        null
    )
})

test('accepts only a preflight cycle confirmed by the current Dashboard snapshot', () => {
    const availableDates = ['08/31/2026', '09/01/2026']
    const current = ['Global_DailySet_20260831_Child1']
    assert.equal(resolveOfficialDailySetDate(availableDates, current, '08/31/2026'), '08/31/2026')
    assert.equal(resolveOfficialDailySetDate(availableDates, [], '08/31/2026'), null)
    assert.equal(resolveOfficialDailySetDate(availableDates, [], '09/02/2026'), null)
    assert.equal(resolveOfficialDailySetDate(availableDates, current, '09/01/2026'), null)
    assert.equal(
        resolveOfficialDailySetDate(availableDates, [
            'Global_DailySet_20260831_Child1',
            'Global_DailySet_20260901_Child1'
        ]),
        null
    )
})

test('selectOfficialDailySetDate picks active or current date over tomorrow locked preview', async () => {
    const { selectOfficialDailySetDate } = await import('../../web.mjs')

    const mockPromosWithDone = {
        '10/03/2026': [
            { title: 'Upcoming sporting events', complete: true, pointProgress: 10, pointProgressMax: 10 },
            { title: 'Show what you know', complete: true, pointProgress: 10, pointProgressMax: 10 },
            { title: 'Daily poll', complete: true, pointProgress: 10, pointProgressMax: 10 }
        ],
        '10/04/2026': [
            { title: 'Upcoming comedy events', complete: false, pointProgress: 0, pointProgressMax: 10 },
            { title: 'A, B, or C?', complete: false, pointProgress: 0, pointProgressMax: 10 },
            { title: 'Daily poll', complete: false, pointProgress: 0, pointProgressMax: 10 }
        ]
    }
    // Rule 1: date with completed tasks is prioritized
    assert.equal(selectOfficialDailySetDate(mockPromosWithDone, 'US', new Date('2026-10-03T10:00:00Z')), '10/03/2026')

    const mockPromosIncomplete = {
        '10/03/2026': [
            { title: 'Upcoming sporting events', complete: false, pointProgress: 0, pointProgressMax: 10 },
            { title: 'Show what you know', complete: false, pointProgress: 0, pointProgressMax: 10 },
            { title: 'Daily poll', complete: false, pointProgress: 0, pointProgressMax: 10 }
        ],
        '10/04/2026': [
            { title: 'Upcoming comedy events', complete: false, pointProgress: 0, pointProgressMax: 10 },
            { title: 'A, B, or C?', complete: false, pointProgress: 0, pointProgressMax: 10 },
            { title: 'Daily poll', complete: false, pointProgress: 0, pointProgressMax: 10 }
        ]
    }
    // Rule 2: matches current calendar day in account region/local
    assert.equal(selectOfficialDailySetDate(mockPromosIncomplete, 'US', new Date('2026-10-03T10:00:00Z')), '10/03/2026')

    // Single date fallback
    assert.equal(selectOfficialDailySetDate({ '10/03/2026': [] }, 'US'), '10/03/2026')
})
