import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, join, resolve, sep } from 'node:path'
import JSZip from 'jszip'
import type { SkillPackageMetadata } from '../domain/types.js'

export const MAX_SKILL_ARCHIVE_BYTES = 20 * 1024 * 1024
const MAX_SKILL_FILES = 200
const MAX_SKILL_FILE_BYTES = 5 * 1024 * 1024
const MAX_SKILL_UNPACKED_BYTES = 50 * 1024 * 1024

export class SkillPackageStore {
  private readonly root: string

  constructor(root: string) { this.root = resolve(root) }

  async install(input: { key: string; version: string; fileName: string; archive: Buffer }): Promise<{ entrypoint: string; package: SkillPackageMetadata }> {
    if (!input.fileName.toLocaleLowerCase().endsWith('.zip')) throw new Error('Skill 包必须是 ZIP 文件')
    if (!input.archive.length) throw new Error('Skill ZIP 不能为空')
    if (input.archive.length > MAX_SKILL_ARCHIVE_BYTES) throw new Error('Skill ZIP 不能超过 20 MB')
    const key = safeIdentity(input.key, 'Skill 标识')
    const version = safeVersion(input.version)
    let zip: JSZip
    try { zip = await JSZip.loadAsync(input.archive, { checkCRC32: true, createFolders: false }) }
    catch { throw new Error('Skill ZIP 无法解析或 CRC 校验失败') }

    const entries: Array<{ path: string; data: Buffer }> = []
    const seen = new Set<string>()
    let declaredBytes = 0
    for (const entry of Object.values(zip.files)) {
      const originalName = String((entry as JSZip.JSZipObject & { unsafeOriginalName?: string }).unsafeOriginalName ?? entry.name)
      const path = safeArchivePath(originalName)
      if (entry.dir) continue
      if (path.startsWith('__MACOSX/')) continue
      if (isSymlink(entry)) throw new Error(`Skill ZIP 不允许符号链接：${path}`)
      if (/\.(?:exe|dll|com|scr|msi)$/iu.test(path)) throw new Error(`Skill ZIP 不允许原生可执行文件：${path}`)
      const collisionKey = path.toLocaleLowerCase()
      if (seen.has(collisionKey)) throw new Error(`Skill ZIP 存在大小写冲突或重复路径：${path}`)
      seen.add(collisionKey)
      const declaredSize = Number((entry as unknown as { _data?: { uncompressedSize?: number } })._data?.uncompressedSize ?? 0)
      if (!Number.isSafeInteger(declaredSize) || declaredSize < 0 || declaredSize > MAX_SKILL_FILE_BYTES) throw new Error(`Skill 文件超过 5 MB：${path}`)
      declaredBytes += declaredSize
      if (declaredBytes > MAX_SKILL_UNPACKED_BYTES) throw new Error('Skill ZIP 解压后不能超过 50 MB')
      if (entries.length >= MAX_SKILL_FILES) throw new Error('Skill ZIP 文件数不能超过 200')
      const data = Buffer.from(await entry.async('uint8array'))
      if (data.length > MAX_SKILL_FILE_BYTES) throw new Error(`Skill 文件超过 5 MB：${path}`)
      entries.push({ path, data })
    }
    if (!entries.length) throw new Error('Skill ZIP 中没有文件')
    const entrypoints = entries.filter(entry => basename(entry.path).toLocaleLowerCase() === 'skill.md')
    if (entrypoints.length !== 1) throw new Error(`Skill ZIP 必须且只能包含一个 SKILL.md，当前找到 ${entrypoints.length} 个`)
    try {
      const content = new TextDecoder('utf-8', { fatal: true }).decode(entrypoints[0].data)
      if (!content.trim()) throw new Error('empty')
    } catch { throw new Error('SKILL.md 必须是非空 UTF-8 文本') }

    const unpackedBytes = entries.reduce((sum, entry) => sum + entry.data.length, 0)
    if (unpackedBytes > MAX_SKILL_UNPACKED_BYTES) throw new Error('Skill ZIP 解压后不能超过 50 MB')
    const files = entries.map(entry => entry.path).sort((left, right) => left.localeCompare(right, 'en'))
    const contentHash = createHash('sha256')
    for (const path of files) {
      const entry = entries.find(item => item.path === path)!
      contentHash.update(JSON.stringify([path, entry.data.length, createHash('sha256').update(entry.data).digest('hex')]))
    }
    const storageKey = `${key}/${version}`
    const target = this.resolveStorageKey(storageKey)
    await mkdir(this.root, { recursive: true })
    if (await exists(target)) throw new Error(`Skill ${key}@${version} 的包目录已存在`)
    let staging = await mkdtemp(join(this.root, '.skill-install-'))
    try {
      for (const entry of entries) {
        const destination = resolve(staging, ...entry.path.split('/'))
        assertInside(staging, destination)
        await mkdir(dirname(destination), { recursive: true })
        await writeFile(destination, entry.data)
      }
      await mkdir(dirname(target), { recursive: true })
      await rename(staging, target)
      staging = ''
    } finally {
      if (staging) await rm(staging, { recursive: true, force: true })
    }
    const metadata: SkillPackageMetadata = {
      storageKey,
      entrypointPath: entrypoints[0].path,
      uploadedFileName: safeFileName(input.fileName),
      archiveSha256: createHash('sha256').update(input.archive).digest('hex'),
      contentSha256: contentHash.digest('hex'),
      fileCount: entries.length,
      unpackedBytes,
      files,
    }
    return { entrypoint: `skill-package://${storageKey}/${metadata.entrypointPath}`, package: metadata }
  }

  async read(storageKey: string, relativePath: string) {
    const root = this.resolveStorageKey(storageKey)
    const path = safeArchivePath(relativePath)
    const target = resolve(root, ...path.split('/'))
    assertInside(root, target)
    return readFile(target)
  }

  async remove(storageKey: string) {
    const target = this.resolveStorageKey(storageKey)
    await rm(target, { recursive: true, force: true })
    await rm(dirname(target), { recursive: false }).catch(() => undefined)
  }

  private resolveStorageKey(storageKey: string) {
    const parts = storageKey.split('/')
    if (parts.length !== 2) throw new Error('Skill 包存储标识无效')
    const target = resolve(this.root, safeIdentity(parts[0], 'Skill 标识'), safeVersion(parts[1]))
    assertInside(this.root, target)
    return target
  }
}

function safeArchivePath(value: string) {
  const normalized = value.replaceAll('\\', '/')
  if (!normalized || normalized.startsWith('/') || /^[A-Za-z]:/u.test(normalized) || normalized.includes('\0') || normalized.length > 500) throw new Error(`Skill ZIP 路径不安全：${value}`)
  const parts = normalized.replace(/\/$/u, '').split('/')
  if (parts.some(part => !part || part === '.' || part === '..' || part.length > 120 || /[<>:"|?*\u0000-\u001f]/u.test(part) || /[. ]$/u.test(part) || windowsReserved(part))) throw new Error(`Skill ZIP 路径不安全：${value}`)
  return parts.join('/')
}

function safeIdentity(value: string, label: string) {
  const result = String(value ?? '').trim()
  if (!/^[a-z0-9][a-z0-9._-]{0,99}$/u.test(result)) throw new Error(`${label}格式无效`)
  return result
}
function safeVersion(value: string) {
  const result = String(value ?? '').trim()
  if (!/^[0-9A-Za-z][0-9A-Za-z._+-]{0,49}$/u.test(result)) throw new Error('Skill 版本格式无效')
  return result
}
function safeFileName(value: string) { const result = basename(String(value ?? '').replaceAll('\\', '/')); return result.slice(0, 200) || 'skill.zip' }
function windowsReserved(segment: string) { return /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/iu.test(segment) }
function isSymlink(entry: JSZip.JSZipObject) {
  const raw = typeof entry.unixPermissions === 'string' ? Number.parseInt(entry.unixPermissions, 8) : entry.unixPermissions
  return typeof raw === 'number' && (raw & 0o170000) === 0o120000
}
function assertInside(root: string, target: string) { const base = resolve(root); if (target !== base && !target.startsWith(`${base}${sep}`)) throw new Error('Skill 包路径超出受控目录') }
async function exists(path: string) { try { await stat(path); return true } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error } }
