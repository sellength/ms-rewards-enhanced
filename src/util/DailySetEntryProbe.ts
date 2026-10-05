export type EntryProbeResult = 'complete' | 'interaction_required' | 'unverified'

// Validate both the official entry and its nested destination, including offer linkage.
export function trustedDailySetEntry(raw: string, offerId: string): boolean {
    try {
        const trusted = (url: URL) => url.protocol === 'https:' && !url.username && !url.password &&
            (url.hostname === 'bing.com' || url.hostname.endsWith('.bing.com'))
        const outer = new URL(raw)
        if (!trusted(outer)) return false
        const nested = outer.pathname.toLowerCase() === '/rewards/checkuser' ? outer.searchParams.get('ru') : null
        const target = nested ? new URL(nested, outer.origin) : outer
        if (!trusted(target)) return false
        const ids = Array.from((target.searchParams.get('filters') || '').matchAll(/(?:BTDSUOID|BTROID):"([^"]+)"/gi), m => m[1])
        return ids.every(id => id === offerId)
    } catch { return false }
}

export async function probeDailySetEntry(
    open: () => Promise<void>,
    read: () => Promise<boolean | null>,
    wait: () => Promise<void>
): Promise<EntryProbeResult> {
    try {
        await open()
        for (let attempt = 0; attempt < 3; attempt++) {
            await wait()
            const complete = await read()
            if (complete === true) return 'complete'
            if (complete === null) return 'unverified'
        }
        return 'interaction_required'
    } catch { return 'unverified' }
}
