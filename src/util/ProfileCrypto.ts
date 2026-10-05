import crypto from 'node:crypto'
import os from 'node:os'

const ALGORITHM = 'aes-256-gcm'
const IV_LENGTH = 12

import fs from 'node:fs'
import path from 'node:path'

function getSafeUsername(): string {
    try {
        const u = os.userInfo()?.username
        if (u) return u
    } catch (_) {}
    return process.env.USER || process.env.USERNAME || 'default_user'
}

function getSafeHomedir(): string {
    try {
        const h = os.homedir()
        if (h) return h
    } catch (_) {}
    return process.env.HOME || process.env.USERPROFILE || '.'
}

function getSafeMachineEntropyKey(salt = 'antigravity-ms-rewards-device-salt-2026-v2', hostname = ''): Buffer {
    const parts = [
        getSafeUsername(),
        getSafeHomedir(),
        process.platform || 'darwin',
        process.arch || 'arm64',
        salt
    ]
    if (hostname) parts.unshift(hostname)
    return crypto.createHash('sha256').update(parts.join(':')).digest()
}

function getOrCreateDeviceKey(): Buffer {
    const envSecret = (process.env.MS_ENCRYPTION_SECRET || process.env.ENCRYPTION_SECRET || '').trim()
    if (envSecret) {
        return crypto.createHash('sha256').update(envSecret).digest()
    }

    const keyPath = path.join(process.cwd(), 'sessions', '.device_key')
    try {
        if (fs.existsSync(keyPath)) {
            const raw = fs.readFileSync(keyPath, 'utf8').trim()
            if (raw.length === 64 && /^[0-9a-fA-F]+$/.test(raw)) {
                return Buffer.from(raw, 'hex')
            }
        }
    } catch (_) {}

    const newKey = crypto.randomBytes(32)
    try {
        const dir = path.dirname(keyPath)
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
        fs.writeFileSync(keyPath, newKey.toString('hex'), { mode: 0o600 })
        try { fs.chmodSync(keyPath, 0o600) } catch (_) {}
        return newKey
    } catch (_) {
        return getSafeMachineEntropyKey('antigravity-ms-rewards-device-salt-2026-v2')
    }
}

function getDerivedDeviceKey(): Buffer {
    return getOrCreateDeviceKey()
}

function getLegacyCandidateKeys(): Buffer[] {
    const keys: Buffer[] = []

    const envSecret = (process.env.MS_ENCRYPTION_SECRET || process.env.ENCRYPTION_SECRET || '').trim()
    if (envSecret) {
        keys.push(crypto.createHash('sha256').update(envSecret).digest())
    }

    const keyPath = path.join(process.cwd(), 'sessions', '.device_key')
    try {
        if (fs.existsSync(keyPath)) {
            const raw = fs.readFileSync(keyPath, 'utf8').trim()
            if (raw.length === 64 && /^[0-9a-fA-F]+$/.test(raw)) {
                keys.push(Buffer.from(raw, 'hex'))
            }
        }
    } catch (_) {}

    keys.push(getSafeMachineEntropyKey('antigravity-ms-rewards-device-salt-2026-v2'))

    let curHost = ''
    try { curHost = os.hostname() || '' } catch (_) {}
    const hostnames = new Set([
        curHost,
        curHost ? curHost.replace(/\.(local|lan)$/i, '') : '',
        curHost ? `${curHost.replace(/\.(local|lan)$/i, '')}.local` : '',
        curHost ? `${curHost.replace(/\.(local|lan)$/i, '')}.lan` : '',
        'Mac.lan',
        'zjMacBook-Pro.local',
        'zjMacBook-Pro',
        'MacBook-Pro.local',
        'MacBook-Pro',
        'localhost',
        'localhost.localdomain',
        ''
    ])

    for (const h of hostnames) {
        keys.push(getSafeMachineEntropyKey('antigravity-ms-rewards-device-salt-2026-v1', h))
    }

    return keys
}

export function encryptSecret(plainText: string): string {
    if (!plainText || typeof plainText !== 'string') return ''
    const key = getDerivedDeviceKey()
    const iv = crypto.randomBytes(IV_LENGTH)
    const cipher = crypto.createCipheriv(ALGORITHM, key, iv)

    let encrypted = cipher.update(plainText, 'utf8', 'hex')
    encrypted += cipher.final('hex')
    const authTag = cipher.getAuthTag().toString('hex')

    return `enc:v1:${iv.toString('hex')}:${authTag}:${encrypted}`
}

export function decryptSecret(cipherText: string): string {
    if (!cipherText || typeof cipherText !== 'string') return ''
    if (!cipherText.startsWith('enc:v1:')) {
        return cipherText
    }

    try {
        const parts = cipherText.split(':')
        if (parts.length !== 5) return ''

        const ivHex = parts[2]
        const authTagHex = parts[3]
        const encryptedHex = parts[4]
        if (!ivHex || !authTagHex || !encryptedHex) return ''

        const iv = Buffer.from(ivHex, 'hex')
        const authTag = Buffer.from(authTagHex, 'hex')

        const primaryKey = getDerivedDeviceKey()
        try {
            const decipher = crypto.createDecipheriv(ALGORITHM, primaryKey, iv)
            decipher.setAuthTag(authTag)
            const part1 = decipher.update(encryptedHex, 'hex', 'utf8')
            const part2 = decipher.final('utf8')
            return part1 + part2
        } catch (_) {}

        for (const legacyKey of getLegacyCandidateKeys()) {
            try {
                const decipher = crypto.createDecipheriv(ALGORITHM, legacyKey, iv)
                decipher.setAuthTag(authTag)
                const part1 = decipher.update(encryptedHex, 'hex', 'utf8')
                const part2 = decipher.final('utf8')
                return part1 + part2
            } catch (_) {}
        }

        return ''
    } catch (_) {
        return ''
    }
}

export function maskSecret(secret: string): string {
    if (!secret || typeof secret !== 'string') return ''
    const trimmed = secret.trim()
    if (trimmed.length <= 6) return '••••••'
    if (trimmed.startsWith('sk-') && trimmed.length > 10) {
        return `sk-••••••••${trimmed.slice(-4)}`
    }
    const visibleStart = Math.min(3, Math.floor(trimmed.length / 4))
    const visibleEnd = Math.min(4, Math.floor(trimmed.length / 4))
    return `${trimmed.slice(0, visibleStart)}••••••••${trimmed.slice(-visibleEnd)}`
}
