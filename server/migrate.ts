import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runMigrations } from './infrastructure/migrations.js'

const envFile = resolve(fileURLToPath(new URL('../.env.local', import.meta.url)))
if (existsSync(envFile)) process.loadEnvFile(envFile)

const connectionString = process.env.DATABASE_URL
if (!connectionString) throw new Error('执行迁移必须配置 DATABASE_URL')

await runMigrations(connectionString)
console.log('SmartHub 数据库迁移完成')
