import { dirname, extname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const moduleRoot = resolve(fileURLToPath(new URL('../../', import.meta.url)))
const inferredApplicationRoot = moduleRoot.endsWith('dist-server') ? dirname(moduleRoot) : moduleRoot

export const applicationRoot = resolve(process.env.SMARTHUB_APP_ROOT ?? inferredApplicationRoot)
export const codeRoot = moduleRoot
export const dataRoot = resolve(process.env.SMARTHUB_DATA_ROOT ?? resolve(applicationRoot, 'data'))

export function deployedModuleCandidates(sourcePath: string) {
  const normalized = sourcePath.replaceAll('\\', '/')
  const sourceCandidate = resolve(applicationRoot, ...normalized.split('/'))
  const compiledPath = /\.(?:ts|tsx)$/iu.test(normalized) ? normalized.replace(/\.(?:ts|tsx)$/iu, '.js') : normalized
  const compiledCandidate = resolve(codeRoot, ...compiledPath.split('/'))
  const directCodeCandidate = resolve(codeRoot, ...normalized.split('/'))
  const preferCompiled = extname(fileURLToPath(import.meta.url)).toLocaleLowerCase() === '.js'
  return [...new Set(preferCompiled
    ? [compiledCandidate, directCodeCandidate, sourceCandidate]
    : [sourceCandidate, directCodeCandidate, compiledCandidate])]
}

export function moduleUrl(path: string) { return pathToFileURL(path).href }
