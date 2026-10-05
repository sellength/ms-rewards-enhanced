// scripts/api/testDummyBot.js
// Safe dummy bot process used solely by integration tests to avoid running real automation.

// 自身最长存活 10 秒超时自毁保护，防止任何意外遗留
const selfDestructTimer = setTimeout(() => {
    process.exit(0)
}, 10000)
if (typeof selfDestructTimer.unref === 'function') {
    selfDestructTimer.unref()
}

const interval = setInterval(() => {
    // Keep process alive safely until terminated by test
}, 1000)

const shutdown = () => {
    clearInterval(interval)
    clearTimeout(selfDestructTimer)
    process.exit(0)
}

process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)

