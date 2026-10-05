import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs/promises'
import path from 'node:path'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { sanitizeDiagnosticContent, errorDiagnostic, unknownPageDiagnostic } = require('../../dist/util/ErrorDiagnostic')

test('sanitizeDiagnosticContent redacts passwords, totp, tokens, and cookies', () => {
    const rawHtml = `
    <html>
        <body>
            <input type="password" name="passwd" value="MySuperSecretPassword123!" id="i0118">
            <input name="totp" value="123456">
            <input value="secret_pwd" type="password">
            <textarea name="user_notes">My confidential private note in textarea</textarea>
            <a href="https://login.live.com/login.srf?code=oauth_code_xyz&secret=topsecret">Link</a>
            <p>Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.e30.t-ID</p>
            <p>Cookie: MSPCAuth=auth_val_12345; session=sess_987654</p>
            <script>
                const data = {
                    "password": "raw_password",
                    "apiKey": "sk-1234567890",
                    "access_token": "ya29.secret_access_token_val",
                    "refresh_token": "1//secret_refresh_token_xyz"
                };
            </script>
        </body>
    </html>
    `

    const sanitized = sanitizeDiagnosticContent(rawHtml)

    assert.ok(!sanitized.includes('MySuperSecretPassword123!'))
    assert.ok(!sanitized.includes('123456'))
    assert.ok(!sanitized.includes('secret_pwd'))
    assert.ok(!sanitized.includes('My confidential private note in textarea'))
    assert.ok(!sanitized.includes('oauth_code_xyz'))
    assert.ok(!sanitized.includes('topsecret'))
    assert.ok(!sanitized.includes('eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9'))
    assert.ok(!sanitized.includes('auth_val_12345'))
    assert.ok(!sanitized.includes('sess_987654'))
    assert.ok(!sanitized.includes('raw_password'))
    assert.ok(!sanitized.includes('sk-1234567890'))
    assert.ok(!sanitized.includes('ya29.secret_access_token_val'))
    assert.ok(!sanitized.includes('1//secret_refresh_token_xyz'))

    assert.ok(sanitized.includes('[REDACTED]'))
})

test('errorDiagnostic creates files with 0o600 and directory with 0o700 and sanitized contents', async () => {
    const fakePage = {
        isClosed: () => false,
        content: async () => '<html><input type="password" value="my_secret_in_dom"></html>',
        screenshot: async () => Buffer.from('fake-png-bytes')
    }

    const fakeError = new Error('Failed to login with password=super_secret_query')
    fakeError.stack = 'Error: Failed\n    at login (file:///test.js?password=super_secret_query)'

    // Capture console output
    let savedDir = null
    const savedDirs = []
    const originalLog = console.log
    console.log = (msg) => {
        if (typeof msg === 'string' && msg.includes('Diagnostics saved to:')) {
            savedDir = msg.replace('Diagnostics saved to:', '').trim()
            savedDirs.push(savedDir)
        }
        originalLog(msg)
    }

    try {
        delete process.env.MS_CAPTURE_DIAGNOSTIC_SCREENSHOT
        await errorDiagnostic(fakePage, fakeError)

        assert.ok(savedDir, 'outputDir must be logged')

        // Verify directory mode: 0o700 (directory permissions mask on Unix)
        const dirStat = await fs.stat(savedDir)
        const dirMode = dirStat.mode & 0o777
        assert.equal(dirMode, 0o700, 'Directory mode must be 0o700')

        // Verify files mode: 0o600
        const htmlPath = path.join(savedDir, 'dump.html')
        const txtPath = path.join(savedDir, 'error.txt')
        const pngPath = path.join(savedDir, 'screenshot.png')

        const htmlStat = await fs.stat(htmlPath)
        const txtStat = await fs.stat(txtPath)

        assert.equal(htmlStat.mode & 0o777, 0o600, 'dump.html mode must be 0o600')
        assert.equal(txtStat.mode & 0o777, 0o600, 'error.txt mode must be 0o600')

        // 验证默认情况下不保存 screenshot.png
        const pngExistsDefault = await fs.access(pngPath).then(() => true).catch(() => false)
        assert.equal(pngExistsDefault, false, 'screenshot.png must NOT be saved by default')

        // 验证开启 MS_CAPTURE_DIAGNOSTIC_SCREENSHOT 时保存 screenshot.png 且为 0o600
        process.env.MS_CAPTURE_DIAGNOSTIC_SCREENSHOT = 'true'
        await errorDiagnostic(fakePage, fakeError)
        const pngPathEnabled = path.join(savedDir, 'screenshot.png')
        const pngStatEnabled = await fs.stat(pngPathEnabled)
        assert.equal(pngStatEnabled.mode & 0o777, 0o600, 'screenshot.png mode must be 0o600 when enabled')
        delete process.env.MS_CAPTURE_DIAGNOSTIC_SCREENSHOT

        // Verify contents are sanitized
        const htmlContent = await fs.readFile(htmlPath, 'utf-8')
        const txtContent = await fs.readFile(txtPath, 'utf-8')

        assert.ok(!htmlContent.includes('my_secret_in_dom'))
        assert.ok(htmlContent.includes('[REDACTED]'))

        assert.ok(!txtContent.includes('super_secret_query'))
        assert.ok(txtContent.includes('[REDACTED]'))
    } finally {
        console.log = originalLog
        if (savedDirs.length > 0) {
            for (const d of savedDirs) {
                await fs.rm(d, { recursive: true, force: true }).catch(() => {})
            }
        }
    }
})

test('unknownPageDiagnostic gates screenshot by default and redacts errors array', async () => {
    delete process.env.MS_CAPTURE_DIAGNOSTIC_SCREENSHOT

    const fakePage = {
        isClosed: () => false,
        url: () => 'https://login.live.com/oauth?client_id=123&client_secret=top_secret_code',
        content: async () => {
            throw new Error('Failed to get content with token=my_secret_oauth_token')
        },
        screenshot: async () => Buffer.from('fake-screenshot-data')
    }

    const outputDir = await unknownPageDiagnostic(fakePage, { platform: 'desktop' })
    assert.ok(outputDir, 'outputDir must be returned')

    try {
        const metadataPath = path.join(outputDir, 'metadata.json')
        const metadataRaw = await fs.readFile(metadataPath, 'utf8')
        const metadata = JSON.parse(metadataRaw)

        // 默认情况下不捕获 screenshot
        assert.equal(metadata.screenshotCaptured, false)
        const screenshotExists = await fs.access(path.join(outputDir, 'screenshot.png')).then(() => true).catch(() => false)
        assert.equal(screenshotExists, false, 'screenshot.png must not be saved when gate is off')

        // errors 数组中敏感 token 必须被脱敏
        assert.ok(!metadataRaw.includes('my_secret_oauth_token'))
        assert.ok(metadataRaw.includes('[REDACTED]'))
        assert.ok(!metadata.url.includes('top_secret_code'))
    } finally {
        if (outputDir) {
            // 仅清理本次测试生成的叶子输出目录，严禁递归删除上级 unknown-login-pages 目录
            await fs.rm(outputDir, { recursive: true, force: true }).catch(() => {})
        }
    }
})
