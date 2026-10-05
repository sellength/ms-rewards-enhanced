// Log text is a refresh hint, never a source of balances or completion truth.
export function shouldRefreshRun(line) {
    if (/\bentry_probe_(complete|interaction_required|unverified)\b/.test(line)) return true
    if (/\bskip_|\[PLAN\]/i.test(line)) return false
    return /\bpointsGained=[1-9]\d*\b|\bprogressGained=[1-9]\d*\b|\bcompleted (?:UrlReward|SearchOnBing|Bing searches|Read to Earn)\b|verified by (?:SAAndroid|Microsoft|today's SAAndroid)|Submitted Edge browsing report/i.test(line)
}

export function createLiveRunSync({ refresh, onError = () => {}, now = Date.now,
    setTimer = setTimeout, clearTimer = clearTimeout, interval = 30000, debounce = 2000 } = {}) {
    let timer = null, pending = false, stopped = false, inFlight = null, nextAt = 0, failures = 0
    function schedule() {
        if (stopped || !pending || timer !== null || inFlight) return
        timer = setTimer(() => {
            timer = null
            pending = false
            inFlight = Promise.resolve().then(refresh).then(() => {
                failures = 0
                nextAt = now() + interval
            }).catch(error => {
                nextAt = now() + [60000, 120000, 300000][Math.min(failures++, 2)]
                pending = true
                onError(error)
            }).finally(() => { inFlight = null; schedule() })
        }, Math.max(debounce, nextAt - now()))
    }
    return {
        request() { if (!stopped) { pending = true; schedule() } },
        async stop() {
            stopped = true
            pending = false
            if (timer !== null) clearTimer(timer)
            timer = null
            if (inFlight) await inFlight
        }
    }
}
