import assert from 'node:assert/strict'
import test from 'node:test'
import { PostgresStore } from '../server/infrastructure/postgres-store.js'

// Failure-boundary tests only: actual SQL/migrations are verified separately by
// npm run test:postgres against an isolated PostgreSQL database.
function clientDouble(rollbackError?: Error) {
  const statements: string[] = []
  const releases: boolean[] = []
  return {
    statements,
    releases,
    async query(sql: string) {
      statements.push(sql)
      if (sql === 'ROLLBACK' && rollbackError) throw rollbackError
      return { rows: [], rowCount: 0 }
    },
    release(discard = false) { releases.push(discard) },
  }
}

async function storeDouble(connect: () => Promise<ReturnType<typeof clientDouble>>) {
  const store = new PostgresStore('postgresql://unused:unused@127.0.0.1:1/smarthub_test')
  await store.close()
  Object.defineProperty(store, 'pool', { value: { connect, async end() {} } })
  return store
}

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(done => { resolve = done })
  return { promise, resolve }
}

for (const mode of ['transaction', 'transactionScope'] as const) {
  function write<T>(store: PostgresStore, operation: () => T | Promise<T>) {
    return mode === 'transaction'
      ? store.transaction(operation)
      : store.transactionScope('test_execution_infrastructure_configuration', operation)
  }

  test(`PostgresStore ${mode} preserves the original write error`, async () => {
    const client = clientDouble()
    const store = await storeDouble(async () => client)
    const original = new Error('original write failure', { cause: new Error('database unavailable') })
    await assert.rejects(write(store, () => { throw original }), error => error === original)
    assert.ok(client.statements.includes('ROLLBACK'))
    assert.ok(!client.statements.includes('COMMIT'))
    assert.deepEqual(client.releases, [false])
    await store.close()
  })

  test(`PostgresStore ${mode} continues the queue after a failed write`, async () => {
    const clients = [clientDouble(), clientDouble()]
    let connections = 0
    const store = await storeDouble(async () => clients[connections++]!)
    const started = deferred()
    const unblock = deferred()
    const original = new Error('first write failed')
    const order: string[] = []
    const first = write(store, async () => {
      order.push('first started')
      started.resolve()
      await unblock.promise
      order.push('first failed')
      throw original
    })
    const rejected = assert.rejects(first, error => error === original)
    const second = write(store, () => { order.push('second completed'); return 42 })
    try {
      await started.promise
      assert.equal(connections, 1, 'The second queued write must not acquire a connection yet')
      unblock.resolve()
      await rejected
      assert.equal(await second, 42)
      assert.deepEqual(order, ['first started', 'first failed', 'second completed'])
      assert.equal(connections, 2)
      assert.ok(clients[0]!.statements.includes('ROLLBACK'))
      assert.ok(clients[1]!.statements.includes('COMMIT'))
      assert.deepEqual(clients.map(client => client.releases), [[false], [false]])
    } finally {
      unblock.resolve()
      await Promise.allSettled([first, second])
      await store.close()
    }
  })

  test(`PostgresStore ${mode} destroys a client when rollback fails`, async () => {
    const client = clientDouble(new Error('rollback connection failure'))
    const store = await storeDouble(async () => client)
    const original = new Error('original transaction failure')
    await assert.rejects(write(store, () => { throw original }), error => error === original)
    assert.deepEqual(client.releases, [true], 'A broken connection must be destroyed, not returned to the pool')
    assert.ok(!client.statements.includes('COMMIT'))
    await store.close()
  })

  test(`PostgresStore ${mode} recovers its queue after connection acquisition fails`, async () => {
    const client = clientDouble()
    const original = new Error('connect failed')
    let connections = 0
    const store = await storeDouble(async () => {
      if (++connections === 1) throw original
      return client
    })
    const failed = assert.rejects(write(store, () => assert.fail('No transaction without a client')), error => error === original)
    const next = write(store, () => 'recovered')
    await failed
    assert.equal(await next, 'recovered')
    assert.equal(connections, 2)
    assert.deepEqual(client.releases, [false])
    await store.close()
  })
}
