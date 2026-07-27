import { service, stateStore } from '../runtime.js'

try {
  await service.initialize()
  const result = await service.purgeDeletedAssetData()
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
} finally {
  await stateStore.close?.()
}
