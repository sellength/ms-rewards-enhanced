import test from 'node:test'
import assert from 'node:assert/strict'
import { findBingSearchInput } from '../../dist/functions/activities/search/SearchPageAdapter.js'

function pageFor(groups, url = 'https://cn.bing.com/search?q=example') {
    let calls = 0
    return { url: () => url, calls: () => calls, locator: selector => {
        calls++
        const items = groups[selector === '#sb_form_q' ? 0 : selector.startsWith('form[action') ? 1 : 2] || []
        return { count: async () => items.length, nth: index => ({
            isVisible: async () => items[index].visible !== false,
            isEditable: async () => items[index].editable !== false,
            id: items[index].id
        }) }
    } }
}

test('known input takes priority over semantic alternatives', async () => {
    const p = pageFor([[{ id: 'known' }], [{ id: 'other' }]])
    const result = await findBingSearchInput(p)
    assert.equal(result.strategy, 'known-id')
    assert.equal(result.input.id, 'known')
    assert.equal(p.calls(), 1)
})
test('hidden known input falls back to unique editable search-form input', async () => {
    const p = pageFor([[{ visible: false }], [{ editable: false }, { id: 'q' }]])
    const result = await findBingSearchInput(p)
    assert.equal(result.strategy, 'search-form')
    assert.equal(result.input.id, 'q')
})
test('semantic search control is supported without arbitrary textbox matching', async () => {
    assert.equal((await findBingSearchInput(pageFor([[], [], [{ id: 'semantic' }]]))).strategy, 'semantic-search')
})
test('result page without input returns immediately without a visibility timeout', async () => {
    assert.equal(await findBingSearchInput(pageFor([])), null)
})
test('multiple editable candidates stop instead of choosing a random control', async () => {
    await assert.rejects(findBingSearchInput(pageFor([[], [{}, {}]])), /ambiguous/)
})
test('untrusted host and non-HTTPS cannot select inputs', async () => {
    for (const url of ['https://bing.com.example.org/search', 'https://example.org/', 'http://bing.com/']) {
        const p = pageFor([[{}]], url)
        await assert.rejects(findBingSearchInput(p), /untrusted/)
        assert.equal(p.calls(), 0)
    }
})
