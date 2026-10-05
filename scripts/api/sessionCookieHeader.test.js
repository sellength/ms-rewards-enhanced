import assert from 'node:assert/strict'
import test from 'node:test'
import { sessionCookieHeader } from './sessionCookieHeader.mjs'

const cookie = (name, domain, path = '/', extra = {}) => ({ name, value: name, domain, path, ...extra })

test('only sends cookies applicable to the target URL', () => {
    const cookies = [
        cookie('parent', '.bing.com'),
        cookie('host', 'rewards.bing.com'),
        cookie('otherHost', 'www.bing.com'),
        cookie('otherSite', '.nfl.com'),
        cookie('wrongPath', '.bing.com', '/redeem'),
        cookie('rightPath', '.bing.com', '/api'),
        cookie('expired', '.bing.com', '/', { expires: 99 }),
        cookie('session', '.bing.com', '/', { expires: -1 })
    ]
    assert.equal(
        sessionCookieHeader(cookies, 'https://rewards.bing.com/api/getuserinfo', 100),
        'rightPath=rightPath; parent=parent; host=host; session=session'
    )
})

test('enforces host-only, secure and path-boundary behavior', () => {
    const cookies = [
        cookie('hostOnly', 'bing.com'),
        cookie('domain', '.bing.com'),
        cookie('secure', '.bing.com', '/', { secure: true }),
        cookie('boundary', '.bing.com', '/api')
    ]
    assert.equal(sessionCookieHeader(cookies, 'http://rewards.bing.com/apix'), 'domain=domain')
    assert.equal(sessionCookieHeader(cookies, 'https://bing.com/'), 'hostOnly=hostOnly; domain=domain; secure=secure')
})

test('large unrelated cookie collections cannot inflate a Rewards request header', () => {
    const unrelated = Array.from({ length: 200 }, (_, index) => cookie(`ad${index}`, `.ads${index}.test`))
    const header = sessionCookieHeader([...unrelated, cookie('rewards', '.bing.com')], 'https://rewards.bing.com/dashboard')
    assert.equal(header, 'rewards=rewards')
})
