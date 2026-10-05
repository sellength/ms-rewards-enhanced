import fs from 'node:fs'

export function clearAccountSessionStorage(db, email) {
    const account = String(email || '').trim()
    db.exec('BEGIN IMMEDIATE')
    try {
        let result
        if (account) {
            result = db.prepare('DELETE FROM sessions WHERE lower(email) = lower(?)').run(account)
            if (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'account_metadata'").get()) {
                db.prepare('DELETE FROM account_metadata WHERE lower(email) = lower(?)').run(account)
            }
        } else {
            result = db.prepare('DELETE FROM sessions').run()
            if (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'account_metadata'").get()) {
                db.prepare('DELETE FROM account_metadata').run()
            }
        }
        db.exec('COMMIT')
        return Number(result.changes || 0)
    } catch (error) {
        db.exec('ROLLBACK')
        throw error
    }
}

// Only this application's active account configuration and presentation caches.
export function clearAccountLoginFiles(envPath, cachePaths, environment = process.env) {
    if (fs.existsSync(envPath)) {
        const raw = fs.readFileSync(envPath, 'utf8')
        const cleaned = raw.split('\n').filter(line => !/^\s*(?:export\s+)?ACCOUNT_1_[A-Z_]+\s*=/.test(line)).join('\n')
        fs.writeFileSync(envPath, cleaned, { mode: 0o600 })
    }
    for (const key of Object.keys(environment)) {
        if (/^ACCOUNT_1_[A-Z_]+$/.test(key)) delete environment[key]
    }
    for (const cachePath of cachePaths) fs.rmSync(cachePath, { force: true })
}
