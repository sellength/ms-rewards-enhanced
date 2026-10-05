const DESKTOP_DIRTY_COOKIE_NAMES = new Set(['_SS', '_RwBf', '_Rwho'])
const UNIVERSAL_DIRTY_COOKIE_NAMES = new Set(['_RwBf', '_Rwho', '_HPVN', 'SRCHUSR'])

export function sanitizeCookies(cookies, isMobile) {
    if (!Array.isArray(cookies)) return []

    return cookies.filter(cookie => {
        if (!cookie || typeof cookie.name !== 'string') return false
        const name = cookie.name.trim()

        if (typeof cookie.value === 'string' && /ispd=\d+/i.test(cookie.value)) {
            return false
        }

        if (!isMobile) {
            if (DESKTOP_DIRTY_COOKIE_NAMES.has(name)) {
                return false
            }
            if (typeof cookie.value === 'string' && /PC=SANSAAND|u=m(?:&|$)/i.test(cookie.value)) {
                return false
            }
        }

        return true
    })
}

export function sanitizeAllDirtyCookies(cookies) {
    if (!Array.isArray(cookies)) return []
    return cookies.filter(cookie => {
        if (!cookie || typeof cookie.name !== 'string') return false
        const name = cookie.name.trim()
        if (UNIVERSAL_DIRTY_COOKIE_NAMES.has(name) || name === '_SS') return false
        if (typeof cookie.value === 'string' && (/ispd=\d+/i.test(cookie.value) || /PC=SANSAAND/i.test(cookie.value))) {
            return false
        }
        return true
    })
}

export function sanitizeStorageState(storageState, isMobile) {
    if (!storageState || typeof storageState !== 'object') return storageState
    const clean = { ...storageState }
    if (Array.isArray(clean.cookies)) {
        clean.cookies = sanitizeCookies(clean.cookies, isMobile)
    }
    return clean
}
