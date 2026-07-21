import assert from 'node:assert/strict'
import test from 'node:test'
import { start } from '../server/http/server.js'

test('本地模型运行状态接口返回系统默认缓存目录', async () => {
  const server = await start(0)
  try {
    const address = server.address()
    assert.ok(address && typeof address === 'object')
    const response = await fetch(`http://127.0.0.1:${address.port}/api/local-model/status`)
    assert.equal(response.status, 200)
    const status = await response.json() as { phase: string; cacheDirectory: string }
    assert.equal(status.phase, 'idle')
    assert.match(status.cacheDirectory.replaceAll('\\', '/'), /data\/models\/cache$/)
  } finally {
    await new Promise<void>((resolvePromise, reject) => server.close(error => error ? reject(error) : resolvePromise()))
  }
})
