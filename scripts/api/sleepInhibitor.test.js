import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { EventEmitter } from 'node:events'
import {
    isContainerEnvironment,
    buildInhibitorCommand,
    createSleepInhibitor,
    TASK_RUNNING_STATE_FILENAME,
    HOST_GUARD_STATE_FILENAME
} from './sleepInhibitor.mjs'

test('isContainerEnvironment: detects DOCKER_CONTAINER env or Linux /.dockerenv', () => {
    assert.equal(isContainerEnvironment({ platform: 'darwin', env: {}, existsSync: () => false }), false)
    assert.equal(
        isContainerEnvironment({ platform: 'linux', env: { DOCKER_CONTAINER: 'true' }, existsSync: () => false }),
        true
    )
    assert.equal(
        isContainerEnvironment({
            platform: 'linux',
            env: {},
            existsSync: (p) => p === '/.dockerenv'
        }),
        true
    )
    assert.equal(
        isContainerEnvironment({
            platform: 'win32',
            env: {},
            existsSync: () => true
        }),
        false
    )
})

test('buildInhibitorCommand: macOS/Windows/Linux inhibit system sleep while allowing screen lock', () => {
    const mac = buildInhibitorCommand({ platform: 'darwin', targetPid: 4321 })
    assert.equal(mac.command, 'caffeinate')
    assert.deepEqual(mac.args, ['-i', '-s', '-w', '4321'])
    assert.equal(mac.args.includes('-d'), false, 'macOS must NOT pass -d so display sleep and screen lock remain allowed')

    const win = buildInhibitorCommand({ platform: 'win32', targetPid: 4321 })
    assert.equal(win.command, 'powershell.exe')
    const winCmd = win.args.join(' ')
    assert.ok(winCmd.includes('0x80000001'), 'Windows must set ES_CONTINUOUS | ES_SYSTEM_REQUIRED (0x80000001)')
    assert.ok(!winCmd.includes('0x80000003'), 'Windows must NOT set ES_DISPLAY_REQUIRED so screen lock remains allowed')
    assert.ok(winCmd.includes('0x80000000'), 'Windows must reset to ES_CONTINUOUS (0x80000000) in finally block')

    const linux = buildInhibitorCommand({ platform: 'linux', targetPid: 4321 })
    assert.equal(linux.command, 'systemd-inhibit')
    assert.ok(linux.args.includes('--what=sleep:idle'))
})

test('createSleepInhibitor: acquires OS sleep lock on start and immediately releases on finish', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ms-sleep-inhibitor-'))
    try {
        let killedWith = null
        const fakeChild = new EventEmitter()
        fakeChild.pid = 9988
        fakeChild.kill = (sig) => { killedWith = sig }
        fakeChild.unref = () => {}

        const inhibitor = createSleepInhibitor({
            platform: 'darwin',
            env: {},
            existsSyncFn: () => false,
            stateDir: tempDir,
            spawnFn: () => fakeChild
        })

        const acquired = inhibitor.acquire({ targetPid: 1234, reason: 'all' })
        assert.equal(acquired.active, true)
        assert.equal(acquired.method, 'caffeinate')
        assert.equal(acquired.inhibitorPid, 9988)

        const taskStateFile = path.join(tempDir, TASK_RUNNING_STATE_FILENAME)
        assert.equal(fs.existsSync(taskStateFile), true, '.task_running.json must be created while task is running')

        const released = inhibitor.release()
        assert.equal(released, true)
        assert.equal(killedWith, 'SIGTERM', 'inhibitor child process must be terminated on release()')
        assert.equal(fs.existsSync(taskStateFile), false, '.task_running.json must be removed immediately on release()')
        assert.equal(inhibitor.status().active, false)
    } finally {
        fs.rmSync(tempDir, { recursive: true, force: true })
    }
})

test('createSleepInhibitor: container mode delegates to host guard via shared state file', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ms-sleep-container-'))
    try {
        fs.writeFileSync(
            path.join(tempDir, HOST_GUARD_STATE_FILENAME),
            JSON.stringify({
                active: true,
                daemonReady: true,
                platform: 'darwin',
                method: 'caffeinate',
                updatedAt: Date.now()
            }),
            'utf-8'
        )

        let spawnCalled = false
        const inhibitor = createSleepInhibitor({
            platform: 'linux',
            env: { DOCKER_CONTAINER: 'true' },
            stateDir: tempDir,
            spawnFn: () => { spawnCalled = true }
        })

        const status = inhibitor.acquire({ targetPid: 5566, reason: 'desktop' })
        assert.equal(spawnCalled, false, 'Container must not spawn host power command inside container')
        assert.equal(status.delegatedToHost, true)
        assert.equal(status.hostGuardActive, true)
        assert.equal(status.hostGuardPlatform, 'darwin')
        assert.equal(fs.existsSync(path.join(tempDir, TASK_RUNNING_STATE_FILENAME)), true)

        inhibitor.release()
        assert.equal(fs.existsSync(path.join(tempDir, TASK_RUNNING_STATE_FILENAME)), false)
    } finally {
        fs.rmSync(tempDir, { recursive: true, force: true })
    }
})
