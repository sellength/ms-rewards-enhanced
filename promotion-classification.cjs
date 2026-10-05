function promotionKey(promotion) {
    return String(promotion?.offerId || promotion?.attributes?.offerid || promotion?.name || '').trim()
}

function isExploreOnBingPromotion(promotion) {
    const attrs = promotion?.attributes || {}
    const offerId = promotionKey(promotion).toLowerCase()
    const title = String(promotion?.title || attrs.title || promotion?.name || '').toLowerCase()
    const destination = String(
        promotion?.destinationUrl ||
        attrs.destination_url ||
        attrs.destinationUrl ||
        attrs.destination ||
        attrs.url ||
        ''
    ).toLowerCase()
    return String(attrs.isExploreOnBingTask || '').toLowerCase() === 'true' ||
        offerId.includes('_exploreonbing_') ||
        offerId.includes('exploreonbing') ||
        title.includes('explore on bing') ||
        destination.includes('rwautoflyout=exb') ||
        destination.includes('rwautoflyout=')
}

function isAppInteractivePromotion(promotion) {
    const offerId = promotionKey(promotion).toLowerCase()
    return isExploreOnBingPromotion(promotion) ||
        offerId.startsWith('ww_moreactivities_rewardsapp_offer_')
}

function getExploreOnBingStatus(promotion, sessionState = {}) {
    if (!isExploreOnBingPromotion(promotion)) return null
    const attrs = promotion?.attributes || {}
    const number = value => Number.isFinite(Number(value)) ? Math.max(0, Number(value)) : 0
    const max = number(promotion?.points ?? promotion?.pointProgressMax ?? attrs.pointmax ?? attrs.max ?? attrs.points)
    const progress = number(promotion?.progress ?? promotion?.pointProgress ?? attrs.pointprogress ?? attrs.progress)
    const isDone = Boolean(
        promotion?.complete === true ||
        String(attrs.complete).toLowerCase() === 'true' ||
        (max > 0 && progress >= max)
    )
    if (isDone) return 'completed'
    const offerId = promotionKey(promotion)
    if (
        sessionState?.activatedOfferIds?.has?.(offerId) ||
        (Array.isArray(sessionState?.activeExploreOfferIds) && sessionState.activeExploreOfferIds.includes(offerId)) ||
        sessionState?.activeOfferId === offerId ||
        promotion?.isActivated === true ||
        attrs.isActivated === true ||
        String(attrs.isActivated || '').toLowerCase() === 'true' ||
        String(attrs.isInProgress || '').toLowerCase() === 'true' ||
        (String(attrs.State || '').toLowerCase() === 'complete' && !isDone) ||
        attrs.status === 'active' ||
        attrs.activity_status === 'active'
    ) {
        return 'activated'
    }
    if (
        isTomorrowLockedPromotion(promotion) ||
        promotion?.isLockedTomorrow === true ||
        attrs.isLockedTomorrow === true ||
        String(attrs.is_unlocked || '').toLowerCase() === 'false' ||
        (String(attrs.locked_category_criteria || '').toLowerCase() === 'tomorrow' && String(attrs.is_unlocked || '').toLowerCase() === 'false')
    ) {
        return 'tomorrow_locked'
    }
    return 'pending_activation'
}

function isTomorrowLockedPromotion(promotion) {
    const attrs = promotion?.attributes || {}
    if (promotion?.isLockedTomorrow === true || attrs?.isLockedTomorrow === true) return true
    if (String(attrs.is_unlocked || '').toLowerCase() === 'false') return true
    if (String(attrs.locked_category_criteria || '').toLowerCase() === 'tomorrow' && String(attrs.is_unlocked || '').toLowerCase() === 'false') return true

    const text = [
        promotion?.title,
        promotion?.description,
        promotion?.exclusiveLockedFeatureStatus,
        attrs.title,
        attrs.description,
        attrs.category,
        attrs.status,
        attrs.activity_status,
        attrs.subtext
    ].filter(Boolean).join(' ').toLowerCase()

    return text.includes('unlocks tomorrow') ||
        text.includes('available tomorrow') ||
        text.includes('明日解锁') ||
        text.includes('明天解锁') ||
        text.includes('明天激活') ||
        text.includes('明日激活') ||
        text.includes('次日解锁') ||
        text.includes('次日激活') ||
        String(attrs.category || '').toLowerCase() === 'tomorrow' ||
        String(attrs.status || '').toLowerCase() === 'locked' ||
        String(attrs.activity_status || '').toLowerCase() === 'locked' ||
        String(promotion?.exclusiveLockedFeatureStatus || '').toLowerCase() === 'locked'
}

function isManualKeepEarningPromotion(promotion) {
    const attrs = promotion?.attributes || {}
    const explicitManual = [
        attrs.requiresManualInteraction,
        attrs.requires_manual_interaction,
        attrs.manualOnly,
        attrs.manual_only
    ].some(value => String(value || '').toLowerCase() === 'true')
    if (explicitManual || isAppInteractivePromotion(promotion)) return true

    const destination = String(
        promotion?.destinationUrl ||
        attrs.destination_url ||
        attrs.destinationUrl ||
        attrs.destination ||
        attrs.url ||
        ''
    ).trim()
    try {
        const url = new URL(destination)
        return url.hostname.toLowerCase() === 'rewards.bing.com' && /^\/goal(?:\/|$)/i.test(url.pathname)
    } catch {
        return false
    }
}

// Daily Set interaction candidates; execution probes the entry before advising manual interaction.
function isInteractiveDailySetDestination(promotion) {
    const attrs = promotion?.attributes || {}
    if ([attrs.requiresManualInteraction, attrs.requires_manual_interaction, attrs.manualOnly, attrs.manual_only]
        .some(value => String(value).toLowerCase() === 'true')) return true
    try {
        const outer = new URL(promotion?.destinationUrl || attrs.destination_url || attrs.destinationUrl || attrs.destination || attrs.url || '')
        const trusted = url => url.protocol === 'https:' && (url.hostname === 'bing.com' || url.hostname.endsWith('.bing.com'))
        if (!trusted(outer)) return false
        const nested = outer.pathname === '/rewards/checkuser' ? outer.searchParams.get('ru') : null
        const url = nested ? new URL(nested, outer.origin) : outer
        if (!trusted(url)) return false
        if (url.hostname === 'rewards.bing.com' && /^\/refer(?:andearn)?\/?$/i.test(url.pathname)) return true
        if (url.pathname !== '/search') return false
        return /PollScenarioId:/i.test(url.searchParams.get('filters') || '') || url.searchParams.get('rqpiodemo') === '1'
    } catch {
        return false
    }
}

// Read only the current Earn moreactivities subtree, including streamed RSC references.
// null means unknown; callers must not execute a legacy list in that case.
function earnKeepEarningIds(html) {
    let text = ''
    for (const match of String(html || '').matchAll(/self\.__next_f\.push\(\[1,\s*"((?:[^"\\]|\\.)*)"\]\)/g)) {
        try { text += JSON.parse(`"${match[1]}"`) } catch { return null }
    }
    if (!text) text = String(html || '')
    const rows = new Map()
    for (const line of text.split('\n')) {
        const match = line.match(/^([\da-f]+):(.+)$/i)
        if (match) { try { rows.set(match[1], JSON.parse(match[2])) } catch {} }
    }
    const roots = []
    const find = (value, fallback = false) => {
        if (!value || typeof value !== 'object') return
        if (!fallback && !Array.isArray(value) &&
            (value.id === 'moreactivities' || value.messages?.Earn?.MoreActivities)) roots.push(value)
        for (const [key, child] of Object.entries(value)) find(child, fallback || key === 'fallback')
    }
    for (const value of rows.values()) find(value)
    if (!roots.length) return null
    const ids = new Set()
    let unresolved = false
    const visited = new Set()
    const walk = value => {
        if (typeof value === 'string') {
            const ref = value.match(/^\$L?([\da-f]+)$/i)
            if (ref && !visited.has(ref[1])) {
                visited.add(ref[1])
                if (rows.has(ref[1])) walk(rows.get(ref[1]))
                else unresolved = true
            }
            return
        }
        if (!value || typeof value !== 'object') return
        if (typeof value.offerId === 'string') ids.add(value.offerId)
        // React array positions 0/1 identify components, not child data references.
        for (const child of Array.isArray(value) && value[0] === '$' ? value.slice(3) : Object.values(value)) walk(child)
    }
    for (const root of roots) walk(root.children)
    return unresolved ? null : [...ids]
}

function appProgressFields(attrs = {}) {
    const number = value => Number.isFinite(Number(value)) ? Math.max(0, Number(value)) : 0
    const max = number(attrs.pointmax ?? attrs.max ?? attrs.points)
    const progress = number(attrs.pointprogress ?? attrs.progress)
    const complete = String(attrs.complete).toLowerCase() === 'true' || (max > 0 && progress >= max)
    return { max, progress: complete ? max : Math.min(max, progress), complete }
}

function edgeWebProgress(text) {
    for (const match of String(text || '').matchAll(/"EarnStreaksSection_StreakCard"[^{}]*"data":(\{[^{}]+\})/g)) {
        try {
            const value = JSON.parse(match[1])
            if (value.partner !== 'edge') continue
            const earned = Number(value.complete), max = Number(value.total)
            if (!Number.isFinite(earned) || !Number.isFinite(max) || max <= 0) return null
            return { earned, max, complete: earned >= max }
        } catch {}
    }
    return null
}

function isCurrentAppDailySetCandidate(promotion, appDate) {
    const attrs = promotion?.attributes || {}
    const type = String(attrs.type || '').toLowerCase()
    return attrs.daily_set_date === appDate && Boolean(attrs.offerid) &&
        ['', 'urlreward', 'sapphire'].includes(type) && appProgressFields(attrs).max > 0 &&
        String(attrs.give_eligible).toLowerCase() !== 'false' &&
        String(attrs.hidden).toLowerCase() !== 'true' &&
        !/(?:^|[_-])(info|layout)(?:$|[_-])/i.test(promotion?.name || '')
}

function selectPcKeepEarningPromotions(rawPromos = [], dailySetItems = [], visibleOfferIds = null) {
    const uniquePromos = [...new Map(
        rawPromos
            .map(item => [promotionKey(item), item])
            .filter(([offerId]) => Boolean(offerId))
    ).values()]
    const currentDailySetOfferIds = new Set(
        dailySetItems.map(promotionKey).filter(Boolean)
    )

    return uniquePromos.filter(promotion => {
        const offerId = promotionKey(promotion)
        return (Array.isArray(visibleOfferIds) && visibleOfferIds.includes(offerId)) &&
            !isAppInteractivePromotion(promotion) && !currentDailySetOfferIds.has(offerId)
    })
}

module.exports = {
    edgeWebProgress,
    earnKeepEarningIds,
    appProgressFields,
    isCurrentAppDailySetCandidate,
    isInteractiveDailySetDestination,
    isExploreOnBingPromotion,
    isAppInteractivePromotion,
    isTomorrowLockedPromotion,
    isManualKeepEarningPromotion,
    getExploreOnBingStatus,
    selectPcKeepEarningPromotions
}
