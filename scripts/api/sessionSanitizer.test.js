import assert from 'node:assert/strict'
import test from 'node:test'
import { sanitizeCookies, sanitizeStorageState, sanitizeAllDirtyCookies } from './sessionSanitizer.mjs'

test('desktop sanitization strips mobile dirty cookies (_SS, _RwBf, _Rwho)', () => {
    const rawCookies = [
        { name: '_U', value: 'auth_token_value', domain: '.bing.com' },
        { name: 'MUID', value: 'device_muid', domain: '.bing.com' },
        { name: '_SS', value: 'SID=xxx&PC=SANSAAND&R=9613', domain: '.bing.com' },
        { name: '_Rwho', value: 'u=m&ts=2026-09-15', domain: '.bing.com' },
        { name: '_RwBf', value: 'rc=9613', domain: '.bing.com' },
        { name: 'SRCHHPGUSR', value: 'CW=1280&CH=800', domain: '.bing.com' }
    ]

    const cleanDesktop = sanitizeCookies(rawCookies, false)
    const cleanNames = cleanDesktop.map(c => c.name)

    assert.deepEqual(cleanNames, ['_U', 'MUID', 'SRCHHPGUSR'])
    assert.equal(cleanDesktop.some(c => c.name === '_SS'), false)
    assert.equal(cleanDesktop.some(c => c.name === '_Rwho'), false)
    assert.equal(cleanDesktop.some(c => c.name === '_RwBf'), false)
})

test('desktop sanitization strips custom cookies carrying mobile client PC=SANSAAND', () => {
    const cookies = [
        { name: 'CUSTOM', value: 'foo=bar&PC=SANSAAND&baz=1', domain: '.bing.com' },
        { name: 'VALID', value: 'normal_desktop_value', domain: '.bing.com' }
    ]

    const clean = sanitizeCookies(cookies, false)
    assert.equal(clean.length, 1)
    assert.equal(clean[0].name, 'VALID')
})

test('mobile sanitization preserves mobile cookies', () => {
    const rawCookies = [
        { name: '_U', value: 'auth_token_value', domain: '.bing.com' },
        { name: '_SS', value: 'SID=xxx&PC=SANSAAND&R=9613', domain: '.bing.com' },
        { name: '_Rwho', value: 'u=m', domain: '.bing.com' }
    ]

    const cleanMobile = sanitizeCookies(rawCookies, true)
    assert.equal(cleanMobile.length, 3)
})

test('sanitizeStorageState correctly sanitizes the cookies array inside storage state', () => {
    const storageState = {
        cookies: [
            { name: '_U', value: 'valid' },
            { name: '_SS', value: 'dirty' }
        ],
        origins: [{ origin: 'https://www.bing.com', localStorage: [] }]
    }

    const cleaned = sanitizeStorageState(storageState, false)
    assert.equal(cleaned.cookies.length, 1)
    assert.equal(cleaned.cookies[0].name, '_U')
    assert.equal(cleaned.origins.length, 1)
})

test('sanitizeAllDirtyCookies strips ispd penalty and dirty tracking cookies across platforms', () => {
    const cookies = [
        { name: '_U', value: 'auth_ok' },
        { name: 'MUID', value: 'muid_ok' },
        { name: '_RwBf', value: 'rc=9938&ispd=20' },
        { name: '_SS', value: 'SID=xxx' },
        { name: '_Rwho', value: 'u=m' },
        { name: 'OTHER_WITH_ISPD', value: 'foo=1&ispd=10' }
    ]
    const cleaned = sanitizeAllDirtyCookies(cookies)
    assert.deepEqual(cleaned.map(c => c.name), ['_U', 'MUID'])
})

