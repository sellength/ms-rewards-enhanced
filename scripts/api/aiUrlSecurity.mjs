import { URL } from 'node:url'

/**
 * 官方已知主流 AI 服务商的合法官方主机名列表
 */
export const OFFICIAL_PROVIDER_HOSTS = {
    openai: ['api.openai.com'],
    gemini: ['generativelanguage.googleapis.com'],
    deepseek: ['api.deepseek.com'],
    anthropic: ['api.anthropic.com'],
    openrouter: ['openrouter.ai'],
    groq: ['api.groq.com'],
    mistral: ['api.mistral.ai'],
    moonshot: ['api.moonshot.cn'],
    zhipu: ['open.bigmodel.cn'],
    stepfun: ['api.stepfun.com'],
    minimax: ['api.minimax.chat']
}

import net from 'node:net'
import dns from 'node:dns'
import http from 'node:http'
import https from 'node:https'

/**
 * 判断 IPv4 4 字节数值是否属于私有、回环或受限网段
 * @param {number} a
 * @param {number} b
 * @param {number} c
 * @param {number} d
 * @param {boolean} [allowLoopback=false] 是否允许字面标准 127.0.0.1
 * @returns {boolean}
 */
export function isPrivateIpv4Octets(a, b, c, d, allowLoopback = false) {
    if ([a, b, c, d].some(o => typeof o !== 'number' || isNaN(o) || o < 0 || o > 255)) return true

    // 0.0.0.0/8 (当前网络)
    if (a === 0) return true
    // 127.0.0.0/8 (本地回环网段)
    if (a === 127) {
        if (allowLoopback && b === 0 && c === 0 && d === 1) return false
        return true
    }
    // 10.0.0.0/8 (私有网络 RFC 1918)
    if (a === 10) return true
    // 172.16.0.0/12 (私有网络 RFC 1918: 172.16.0.0 - 172.31.255.255)
    if (a === 172 && b >= 16 && b <= 31) return true
    // 192.168.0.0/16 (私有网络 RFC 1918)
    if (a === 192 && b === 168) return true
    // 169.254.0.0/16 (链路本地 Link-Local / 云元数据服务如 169.254.169.254)
    if (a === 169 && b === 254) return true
    // 100.64.0.0/10 (运营商 CGNAT)
    if (a === 100 && b >= 64 && b <= 127) return true
    // 192.0.0.0/24 (IETF 协议分配)
    if (a === 192 && b === 0 && c === 0) return true
    // 192.0.2.0/24 (TEST-NET-1)
    if (a === 192 && b === 0 && c === 2) return true
    // 192.88.99.0/24 (6to4 中继)
    if (a === 192 && b === 88 && c === 99) return true
    // 198.18.0.0/15 (基准测试)
    if (a === 198 && (b === 18 || b === 19)) return true
    // 198.51.100.0/24 (TEST-NET-2)
    if (a === 198 && b === 51 && c === 100) return true
    // 203.0.113.0/24 (TEST-NET-3)
    if (a === 203 && b === 0 && c === 113) return true
    // 224.0.0.0/4 (多播)
    if (a >= 224 && a <= 239) return true
    // 240.0.0.0/4 (保留用于未来分配 / 广播)
    if (a >= 240) return true

    return false
}

/**
 * 将任意合法的 IPv6 字符串展开为 8 个 16 位的无符号数值 [h0, h1, ..., h7]
 * 支持 :: 缩写、点分 IPv4 混入 (例如 ::ffff:192.168.1.1 或 ::ffff:7f00:1)
 * @param {string} addr
 * @returns {number[]|null} 展开失败返回 null
 */
export function expandIPv6(addr) {
    if (!addr || typeof addr !== 'string') return null
    let str = addr.toLowerCase().trim().replace(/^\[|\]$/g, '')

    // 检查末尾是否内嵌点分 IPv4 (例如 ::ffff:192.168.1.1)
    if (str.includes('.')) {
        const lastColon = str.lastIndexOf(':')
        if (lastColon === -1) return null
        const ipv4Part = str.slice(lastColon + 1)
        const v4Match = ipv4Part.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/)
        if (!v4Match) return null
        const octets = [
            parseInt(v4Match[1], 10),
            parseInt(v4Match[2], 10),
            parseInt(v4Match[3], 10),
            parseInt(v4Match[4], 10)
        ]
        if (octets.some(o => o < 0 || o > 255)) return null
        const h1 = ((octets[0] << 8) | octets[1]).toString(16)
        const h2 = ((octets[2] << 8) | octets[3]).toString(16)
        str = str.slice(0, lastColon + 1) + `${h1}:${h2}`
    }

    let parts = []
    if (str.includes('::')) {
        const sides = str.split('::')
        if (sides.length > 2) return null // 不能有多个 ::
        const left = sides[0] ? sides[0].split(':') : []
        const right = sides[1] ? sides[1].split(':') : []
        const fillCount = 8 - (left.length + right.length)
        if (fillCount < 1) return null
        const zeros = new Array(fillCount).fill('0')
        parts = [...left, ...zeros, ...right]
    } else {
        parts = str.split(':')
    }

    if (parts.length !== 8) return null

    const hextets = []
    for (const p of parts) {
        if (!p || p.length > 4 || !/^[0-9a-fA-F]+$/.test(p)) return null
        const val = parseInt(p, 16)
        if (isNaN(val) || val < 0 || val > 0xffff) return null
        hextets.push(val)
    }
    return hextets
}

/**
 * 校验是否为私有网络、链路本地、运营商保留、多播或 IPv4 映射等非法 SSRF 目标地址
 * 本地回环 (localhost, 127.0.0.1, ::1) 允许用于本地模型服务 (如 Ollama / LM Studio)
 * @param {string} hostname
 * @param {boolean} [allowLoopback=false] 是否允许标准本地回环
 * @returns {boolean}
 */
export function isPrivateOrBlockedHost(hostname, allowLoopback = false) {
    if (!hostname || typeof hostname !== 'string') return true
    const host = hostname.toLowerCase().trim()

    // 允许纯字面本地回环 (仅当显式允许回环时)
    if (host === 'localhost' || host === '127.0.0.1' || host === '::1') {
        return !allowLoopback
    }

    // 检查标准 IPv4
    const ipv4Match = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/)
    if (ipv4Match) {
        const octets = [
            parseInt(ipv4Match[1], 10),
            parseInt(ipv4Match[2], 10),
            parseInt(ipv4Match[3], 10),
            parseInt(ipv4Match[4], 10)
        ]
        return isPrivateIpv4Octets(octets[0], octets[1], octets[2], octets[3], allowLoopback)
    }

    // 检查 IPv6 (含展开与各类内嵌/映射/保留地址)
    const cleanHost = host.replace(/^\[|\]$/g, '')
    if (cleanHost.includes(':')) {
        const hextets = expandIPv6(cleanHost)
        if (!hextets) return true // 格式非法或异常的 IPv6 直接阻断

        const [h0, h1, h2, h3, h4, h5, h6, h7] = hextets

        // 1. IPv4 映射地址 (IPv4-mapped, RFC 4291: ::ffff:0:0/96)
        // 重点：无论是 ::ffff:127.0.0.1 还是 ::ffff:10.0.0.1，均一律阻断伪装，防绕过
        if (h0 === 0 && h1 === 0 && h2 === 0 && h3 === 0 && h4 === 0 && h5 === 0xffff) {
            return true
        }

        // 2. IPv4 翻译地址 (IPv4-translated, RFC 2765: ::ffff:0:0:0/96)
        if (h0 === 0 && h1 === 0 && h2 === 0 && h3 === 0 && h4 === 0xffff && h5 === 0) {
            return true
        }

        // 3. NAT64 知名转换前缀 (RFC 6052: 64:ff9b::/96) 与 本地前缀 (RFC 8215: 64:ff9b:1::/48)
        if (h0 === 0x0064 && h1 === 0xff9b) {
            return true
        }

        // 4. 6to4 隧道前缀 (RFC 3056: 2002::/16)
        if (h0 === 0x2002) {
            return true
        }

        // 5. Teredo 隧道前缀 (RFC 4380: 2001:0000::/32)
        if (h0 === 0x2001 && h1 === 0) {
            return true
        }

        // 6. 未指定地址 (::/128)
        if (h0 === 0 && h1 === 0 && h2 === 0 && h3 === 0 && h4 === 0 && h5 === 0 && h6 === 0 && h7 === 0) {
            return true
        }

        // 7. 回环地址 (::1/128)
        if (h0 === 0 && h1 === 0 && h2 === 0 && h3 === 0 && h4 === 0 && h5 === 0 && h6 === 0 && h7 === 1) {
            return !allowLoopback
        }

        // 8. 唯一本地地址 ULA (RFC 4193: fc00::/7)
        if ((h0 & 0xfe00) === 0xfc00) {
            return true
        }

        // 9. 链路本地地址 Link-Local (RFC 4291: fe80::/10) 与 废弃站点本地 (fec0::/10)
        if ((h0 & 0xffc0) === 0xfe80 || (h0 & 0xffc0) === 0xfec0) {
            return true
        }

        // 10. 多播地址 Multicast (RFC 4291: ff00::/8)
        if ((h0 & 0xff00) === 0xff00) {
            return true
        }

        // 11. 丢弃前缀 Discard Prefix (RFC 6666: 100::/64)
        if (h0 === 0x0100 && h1 === 0 && h2 === 0 && h3 === 0) {
            return true
        }

        // 12. 实验与文档前缀 (RFC 3849: 2001:db8::/32)
        if (h0 === 0x2001 && h1 === 0x0db8) {
            return true
        }

        // 其余公网全局单播 IPv6 (2000::/3) 正常放行
        return false
    }

    return false
}

/**
 * 校验目标主机名的实际 DNS 解析结果是否包含私网、回环或保留 IP
 * 彻底防御 DNS Rebinding 攻击与基于公网域名的内网穿透探测
 * @param {string} hostname 主机名或 IP
 * @param {boolean} [allowLoopback=false] 是否允许本地回环 (仅当已通过协议门控时)
 * @returns {Promise<void>}
 * @throws {Error} 若 DNS 解析失败或解析出私网 IP 则抛出异常
/**
 * 校验目标主机并将其实际网络 IP 固化 (IP Pinning)，彻底消除两次解析之间的 TOCTOU DNS Rebinding 窗口
 * @param {string} hostname
 * @param {boolean} [allowLoopback=false]
 * @returns {Promise<{ pinnedIp: string, isLiteralIp: boolean }>}
 */
export async function resolveAndPinSafeHost(hostname, allowLoopback = false) {
    if (!hostname || typeof hostname !== 'string') {
        throw new Error('无效的目标主机名')
    }

    const host = hostname.toLowerCase().trim().replace(/^\[|\]$/g, '')

    // 1. 若已经是字面 IP，直接校验并固化
    if (net.isIP(host)) {
        if (isPrivateOrBlockedHost(host, allowLoopback)) {
            throw new Error(`安全拦截: 目标 IP (${host}) 属于私有局域网、本地回环或保留网段，禁止请求`)
        }
        return { pinnedIp: host, isLiteralIp: true }
    }

    // 2. 若为标准 localhost
    if (host === 'localhost') {
        if (allowLoopback) return { pinnedIp: '127.0.0.1', isLiteralIp: true }
        throw new Error('安全拦截: 禁止通过非回环协议访问 localhost')
    }

    // 3. 域名解析与固化：单次解析所有记录并核验
    let records = []
    try {
        records = await dns.promises.lookup(host, { all: true, verbatim: true })
    } catch (dnsErr) {
        throw new Error(`DNS 解析失败 (${host}): ${dnsErr.message}`)
    }

    if (!records || records.length === 0) {
        throw new Error(`DNS 解析无有效 A/AAAA 记录 (${host})`)
    }

    for (const record of records) {
        const ip = record.address
        // 对域名解析出的 IP，绝对不允许解析到本地回环（DNS Rebinding 攻击防御，allowLoopback 强制为 false）
        if (isPrivateOrBlockedHost(ip, false)) {
            throw new Error(`DNS 安全拦截: 域名 "${host}" 解析到了私有/回环受限 IP (${ip})，疑似 DNS Rebinding 或内网探测攻击，已主动阻断请求`)
        }
    }

    // 选定第一个通过严格校验的公网 IP 作为固化目标 IP
    const pinnedIp = records[0].address
    return { pinnedIp, isLiteralIp: false }
}

/**
 * 校验目标主机名的实际 DNS 解析结果是否包含私网、回环或保留 IP
 * @param {string} hostname 主机名或 IP
 * @param {boolean} [allowLoopback=false] 是否允许本地回环 (仅当已通过协议门控时)
 * @returns {Promise<void>}
 */
export async function verifyDnsResolutionSecurity(hostname, allowLoopback = false) {
    await resolveAndPinSafeHost(hostname, allowLoopback)
}

/**
 * 使用预先固化 IP (IP Pinning) 的原生安全 HTTP 请求执行器
 * 核心防御：通过底层 lookup 回调直接固化建连目标 IP，消除两次解析之间的 TOCTOU DNS Rebinding 窗口；
 * 同时保持 TLS SNI 正常工作，与标准 fetch 返回格式对齐。
 * 代理边界说明：若请求经由外部 HTTP 代理隧道转发，TCP 建连与 DNS 解析将发生在代理端，属于外部代理边界。
 * @param {string} targetUrlStr 完整目标 URL
 * @param {Object} [fetchOptions] 请求配置
 * @returns {Promise<{ status: number, ok: boolean, headers: Object, text: () => Promise<string>, json: () => Promise<any> }>}
 */
export async function secureFetchWithPinnedDns(targetUrlStr, fetchOptions = {}) {
    const parsed = new URL(targetUrlStr)
    const isHttps = parsed.protocol === 'https:'
    const isLocalLoopback = ['localhost', '127.0.0.1', '::1'].includes(parsed.hostname.toLowerCase())

    // 1. 单次 DNS 解析并固定 IP (若校验失败在此处抛出异常阻断，绝不发包)
    const { pinnedIp } = await resolveAndPinSafeHost(parsed.hostname, isLocalLoopback)

    // 2. 使用原生 https/http 模块并发起请求，注入 lookup 回调固化目标 IP
    return new Promise((resolve, reject) => {
        const client = isHttps ? https : http
        const defaultPort = isHttps ? 443 : 80
        const port = parsed.port ? parseInt(parsed.port, 10) : defaultPort

        const reqHeaders = {
            ...(fetchOptions.headers || {}),
            Host: parsed.host
        }
        if (fetchOptions.body && !reqHeaders['Content-Length'] && !reqHeaders['content-length']) {
            reqHeaders['Content-Length'] = Buffer.byteLength(fetchOptions.body)
        }

        const reqOptions = {
            protocol: parsed.protocol,
            hostname: parsed.hostname,
            port,
            path: parsed.pathname + parsed.search,
            method: fetchOptions.method || 'GET',
            headers: reqHeaders,
            // 关键：固化底层 socket 建连解析，零二次 DNS 逃逸窗口
            lookup: (hostname, opts, cb) => {
                const callback = typeof opts === 'function' ? opts : cb
                const options = typeof opts === 'function' ? {} : opts
                const family = pinnedIp.includes(':') ? 6 : 4
                if (options && options.all) {
                    return callback(null, [{ address: pinnedIp, family }])
                }
                return callback(null, pinnedIp, family)
            },
            timeout: fetchOptions.timeout || 12000
        }

        if (isHttps) {
            reqOptions.servername = parsed.hostname // 保持 TLS SNI 正常校验服务端证书
        }

        const req = client.request(reqOptions, (res) => {
            const chunks = []
            res.on('data', chunk => chunks.push(chunk))
            res.on('end', () => {
                const bodyText = Buffer.concat(chunks).toString('utf8')
                resolve({
                    status: res.statusCode,
                    ok: res.statusCode >= 200 && res.statusCode < 300,
                    headers: res.headers,
                    text: async () => bodyText,
                    json: async () => JSON.parse(bodyText)
                })
            })
        })

        req.on('timeout', () => {
            req.destroy(new Error(`请求超时 (${reqOptions.timeout}ms)`))
        })

        req.on('error', (err) => {
            reject(err)
        })

        if (fetchOptions.body) {
            req.write(fetchOptions.body)
        }
        req.end()
    })
}

/**
 * 规范化并严格校验 AI 目标端点 URL
 * @param {string} rawUrl 待校验的目标 URL
 * @param {string} [provider] 服务商标识
 * @returns {string} 规范化后的完整 URL 字符串
 * @throws {Error} 若 URL 不合法或存在安全风险则抛出异常
 */
export function validateAndNormalizeAiUrl(rawUrl, provider = '') {
    if (!rawUrl || typeof rawUrl !== 'string') {
        throw new Error('目标服务地址不能为空')
    }

    const trimmed = rawUrl.trim()
    let parsed
    try {
        parsed = new URL(trimmed)
    } catch {
        throw new Error(`无效的目标服务 URL 格式: ${trimmed}`)
    }

    // 1. 禁止内嵌用户名和密码 (防 http://user:pass@host 凭据混淆)
    if (parsed.username || parsed.password) {
        throw new Error('目标 URL 禁止包含用户名或密码')
    }

    // 2. 协议合法性与加密传输校验
    const isLocalLoopback = ['localhost', '127.0.0.1', '::1'].includes(parsed.hostname.toLowerCase())
    const provKey = String(provider || '').toLowerCase()
    const isRemoteOfficialProvider = Object.keys(OFFICIAL_PROVIDER_HOSTS).includes(provKey)

    if (parsed.protocol === 'http:') {
        // 如果是知名远程服务商，禁止明文 HTTP；非本地回环地址也一律禁止明文 HTTP
        if (!isLocalLoopback || isRemoteOfficialProvider) {
            throw new Error(`安全限制: 远程 AI 服务商必须使用加密的 HTTPS 协议，禁止使用明文 HTTP: ${parsed.origin}`)
        }
    } else if (parsed.protocol !== 'https:') {
        throw new Error(`不支持的 URL 协议类型: ${parsed.protocol} (仅支持 HTTPS 或本地回环 HTTP)`)
    }

    // 3. 目标主机与 IP 私网/保留网段拦截校验
    if (isPrivateOrBlockedHost(parsed.hostname, isLocalLoopback)) {
        throw new Error(`安全校验拦截: 目标地址禁止指向内网私有保留 IP (${parsed.hostname})，防止 SSRF 漏洞与内网探测`)
    }

    // 3. 官方知名服务商的域名防钓鱼校验
    const officialHosts = OFFICIAL_PROVIDER_HOSTS[provKey]
    if (officialHosts && !isLocalLoopback) {
        const reqHost = parsed.hostname.toLowerCase()
        const isOfficialMatch = officialHosts.some(host => reqHost === host || reqHost.endsWith(`.${host}`))
        // 如果用户选择了官方知名服务商名字，但提供了非官方域名且非自定义网关，进行拦截
        if (!isOfficialMatch && provKey !== 'custom') {
            throw new Error(`安全校验拦截: 服务商选择为 "${provider}"，但目标地址域名 "${reqHost}" 不属于官方域名 (${officialHosts.join(', ')})。如使用第三方转发网关，请将服务商类型切换为 "custom" (自定义网关)`)
        }
    }

    // 4. 规范化路径 (去除末尾多余斜杠)
    let cleanPath = parsed.pathname.replace(/\/+$/, '')
    parsed.pathname = cleanPath
    return parsed.toString()
}

/**
 * 校验请求的端点与数据库已保存密钥的绑定关系
 * 防止攻击者利用 profileId 偷取已保存的 API Key 发往恶意地址
 * @param {object} params
 * @param {string} params.requestUrl 请求体中的目标 URL
 * @param {string} params.requestProvider 请求体中的服务商
 * @param {string} params.inputKey 用户请求体直接传入的 key
 * @param {object} [params.storedAiConfig] 数据库中已保存的 AI 配置
 * @returns {{ finalKey: string, usingStoredKey: boolean, targetUrl: string }}
 * @throws {Error} 若尝试用覆盖地址的方式偷取已保存 key 则抛出异常
 */
export function verifyAiUrlTargetBinding({ requestUrl, requestProvider, inputKey, storedAiConfig }) {
    const rawInputKey = (inputKey || '').trim()
    const isMaskedOrEmpty = !rawInputKey || rawInputKey.includes('••••')

    if (!isMaskedOrEmpty) {
        // 用户明确输入了新的明文 API Key，使用用户输入的新 Key，允许测试新地址
        const normalized = validateAndNormalizeAiUrl(requestUrl || 'https://api.openai.com/v1', requestProvider)
        return { finalKey: rawInputKey, usingStoredKey: false, targetUrl: normalized }
    }

    // 用户未输入新 Key，尝试使用已保存的密钥
    const storedKey = storedAiConfig?.apiKey ? String(storedAiConfig.apiKey).trim() : ''
    if (!storedKey) {
        throw new Error('未提供有效 API Key 且当前 Profile 未保存可用密钥')
    }

    // 关键防御：如果要沿用已保存的 Key，请求中的目标端点必须与已保存的目标端点严格一致！
    const storedNormalized = validateAndNormalizeAiUrl(storedAiConfig.baseUrl || 'https://api.openai.com/v1', storedAiConfig.provider)
    const storedParsed = new URL(storedNormalized)

    // 若调用方传入了 requestUrl，比对完整规范化端点（协议、Origin、规范化路径、Query）
    if (requestUrl && typeof requestUrl === 'string' && requestUrl.trim()) {
        const reqNormalized = validateAndNormalizeAiUrl(requestUrl.trim(), requestProvider || storedAiConfig.provider)
        const reqParsed = new URL(reqNormalized)

        const isSameHostAndOrigin = reqParsed.origin.toLowerCase() === storedParsed.origin.toLowerCase()
        const isSameProvider = !requestProvider || String(requestProvider).toLowerCase() === String(storedAiConfig.provider || '').toLowerCase()

        if (!isSameHostAndOrigin || !isSameProvider) {
            throw new Error(
                `安全防御拦截 (S2): 使用已保存的 API Key 时，禁止覆盖目标地址或服务商。\n` +
                `已绑定目标: [${storedAiConfig.provider}] ${storedParsed.origin}\n` +
                `请求目标: [${requestProvider}] ${reqParsed.origin}\n` +
                `若要更换自定义网关或目标地址，必须在输入框中显式输入对应的新 API Key！`
            )
        }

        // 核心加固：比对规范化路径，禁止同域替换 path（例如 /evil 替换 /v1）
        const reqCleanPath = reqParsed.pathname.replace(/\/+$/, '')
        const storedCleanPath = storedParsed.pathname.replace(/\/+$/, '')
        if (reqCleanPath !== storedCleanPath) {
            throw new Error(
                `安全防御拦截 (S2): 使用已保存的 API Key 时，禁止同域替换目标端点路径。\n` +
                `已绑定路径: ${storedCleanPath || '/'}\n` +
                `请求路径: ${reqCleanPath || '/'}\n` +
                `若要更换端点路径，必须在输入框中显式输入对应的新 API Key！`
            )
        }

        // 核心加固：禁止附加或篡改 URL Query
        if (reqParsed.search !== storedParsed.search) {
            throw new Error(`安全防御拦截 (S2): 使用已保存的 API Key 时，禁止附加或修改 URL Query 参数`)
        }
    }

    return { finalKey: storedKey, usingStoredKey: true, targetUrl: storedNormalized }
}

/**
 * 敏感错误消息脱敏处理，绝不在任何报错中回显 API Key
 * @param {string} errorMsg 原始错误文本
 * @param {string} [apiKey] 需要过滤的敏感 key
 * @returns {string} 脱敏后的错误信息
 */
export function sanitizeErrorKey(errorMsg, apiKey) {
    if (!errorMsg || typeof errorMsg !== 'string') return ''
    let cleaned = errorMsg
    if (apiKey && apiKey.length >= 6) {
        cleaned = cleaned.replaceAll(apiKey, '***')
    }
    // 正则过滤常见的 sk- 开头或类似 key 的形式
    cleaned = cleaned.replace(/(Bearer\s+)[A-Za-z0-9_\-\.]{8,}/gi, '$1***')
    cleaned = cleaned.replace(/(sk-[A-Za-z0-9_\-\.]{8,})/gi, '***')
    cleaned = cleaned.replace(/(AIza[0-9A-Za-z-_]{30,})/gi, '***')
    return cleaned
}
