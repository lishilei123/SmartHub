import { copyFile, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { extname, isAbsolute, relative, resolve, sep } from 'node:path'

export class RawDocumentStore {
  constructor(private readonly root: string) {}

  async save(knowledgeBaseId: string, logicalPath: string, assetVersionId: string, content: string) {
    const staged = await this.saveSnapshot(knowledgeBaseId, logicalPath, assetVersionId, content)
    await this.activateSnapshot(knowledgeBaseId, logicalPath, assetVersionId)
    return staged
  }

  async saveSnapshot(knowledgeBaseId: string, logicalPath: string, assetVersionId: string, content: string) {
    const normalized = logicalPath.replaceAll('\\', '/').replace(/^\/+/, '')
    if (!normalized || isAbsolute(logicalPath) || normalized.split('/').some(part => part === '..' || !part)) throw new Error('逻辑路径不合法')
    const extension = extname(normalized).toLowerCase()
    if (!['.md', '.txt'].includes(extension)) throw new Error('仅支持 .md 与 .txt 文件')
    const knowledgeRoot = resolve(this.root, knowledgeBaseId)
    const activePath = resolve(knowledgeRoot, 'files', ...normalized.split('/'))
    const snapshotPath = resolve(knowledgeRoot, 'versions', assetVersionId, `source${extension}`)
    for (const candidate of [activePath, snapshotPath]) if (!(candidate === knowledgeRoot || candidate.startsWith(`${knowledgeRoot}${sep}`))) throw new Error('逻辑路径越过知识库默认目录')
    await mkdir(resolve(snapshotPath, '..'), { recursive: true })
    await writeFile(snapshotPath, content, { encoding: 'utf8' })
    return { storagePath: relative(this.root, activePath).replaceAll('\\', '/'), snapshotPath: relative(this.root, snapshotPath).replaceAll('\\', '/') }
  }

  async activateSnapshot(knowledgeBaseId: string, logicalPath: string, assetVersionId: string) {
    const extension = extname(logicalPath).toLowerCase()
    const activePath = this.activePath(knowledgeBaseId, logicalPath)
    const snapshotPath = resolve(this.root, knowledgeBaseId, 'versions', assetVersionId, `source${extension}`)
    const temporary = `${activePath}.${assetVersionId}.tmp`
    await mkdir(resolve(activePath, '..'), { recursive: true })
    await copyFile(snapshotPath, temporary)
    await rename(temporary, activePath)
  }

  async moveActive(knowledgeBaseId: string, oldLogicalPath: string, newLogicalPath: string) {
    const oldPath = this.activePath(knowledgeBaseId, oldLogicalPath)
    const newPath = this.activePath(knowledgeBaseId, newLogicalPath)
    await mkdir(resolve(newPath, '..'), { recursive: true })
    try { await rename(oldPath, newPath) } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
    return relative(this.root, newPath).replaceAll('\\', '/')
  }

  async deleteActive(knowledgeBaseId: string, logicalPath: string) {
    await rm(this.activePath(knowledgeBaseId, logicalPath), { force: true })
  }

  async deleteActiveDirectory(knowledgeBaseId: string, logicalPrefix: string) {
    const normalized = logicalPrefix.replaceAll('\\', '/').replace(/^\/+|\/+$/g, '')
    if (!normalized || normalized.split('/').some(part => !part || part === '.' || part === '..')) throw new Error('目录路径不合法')
    const knowledgeRoot = resolve(this.root, knowledgeBaseId)
    const target = resolve(knowledgeRoot, 'files', ...normalized.split('/'))
    if (!target.startsWith(`${knowledgeRoot}${sep}`)) throw new Error('目录路径越过知识库默认目录')
    await rm(target, { recursive: true, force: true })
  }

  async saveAttachment(knowledgeBaseId: string, logicalPath: string, content: Buffer) {
    const extension = extname(logicalPath).toLowerCase()
    if (!['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg'].includes(extension)) throw new Error(`不支持的附件类型：${extension || '无扩展名'}`)
    const target = this.activePath(knowledgeBaseId, logicalPath)
    await mkdir(resolve(target, '..'), { recursive: true })
    await writeFile(target, content)
  }

  async readAttachment(knowledgeBaseId: string, logicalPath: string) {
    return readFile(this.activePath(knowledgeBaseId, logicalPath))
  }

  private activePath(knowledgeBaseId: string, logicalPath: string) {
    const normalized = logicalPath.replaceAll('\\', '/').replace(/^\/+/, '')
    if (!normalized || isAbsolute(logicalPath) || normalized.split('/').some(part => part === '..' || !part)) throw new Error('逻辑路径不合法')
    const knowledgeRoot = resolve(this.root, knowledgeBaseId)
    const candidate = resolve(knowledgeRoot, 'files', ...normalized.split('/'))
    if (!candidate.startsWith(`${knowledgeRoot}${sep}`)) throw new Error('逻辑路径越过知识库默认目录')
    return candidate
  }
}
