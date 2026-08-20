import { createHash } from 'node:crypto'
import type { RequirementReleaseArtifact } from '../domain/requirement-workflow-types.js'
import type { DatabaseState, ReviewRun } from '../domain/types.js'

export function buildRequirementReleaseArtifacts(input: {
  state: DatabaseState
  releaseId: string
  verificationRun: ReviewRun
  refinedRequirementsMarkdown: string
  generatedAt: string
}): { artifacts: RequirementReleaseArtifact[]; contentSha256: string } {
  const { state, releaseId, verificationRun, refinedRequirementsMarkdown, generatedAt } = input
  const result = required(verificationRun.result, '复验结果不存在')
  const sourceAssets = verificationRun.snapshot.assets.map(reference => {
    const version = required(state.versions.find(item => item.id === reference.assetVersionId), `固定需求版本不存在：${reference.assetVersionId}`)
    const asset = required(state.assets.find(item => item.id === reference.assetId), `固定需求资产不存在：${reference.assetId}`)
    if (version.contentHash !== reference.assetContentHash) throw new Error(`固定需求版本 Hash 漂移：${reference.assetVersionId}`)
    return { reference, version, asset }
  })
  const evidenceById = new Map(result.evidence.map(item => [item.clientEvidenceId, item]))
  const testFocusByRequirement = new Map<string, string[]>()
  result.testFocus.forEach(item => item.requirementPointRefs.forEach(reference => testFocusByRequirement.set(reference, [...(testFocusByRequirement.get(reference) ?? []), item.id])))
  const clarificationByRequirement = new Map<string, string[]>()
  result.clarifications.forEach(item => item.requirementPointRefs.forEach(reference => clarificationByRequirement.set(reference, [...(clarificationByRequirement.get(reference) ?? []), item.id])))

  const artifacts: RequirementReleaseArtifact[] = []
  for (const item of sourceAssets) {
    artifacts.push(artifact(`修复后的需求原文/${safeArtifactPath(item.reference.logicalPath, item.asset.displayName)}`, item.asset.displayName.toLocaleLowerCase().endsWith('.txt') ? 'text/plain' : 'text/markdown', item.version.content))
  }
  artifacts.push(artifact('refined-requirements.md', 'text/markdown', refinedRequirementsMarkdown.trim()))
  artifacts.push(artifact('requirement-baseline.md', 'text/markdown', artifactContent(result.artifacts, 'requirement-baseline.md')))
  artifacts.push(artifact('requirements.json', 'application/json', json({
    schemaVersion: 'requirements/v1',
    releaseId,
    projectVersionId: verificationRun.projectVersionId,
    verificationRunId: verificationRun.id,
    sourceAssetVersions: sourceAssets.map(item => ({ assetId: item.reference.assetId, assetVersionId: item.reference.assetVersionId, contentSha256: item.reference.assetContentHash, logicalPath: item.reference.logicalPath, displayName: item.reference.displayName })),
    requirements: result.requirementPoints,
    evidence: result.evidence,
    formalClarifications: result.clarifications.filter(item => item.status === 'answered'),
    clarificationDispositionRecords: result.clarifications.filter(item => item.status === 'dismissed'),
    generatedAt,
  })))
  artifacts.push(artifact('requirement-analysis-closure.md', 'text/markdown', renderClosure(verificationRun)))
  artifacts.push(artifact('requirement-analysis-report.md', 'text/markdown', artifactContent(result.artifacts, 'requirement-analysis.md')))
  artifacts.push(artifact('clarifications.json', 'application/json', json({
    schemaVersion: 'planning-clarifications/v1',
    releaseId,
    verificationRunId: verificationRun.id,
    clarifications: result.clarifications,
    generatedAt,
  })))
  artifacts.push(artifact('test-focus.md', 'text/markdown', renderTestFocus(result.testFocus)))
  artifacts.push(artifact('test-focus.json', 'application/json', json({ schemaVersion: 'requirement-test-focus/v1', releaseId, verificationRunId: verificationRun.id, testFocus: result.testFocus, generatedAt })))
  artifacts.push(artifact('traceability.json', 'application/json', json({
    schemaVersion: 'requirement-traceability/v1',
    releaseId,
    verificationRunId: verificationRun.id,
    links: result.requirementPoints.map(point => ({
      requirementId: point.clientRequirementPointId,
      evidenceIds: point.evidenceRefs,
      sourceAssetVersionIds: [...new Set(point.evidenceRefs.map(id => evidenceById.get(id)?.sourceRef.assetVersionId).filter((id): id is string => Boolean(id)))],
      clarificationIds: clarificationByRequirement.get(point.clientRequirementPointId) ?? [],
      testFocusIds: testFocusByRequirement.get(point.clientRequirementPointId) ?? [],
    })),
    generatedAt,
  })))

  const manifest = {
    schemaVersion: 'requirement-release-manifest/v1',
    releaseId,
    projectVersionId: verificationRun.projectVersionId,
    verificationRunId: verificationRun.id,
    sourceAssetVersions: sourceAssets.map(item => ({ assetId: item.reference.assetId, assetVersionId: item.reference.assetVersionId, contentSha256: item.reference.assetContentHash, logicalPath: item.reference.logicalPath })),
    artifacts: artifacts.map(item => ({ fileName: item.fileName, mediaType: item.mediaType, contentSha256: item.contentSha256, bytes: Buffer.byteLength(item.content, 'utf8') })),
    machineReadableEntryPoints: {
      requirements: 'requirements.json',
      clarifications: 'clarifications.json',
      testFocus: 'test-focus.json',
      traceability: 'traceability.json',
    },
    generatedAt,
  }
  const manifestContent = json(manifest)
  artifacts.push(artifact('manifest.json', 'application/json', manifestContent))
  return { artifacts, contentSha256: sha256(manifestContent) }
}

function renderClosure(verificationRun: ReviewRun) {
  return [
    '# Requirement Analysis Closure', '',
    `- Verification Run：${verificationRun.id}`,
    `- Overall Assessment：${verificationRun.result?.summary.overallAssessment ?? 'unknown'}`,
  ].join('\n')
}

function renderTestFocus(items: NonNullable<ReviewRun['result']>['testFocus']) {
  return ['# Test Focus', '', ...(items.length ? items.flatMap(item => [`## ${safe(item.id)} · ${safe(item.title)}`, '', safe(item.description), '', `- Requirement Points：${item.requirementPointRefs.join('、') || '整体'}`, '']) : ['无单独测试关注项。', ''])].join('\n')
}

function artifactContent(artifacts: NonNullable<ReviewRun['result']>['artifacts'], fileName: string) {
  return required(artifacts.find(item => item.fileName === fileName), `分析产物不存在：${fileName}`).content
}

function safeArtifactPath(logicalPath: string, displayName: string) {
  const normalized = logicalPath.replaceAll('\\', '/').replace(/^\/+|\/+$/gu, '')
  const marker = '/input/requirements/'
  const relative = normalized.includes(marker) ? normalized.slice(normalized.indexOf(marker) + marker.length) : normalized.split('/').at(-1) || displayName || 'requirement.md'
  return relative.split('/').filter(segment => segment && segment !== '.' && segment !== '..').map(segment => segment.replace(/[<>:"\\|?*\u0000-\u001F]/gu, '_')).join('/') || 'requirement.md'
}

function artifact(fileName: string, mediaType: RequirementReleaseArtifact['mediaType'], content: string): RequirementReleaseArtifact {
  return { fileName, mediaType, content, contentSha256: sha256(content) }
}

function json(value: unknown) { return `${JSON.stringify(value, null, 2)}\n` }
function sha256(value: string) { return createHash('sha256').update(value).digest('hex') }
function safe(value: string) { return value.replace(/[<>]/gu, character => character === '<' ? '&lt;' : '&gt;').trim() }
function required<T>(value: T | undefined | null, message: string): T { if (value == null) throw new Error(message); return value }
