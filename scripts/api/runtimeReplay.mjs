// Local UI replay only. Never used as official points/completion truth.
export function createRuntimeReplay({ limit = 2000, now = () => new Date() } = {}) {
    const fresh = () => ({ running: false, tasks: {}, logs: [], action: null, countdown: null })
    const state = { desktop: fresh(), mobile: fresh() }
    const dayKey = () => now().toLocaleDateString('en-CA')
    let day = dayKey()
    function trimDay() {
        if (day === dayKey()) return
        day = dayKey()
        for (const item of Object.values(state)) {
            item.logs = []
            if (!item.running) { item.tasks = {}; item.action = null; item.countdown = null }
        }
    }
    return {
        reset() { state.desktop = fresh(); state.mobile = fresh(); day = dayKey() },
        record(event) {
            trimDay()
            const item = state[event.platform === 'mobile' ? 'mobile' : 'desktop']
            if (event.type === 'runState') {
                item.running = event.running
                if (event.running) { item.tasks = {}; item.action = null; item.countdown = null }
            } else if (event.type === 'taskStatus') {
                item.tasks[JSON.stringify([event.taskId, event.itemId || ''])] = { ...event }
            } else if (event.type === 'log' && item.running) {
                item.logs.push({ ...event })
                if (item.logs.length > limit) item.logs.splice(0, item.logs.length - limit)
            } else if ((event.type === 'action' || event.type === 'countdown') && item.running) {
                item[event.type] = { ...event, recordedAt: now().getTime() }
            } else if (event.type === 'finished') {
                item.running = false
                item.countdown = null
                for (const task of Object.values(item.tasks)) {
                    if (task.status === 'RUNNING') task.status = 'PENDING'
                }
            }
        },
        snapshot() {
            trimDay()
            const result = structuredClone(state)
            for (const item of Object.values(result)) {
                if (item.countdown) {
                    item.countdown.sec = Math.max(0, Number(item.countdown.sec) - Math.floor((now().getTime() - item.countdown.recordedAt) / 1000))
                    if (!item.countdown.sec) item.countdown = null
                }
            }
            return result
        }
    }
}
