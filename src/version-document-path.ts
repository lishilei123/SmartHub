const versionDocumentRoot = '版本文档'

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
