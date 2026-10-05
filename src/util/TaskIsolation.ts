export async function runIsolatedTask(task: () => Promise<void>, onError: (error: unknown) => void): Promise<boolean> {
    try {
        await task()
        return true
    } catch (error) {
        onError(error)
        return false
    }
}
