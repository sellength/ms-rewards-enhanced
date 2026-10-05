function domainMatches(hostname, cookieDomain) {
    const normalized = String(cookieDomain || '').toLowerCase()
    if (!normalized) return false
    const domain = normalized.replace(/^\./, '')
    return hostname === domain || (normalized.startsWith('.') && hostname.endsWith(`.${domain}`))
}

function pathMatches(pathname, cookiePath) {
    const path = cookiePath || '/'
    if (pathname === path) return true
    if (!pathname.startsWith(path)) return false
    return path.endsWith('/') || pathname.charAt(path.length) === '/'
}

// Mirrors browser cookie selection for local storage-state cookies. Values remain local.
export function sessionCookieHeader(cookies, targetUrl, nowSeconds = Date.now() / 1000) {
    const url = new URL(targetUrl)
    return (Array.isArray(cookies) ? cookies : [])
        .filter(cookie =>
            domainMatches(url.hostname.toLowerCase(), cookie.domain) &&
            pathMatches(url.pathname || '/', cookie.path) &&
            (!cookie.secure || url.protocol === 'https:') &&
            (!(Number(cookie.expires) > 0) || Number(cookie.expires) > nowSeconds)
        )
        .sort((left, right) => String(right.path || '/').length - String(left.path || '/').length)
        .map(cookie => `${cookie.name}=${cookie.value}`)
        .join('; ')
}
