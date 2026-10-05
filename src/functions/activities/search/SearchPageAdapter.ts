import type { Locator, Page } from 'patchright'

// Only search controls on a trusted Bing page; never guess from arbitrary textboxes.
const SEARCH_INPUTS = [
    { strategy: 'known-id', selector: '#sb_form_q' },
    { strategy: 'search-form', selector: 'form[action*="/search"] input[name="q"], form[action*="/search"] textarea[name="q"]' },
    { strategy: 'semantic-search', selector: 'form[role="search"] input[type="search"], form[role="search"] input[name="q"], header input[role="searchbox"], header input[type="search"]' }
] as const

export async function findBingSearchInput(page: Page): Promise<{ input: Locator; strategy: string } | null> {
    const url = new URL(page.url())
    if (url.protocol !== 'https:' || !(url.hostname === 'bing.com' || url.hostname.endsWith('.bing.com'))) {
        throw new Error('search_untrusted_page')
    }
    for (const { strategy, selector } of SEARCH_INPUTS) {
        const candidates = page.locator(selector)
        const count = await candidates.count()
        if (count > 20) throw new Error('search_input_ambiguous')
        const usable: Locator[] = []
        for (let index = 0; index < count; index++) {
            const candidate = candidates.nth(index)
            if (await candidate.isVisible() && await candidate.isEditable()) usable.push(candidate)
        }
        if (usable.length > 1) throw new Error('search_input_ambiguous')
        if (usable[0]) return { input: usable[0], strategy }
    }
    return null
}
