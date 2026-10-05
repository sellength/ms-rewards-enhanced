import assert from 'node:assert/strict'
import test from 'node:test'

import { runIsolatedTask } from '../../dist/util/TaskIsolation.js'

test('an isolated task reports its error without rejecting the surrounding task flow', async () => {
    const calls = []
    const errors = []

    calls.push('before')
    const succeeded = await runIsolatedTask(
        async () => {
            calls.push('failing-task')
            throw new Error('expected failure')
        },
        error => errors.push(error)
    )
    calls.push('after')

    assert.equal(succeeded, false)
    assert.deepEqual(calls, ['before', 'failing-task', 'after'])
    assert.equal(errors.length, 1)
    assert.match(String(errors[0]), /expected failure/)
})

test('an isolated task returns success and does not emit an error', async () => {
    const errors = []
    const succeeded = await runIsolatedTask(
        async () => {},
        error => errors.push(error)
    )

    assert.equal(succeeded, true)
    assert.deepEqual(errors, [])
})
