import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { KnowledgeService } from './application/knowledge-service.js'
import { LocalModelRuntime } from './infrastructure/local-model-runtime.js'
import { PostgresStore } from './infrastructure/postgres-store.js'
import { RawDocumentStore } from './infrastructure/raw-document-store.js'
import { JsonStore, type StateStore } from './infrastructure/store.js'

const envFile = resolve(fileURLToPath(new URL('../.env.local', import.meta.url)))
if (existsSync(envFile)) process.loadEnvFile(envFile)

const dataFile = process.env.SMARTHUB_DATA_FILE ?? resolve(fileURLToPath(new URL('../data/smarthub.json', import.meta.url)))
const documentRoot = process.env.SMARTHUB_DOCUMENT_ROOT ?? resolve(fileURLToPath(new URL('../data/knowledge-bases', import.meta.url)))
const modelRoot = process.env.SMARTHUB_MODEL_ROOT ?? resolve(fileURLToPath(new URL('../data/models', import.meta.url)))
const production = process.env.NODE_ENV === 'production'
const databaseUrl = process.env.SMARTHUB_FORCE_JSON_STORE === 'true' ? undefined : process.env.DATABASE_URL

if (production && !databaseUrl) throw new Error('生产模式必须配置 DATABASE_URL')

export const localModelRuntime = new LocalModelRuntime(modelRoot)
export const stateStore: StateStore = databaseUrl ? new PostgresStore(databaseUrl) : new JsonStore(dataFile)
export const rawDocumentStore = new RawDocumentStore(documentRoot)
export const service = new KnowledgeService(stateStore, rawDocumentStore, localModelRuntime)
export const usingPostgres = stateStore instanceof PostgresStore
