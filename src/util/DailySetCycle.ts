const DAILY_SET_OFFER = /^[A-Za-z0-9_-]*DailySet_(\d{8})_Child\d+$/i
const DISPLAY_DATE = /^\d{2}\/\d{2}\/\d{4}$/

export function dailySetDateFromOfferId(offerId: string): string | null {
    const stamp = offerId.match(DAILY_SET_OFFER)?.[1]
    if (!stamp) return null

    const year = Number(stamp.slice(0, 4))
    const month = Number(stamp.slice(4, 6))
    const day = Number(stamp.slice(6, 8))
    const parsed = new Date(Date.UTC(year, month - 1, day))
    if (
        parsed.getUTCFullYear() !== year ||
        parsed.getUTCMonth() + 1 !== month ||
        parsed.getUTCDate() !== day
    ) return null

    return `${stamp.slice(4, 6)}/${stamp.slice(6, 8)}/${stamp.slice(0, 4)}`
}

export function resolveOfficialDailySetDate(
    availableDates: readonly string[],
    dashboardOfferIds: readonly string[],
    explicitDate?: string | null
): string | null {
    const available = new Set(availableDates.filter(date => DISPLAY_DATE.test(date)))

    const dashboardDates = new Set(
        dashboardOfferIds
            .map(dailySetDateFromOfferId)
            .filter((date): date is string => date !== null)
            .filter(date => available.has(date))
    )

    if (dashboardDates.size === 1) {
        const dashboardDate = [...dashboardDates][0]!
        if (explicitDate && (!DISPLAY_DATE.test(explicitDate) || explicitDate !== dashboardDate)) return null
        return dashboardDate
    }

    if (dashboardDates.size === 0 && available.size === 1) {
        const singleDate = [...available][0]!
        if (explicitDate && (!DISPLAY_DATE.test(explicitDate) || explicitDate !== singleDate)) return null
        return singleDate
    }

    return null
}
