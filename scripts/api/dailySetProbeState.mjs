// Local execution advice only; never official completion or points.
export function createDailySetProbeState() {
    const entries = new Map()
    const key = (account, platform, date, offer) => JSON.stringify([account, platform, date, offer])
    return {
        clear() { entries.clear() },
        record(account, platform, line) {
            const match = line.match(/\bentry_probe_(pending|complete|interaction_required|unverified) offerId=([^\s|]+) appDate=(\d{2}\/\d{2}\/\d{4})/)
            if (!account || !match) return null
            const [, result, offer, date] = match
            const id = key(account, platform, date, offer)
            entries.delete(id)
            entries.set(id, result)
            if (entries.size > 500) entries.delete(entries.keys().next().value)
            return { result, offer, date }
        },
        apply(account, platform, state) {
            for (const card of state.dailySetCards || []) {
                const result = entries.get(key(account, platform, state.dailySetDate, card.offerId))
                card.requiresAppInteraction = !card.complete && result === 'interaction_required'
                card.entryProbeResult = card.complete ? 'complete' : (result || null)
            }
            return state
        }
    }
}
