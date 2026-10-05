import fs from 'fs/promises'
import path from 'path'
import { createHash } from 'crypto'
import type { Page } from 'patchright'

interface UnknownPageDiagnosticOptions {
    platform: 'mobile' | 'desktop'
}

export function sanitizeDiagnosticContent(content: string): string {
    if (!content || typeof content !== 'string') return ''

    let sanitized = content

    // 1. Password input values in HTML
    sanitized = sanitized.replace(
        /(<input[^>]*type=["']?password["']?[^>]*\bvalue=["'])([^"']*)(["'])/gi,
        '$1[REDACTED]$3'
    )
    sanitized = sanitized.replace(
        /(<input[^>]*\bvalue=["'])([^"']*)(["'][^>]*type=["']?password["']?)/gi,
        '$1[REDACTED]$3'
    )

    // 2. Sensitive input fields by name
    sanitized = sanitized.replace(
        /(<input[^>]*name=["']?(?:passwd|password|pwd|totp|otp|code|secret)["']?[^>]*\bvalue=["'])([^"']*)(["'])/gi,
        '$1[REDACTED]$3'
    )
    sanitized = sanitized.replace(
        /(<input[^>]*\bvalue=["'])([^"']*)(["'][^>]*name=["']?(?:passwd|password|pwd|totp|otp|code|secret)["']?)/gi,
        '$1[REDACTED]$3'
    )

    // 3. Textarea elements
    sanitized = sanitized.replace(
        /(<textarea[^>]*>)([\s\S]*?)(<\/textarea>)/gi,
        '$1[REDACTED]$3'
    )

    // 4. Sensitive URL query parameters
    sanitized = sanitized.replace(
        /([?&](?:passwd|password|pwd|totp|otp|code|secret|client_secret|clientSecret|app_secret|access_token|accessToken|refresh_token|refreshToken|id_token|idToken|auth_token|authToken|token|apikey|api_key|apiKey)=)[^&\s"'<>]+/gi,
        '$1[REDACTED]'
    )

    // 5. Authorization headers / Bearer tokens
    sanitized = sanitized.replace(
        /(Authorization:\s*Bearer\s+)[A-Za-z0-9\-._~+/]+=*/gi,
        '$1[REDACTED]'
    )
    sanitized = sanitized.replace(
        /(Bearer\s+)[A-Za-z0-9\-._~+/]{20,}/gi,
        '$1[REDACTED]'
    )

    // 6. Sensitive cookies in headers or HTML
    sanitized = sanitized.replace(
        /((?:authToken|token|MSPCAuth|session|sessionid|passwd|password|access_token)=)[^;,\s"'<>]+/gi,
        '$1[REDACTED]'
    )

    // 7. JSON sensitive properties (supports both camelCase and snake_case)
    sanitized = sanitized.replace(
        /(["'](?:password|passwd|pwd|totp|otp|code|secret|api_?key|api_?token|access_?token|refresh_?token|auth_?token|session_?id|client_?secret|apiKeyMasked)["']\s*:\s*["'])[^"']*?(["'])/gi,
        '$1[REDACTED]$2'
    )

    return sanitized
}

async function ensureSecureDir(dirPath: string): Promise<void> {
    await fs.mkdir(dirPath, { recursive: true, mode: 0o700 })
    await fs.chmod(dirPath, 0o700).catch(() => {})
}

function safePathSegment(value: string, fallback: string): string {
    const sanitized = value
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 80)

    return sanitized || fallback
}

function unknownPageOutputDir(rawUrl: string, capturedAt: string, platform: string): string {
    let hostname = 'unknown-host'
    let pathname = 'root'

    try {
        const url = new URL(rawUrl)
        hostname = safePathSegment(url.hostname, hostname)
        pathname = safePathSegment(url.pathname, pathname)
    } catch {
        pathname = safePathSegment(rawUrl, 'unknown-page')
    }

    const urlHash = createHash('sha256').update(rawUrl).digest('hex').slice(0, 12)
    const urlFolder = `${pathname}-${urlHash}`
    const captureFolder = `${capturedAt.replace(/[:.]/g, '-')}-${platform}`

    return path.join(process.cwd(), 'diagnostics', 'unknown-login-pages', hostname, urlFolder, captureFolder)
}

export async function errorDiagnostic(page: Page, error: Error): Promise<void> {
    try {
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-')
        const folderName = `error-${timestamp}`
        const outputDir = path.join(process.cwd(), 'diagnostics', folderName)

        if (!page) {
            return
        }

        if (page.isClosed()) {
            return
        }

        const rawErrorLog = `
Name: ${error.name}
Message: ${error.message}
Timestamp: ${new Date().toISOString()}
---------------------------------------------------
Stack Trace:
${error.stack || 'No stack trace available'}
        `.trim()

        const shouldCaptureScreenshot = process.env.MS_CAPTURE_DIAGNOSTIC_SCREENSHOT === 'true'

        const [rawHtmlContent, screenshotBuffer] = await Promise.all([
            page.content(),
            shouldCaptureScreenshot ? page.screenshot({ fullPage: true, type: 'png' }).catch(() => null) : Promise.resolve(null)
        ])

        const sanitizedHtml = sanitizeDiagnosticContent(rawHtmlContent)
        const sanitizedErrorLog = sanitizeDiagnosticContent(rawErrorLog)

        await ensureSecureDir(outputDir)

        const writes = [
            fs.writeFile(path.join(outputDir, 'dump.html'), sanitizedHtml, { mode: 0o600 }),
            fs.writeFile(path.join(outputDir, 'error.txt'), sanitizedErrorLog, { mode: 0o600 })
        ]

        if (shouldCaptureScreenshot && screenshotBuffer) {
            writes.push(fs.writeFile(path.join(outputDir, 'screenshot.png'), screenshotBuffer, { mode: 0o600 }))
        }

        await Promise.all(writes)

        console.log(`Diagnostics saved to: ${outputDir}`)
    } catch (error) {
        console.error('Unable to create error diagnostics:', error)
    }
}

export async function unknownPageDiagnostic(
    page: Page,
    { platform }: UnknownPageDiagnosticOptions
): Promise<string | null> {
    if (!page || page.isClosed()) return null

    const capturedAt = new Date().toISOString()
    const rawUrl = page.url()
    const outputDir = unknownPageOutputDir(rawUrl, capturedAt, platform)

    try {
        await ensureSecureDir(outputDir)

        const shouldCaptureScreenshot = process.env.MS_CAPTURE_DIAGNOSTIC_SCREENSHOT === 'true'
        const [htmlResult, screenshotResult] = await Promise.allSettled([
            page.content(),
            shouldCaptureScreenshot ? page.screenshot({ fullPage: true, type: 'png' }) : Promise.resolve(null)
        ])

        const sanitizedUrl = sanitizeDiagnosticContent(rawUrl)
        const metadata = {
            url: sanitizedUrl,
            capturedAt,
            platform,
            htmlCaptured: htmlResult.status === 'fulfilled',
            screenshotCaptured: screenshotResult.status === 'fulfilled' && Boolean(screenshotResult.value),
            errors: [
                htmlResult.status === 'rejected'
                    ? `HTML: ${htmlResult.reason instanceof Error ? htmlResult.reason.message : String(htmlResult.reason)}`
                    : null,
                screenshotResult.status === 'rejected'
                    ? `Screenshot: ${screenshotResult.reason instanceof Error ? screenshotResult.reason.message : String(screenshotResult.reason)}`
                    : null
            ].filter((error): error is string => error !== null).map(err => sanitizeDiagnosticContent(err))
        }

        const writes: Promise<void>[] = [
            fs.writeFile(path.join(outputDir, 'metadata.json'), JSON.stringify(metadata, null, 2), { mode: 0o600 })
        ]

        if (htmlResult.status === 'fulfilled') {
            const sanitizedHtml = sanitizeDiagnosticContent(htmlResult.value)
            writes.push(fs.writeFile(path.join(outputDir, 'page.html'), sanitizedHtml, { mode: 0o600 }))
        }
        if (screenshotResult.status === 'fulfilled' && screenshotResult.value) {
            writes.push(fs.writeFile(path.join(outputDir, 'screenshot.png'), screenshotResult.value, { mode: 0o600 }))
        }

        await Promise.all(writes)
        console.log(`Unknown login page diagnostics saved to: ${outputDir}`)
        return outputDir
    } catch (error) {
        console.error('Unable to create unknown login page diagnostics:', error)
        return null
    }
}

