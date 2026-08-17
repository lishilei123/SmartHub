const versionDocumentRoot = '版本文档'
const workspaceRoot = 'workspace'

export const requirementAnalysisInputTypes = [
  { value: 'requirement', label: '需求文档', assetType: 'requirement', directoryName: 'requirements' },
  { value: 'product_prototype', label: '产品原型', assetType: 'product_prototype', directoryName: 'ui' },
] as const

export type RequirementAnalysisInputType = typeof requirementAnalysisInputTypes[number]['value']

function safeLogicalPathSegment(value: string, label: string) {
  const encodeCharacter = (character: string) => `%${character.codePointAt(0)!.toString(16).toUpperCase().padStart(2, '0')}`
  const normalized = value.normalize('NFC').trim()
  const fallback = label === '项目版本名称' ? '未命名版本' : '未命名'
  const source = normalized || fallback
  let safe = source
    .replace(/[%<>:"/\\|?*\u0000-\u001F]/gu, encodeCharacter)
    .replace(/[. ]+$/gu, characters => [...characters].map(encodeCharacter).join(''))
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(source)) safe = `${encodeCharacter(source[0])}${safe.slice(1)}`
  return safe
}

export function versionDocumentDirectory(versionName: string, documentDirectory: string) {
  return [
    versionDocumentRoot,
    safeLogicalPathSegment(versionName, '项目版本名称'),
    safeLogicalPathSegment(documentDirectory, '文档目录名称'),
  ].join('/')
}

export function versionDocumentPath(versionName: string, documentDirectory: string, fileName: string) {
  return `${versionDocumentDirectory(versionName, documentDirectory)}/${safeLogicalPathSegment(fileName, '文件名')}`
}

export function requirementAnalysisInputDirectory(versionName: string, inputType: RequirementAnalysisInputType) {
  const input = requirementAnalysisInputTypes.find(item => item.value === inputType)
  if (!input) throw new Error('需求分析输入类型不合法')
  return `${workspaceRoot}/branches/${safeLogicalPathSegment(versionName, '项目版本名称')}/input/${input.directoryName}`
}

export function requirementWorkspaceDirectory(versionName: string) {
  return requirementAnalysisInputDirectory(versionName, 'requirement')
}

export function productPrototypeWorkspaceDirectory(versionName: string) {
  return requirementAnalysisInputDirectory(versionName, 'product_prototype')
}

export function requirementAnalysisInputTypeForDocument(versionName: string, logicalPath: string, assetType?: string) {
  const normalizedPath = logicalPath.replaceAll('\\', '/').replace(/^\/+|\/+$/gu, '')
  const input = requirementAnalysisInputTypes.find(candidate => normalizedPath.startsWith(`${requirementAnalysisInputDirectory(versionName, candidate.value)}/`))
  if (input?.value === 'product_prototype' && assetType !== input.assetType) return undefined
  return input
}

export function documentPathInDirectory(directoryPath: string, fileName: string) {
  const normalizedDirectory = directoryPath.replaceAll('\\', '/').replace(/^\/+|\/+$/gu, '')
  if (!normalizedDirectory || normalizedDirectory.split('/').some(segment => !segment || segment === '.' || segment === '..')) throw new Error('知识库目录路径不合法')
  return `${normalizedDirectory}/${safeLogicalPathSegment(fileName, '文件名')}`
}
