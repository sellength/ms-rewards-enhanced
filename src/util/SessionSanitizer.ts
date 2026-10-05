export interface CookieLike {
    name: string
    value: string
    domain?: string
    path?: string
    expires?: number
    httpOnly?: boolean
    secure?: boolean
    sameSite?: 'Strict' | 'Lax' | 'None'
}

/**
 * 桌面端已知会引起 Bing 设备冲突或将搜索配额限制为 0 的移动端残留 Cookie
 */
const DESKTOP_DIRTY_COOKIE_NAMES = new Set(['_SS', '_RwBf', '_Rwho'])
const UNIVERSAL_DIRTY_COOKIE_NAMES = new Set(['_RwBf', '_Rwho', '_HPVN', 'SRCHUSR'])

/**
 * 针对 PC 桌面端和移动端净化 Cookie 列表，防止设备特征冲突导致配额锁定
 */
export function sanitizeCookies<T extends CookieLike>(cookies: T[], isMobile: boolean): T[] {
    if (!Array.isArray(cookies)) return []

    return cookies.filter(cookie => {
        if (!cookie || typeof cookie.name !== 'string') return false
        const name = cookie.name.trim()

        // 无论桌面端还是移动端，都坚决剥离携带 ispd 冷却降速惩罚标记的 Cookie
        if (typeof cookie.value === 'string' && /ispd=\d+/i.test(cookie.value)) {
            return false
        }

        if (!isMobile) {
            // 桌面端运行：坚决剔除移动端残留的设备伪装及写死状态 Cookie
            if (DESKTOP_DIRTY_COOKIE_NAMES.has(name)) {
                return false
            }

            // 防御性检查：值中如果显式包含移动客户端标记，也进行过滤
            if (typeof cookie.value === 'string' && /PC=SANSAAND|u=m(?:&|$)/i.test(cookie.value)) {
                return false
            }
        }

        return true
    })
}

/**
 * 全量深度净化：彻底剥离所有风控、降速(_RwBf/ispd)和追踪脏标记
 */
export function sanitizeAllDirtyCookies<T extends CookieLike>(cookies: T[]): T[] {
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

/**
 * 针对 storageState 进行全量安全净化
 */
export function sanitizeStorageState(storageState: any, isMobile: boolean): any {
    if (!storageState || typeof storageState !== 'object') return storageState

    const clean = { ...storageState }
    if (Array.isArray(clean.cookies)) {
        clean.cookies = sanitizeCookies(clean.cookies, isMobile)
    }

    return clean
}
