import type { RequirementReleaseContent } from '../../domain/requirement-workflow-types.js'
import type { DatabaseState, ProjectVersion, ReviewRun } from '../../domain/types.js'
import {
  activeRequirementReleaseBinding,
  requirementReleaseBindings,
} from '../../domain/requirement-release-bindings.js'
import type {
  CreateTestDesignInput,
  HistoricalCaseSnapshot,
  RetrievalSnapshot,
  TestCaseLibraryVersion,
  TestDesign,
  TestDesignBasisSnapshot,
  TestDesignWorkspaceFile,
  TestDesignWorkspaceSnapshot,
  TestDesignState,
} from '../../domain/test-design-types.js'
import { canonicalJson, canonicalSha256 } from '../canonical-json.js'
import { TestDesignError } from '../test-design-validation.js'
import { classifyWorkspaceSourceScope } from '../project-workspace-snapshot.js'
import {
  required,
  readDesignState,
  safeWorkspaceSegment,
  isWithinWorkspace,
  normalizeWorkspacePath,
  canonicalSha256Text,
} from './state.js'
import { testCaseSemanticSha256 } from './case-review.js'
import { assertFixedTraceability } from './library.js'

export const TEST_DESIGN_RUNTIME_KNOWLEDGE_REFERENCE_LIMIT = 16

export function buildBasisSnapshot(
  design: TestDesign,
  requirement: BoundRequirementRelease,
  createdAt: string,
): TestDesignBasisSnapshot {
  const base = {
    schemaVersion: 'test-design-basis-snapshot/v3' as const,
    projectVersionId: design.projectVersionId,
    requirementReleaseId: requirement.release.id,
    verificationRunId: requirement.analysisRun.id,
    requirementReleaseContentSha256: requirement.release.contentSha256,
    content: structuredClone(requirement.release.content),
    createdAt,
  }
  return { ...base, snapshotSha256: canonicalSha256(base) }
}

export async function buildRetrievalSnapshot(
  state: DatabaseState,
  design: TestDesign,
  requirementContent: RequirementReleaseContent,
  createdAt: string,
): Promise<RetrievalSnapshot> {
  const augmentation = design.input.knowledgeAugmentation
  const index =
    augmentation.mode === 'fixed_index'
      ? required(
          state.indexes.find(item => item.id === augmentation.indexVersionId && item.status === 'active'),
          'TEST_DESIGN_AUGMENTATION_INVALID',
          '固定索引不存在或未激活',
        )
      : undefined
  const assetVersionIds =
    augmentation.mode === 'selected_assets' ? augmentation.assetVersionIds : (index?.assetVersionIds ?? [])
  assetVersionIds.forEach(id => assetContentRef(state, design.projectId, id, 'knowledge_asset'))
  const queryPlan =
    augmentation.mode === 'disabled' ? [] : buildTestDesignRetrievalQueries(design.input, requirementContent)
  const candidates =
    augmentation.mode === 'disabled'
      ? []
      : assetVersionIds.flatMap(id =>
          retrievalCandidates(
            state,
            design.projectId,
            id,
            augmentation.mode === 'fixed_index' ? augmentation.filters : undefined,
          ),
        )
  const ranked = new Map<string, RetrievalSnapshot['hits'][number]>()
  for (const [queryIndex, plan] of queryPlan.entries()) {
    const tokens = searchTokens(plan.query)
    candidates
      .map(candidate => ({ candidate, score: retrievalScore(tokens, candidate.content) }))
      .filter(item => item.score > 0)
      .sort((left, right) => right.score - left.score || left.candidate.id.localeCompare(right.candidate.id))
      .slice(0, 8)
      .forEach(({ candidate, score }, rank) => {
        const current = ranked.get(candidate.id)
        const hit = {
          id: `retrieval_hit_${canonicalSha256(`${candidate.id}:${queryIndex}`).slice(0, 20)}`,
          assetVersionId: candidate.assetVersionId,
          chunkId: candidate.chunkId,
          contentSha256: canonicalSha256(candidate.content),
          score,
          rank: rank + 1,
          locator: candidate.locator,
          classification: candidate.classification,
          content: candidate.content,
        }
        if (!current || score > current.score) ranked.set(candidate.id, hit)
      })
  }
  const hits = [...ranked.values()]
    .sort((left, right) => right.score - left.score || left.id.localeCompare(right.id))
    .slice(0, 80)
    .map((hit, index) => ({ ...hit, rank: index + 1 }))
  const base = {
    canonicalVersion: 'retrieval-snapshot/v1' as const,
    mode: augmentation.mode,
    assetVersionIds,
    ...(index
      ? {
          indexVersionId: index.id,
          ...(augmentation.mode === 'fixed_index' && augmentation.filters ? { filters: augmentation.filters } : {}),
        }
      : {}),
    queryPlan,
    hits,
    createdAt,
  }
  return { ...base, snapshotSha256: canonicalSha256(base) }
}

export function buildHistoricalSnapshot(
  state: DatabaseState,
  design: TestDesign,
  currentBasis: TestDesignBasisSnapshot,
  createdAt: string,
): HistoricalCaseSnapshot {
  const aggregate = readDesignState(state)
  const projectVersion = required(
    state.projectVersions.find(item => item.id === design.projectVersionId),
    'PROJECT_VERSION_NOT_FOUND',
    '项目版本不存在',
  )
  const inheritedSource = explicitlyInheritedSourceVersion(state, projectVersion)
  const libraryVersion = inheritedSource
    ? latestPublishedLibraryVersion(inheritedLibraryVersionsForSource(aggregate, inheritedSource.id))
    : undefined
  const sourceRun = libraryVersion?.sourceRunId
    ? required(
        aggregate.runs.find(
          item => item.id === libraryVersion.sourceRunId && item.projectVersionId === inheritedSource?.id,
        ),
        'TEST_DESIGN_HISTORICAL_SOURCE_INVALID',
        '来源版本正式用例库缺少固定的 TestDesign Run',
      )
    : undefined
  if (
    sourceRun &&
    canonicalSha256(sourceRun.basisSnapshot.content) !== sourceRun.basisSnapshot.requirementReleaseContentSha256
  )
    throw new TestDesignError(
      'TEST_DESIGN_HISTORICAL_SOURCE_INVALID',
      '来源版本 Requirement Release 内容或 Hash 已损坏',
      409,
      { sourceRunId: sourceRun.id, requirementReleaseId: sourceRun.basisSnapshot.requirementReleaseId },
    )
  const mappings = sourceRun
    ? mapRequirementsAcrossReleases(sourceRun.basisSnapshot.content.requirements, currentBasis.content.requirements)
    : []
  const sourceRequirementIds = new Set(
    sourceRun?.basisSnapshot.content.requirements.map(item => item.clientRequirementPointId.trim()) ?? [],
  )
  const items: HistoricalCaseSnapshot['items'] = []
  for (const member of libraryVersion?.members ?? []) {
    const sourceCase = required(
      aggregate.libraryCases.find(item => item.id === member.caseId && item.projectId === design.projectId),
      'TEST_DESIGN_HISTORICAL_SOURCE_INVALID',
      '正式历史用例不存在',
    )
    const revision = required(
      sourceCase.revisions.find(item => item.revision === member.revision),
      'TEST_DESIGN_HISTORICAL_SOURCE_INVALID',
      '正式历史用例 Revision 不存在',
    )
    const content = required(
      member.frozenContent,
      'TEST_DESIGN_HISTORICAL_SOURCE_INVALID',
      '来源版本正式用例库成员缺少冻结 TestCase 内容',
    )
    if (
      member.contentSha256 !== revision.contentSha256 ||
      canonicalSha256(content) !== member.contentSha256 ||
      testCaseSemanticSha256(content) !== revision.semanticSha256
    )
      throw new TestDesignError(
        'TEST_DESIGN_HISTORICAL_SOURCE_INVALID',
        '来源版本正式用例库成员内容或 Hash 已损坏',
        409,
        { libraryVersionId: libraryVersion!.id, caseId: member.caseId, revision: member.revision },
      )
    const traceability = required(
      member.traceability,
      'TEST_DESIGN_HISTORICAL_SOURCE_INVALID',
      '来源版本正式用例库成员缺少 Requirement Release 追溯',
    )
    assertFixedTraceability(traceability)
    if (traceability.sourceRequirementReleaseId !== sourceRun?.basisSnapshot.requirementReleaseId)
      throw new TestDesignError(
        'TEST_DESIGN_HISTORICAL_SOURCE_INVALID',
        '来源版本用例库成员追溯与其固定 Requirement Release 不一致',
        409,
        {
          libraryVersionId: libraryVersion!.id,
          caseId: member.caseId,
          expectedRequirementReleaseId: sourceRun?.basisSnapshot.requirementReleaseId,
          actualRequirementReleaseId: traceability.sourceRequirementReleaseId,
        },
      )
    const sourceRequirementRefs = traceability.requirementRefs.map(item => item.requirementId)
    if (sourceRequirementRefs.some(requirementId => !sourceRequirementIds.has(requirementId)))
      throw new TestDesignError(
        'TEST_DESIGN_HISTORICAL_SOURCE_INVALID',
        '来源版本用例库成员引用了固定 Requirement Release 之外的 Requirement',
        409,
        { libraryVersionId: libraryVersion!.id, caseId: member.caseId, sourceRequirementRefs },
      )
    items.push({
      id: `history_${libraryVersion!.id}_${sourceCase.id}_${revision.revision}`,
      kind: 'test_case_library',
      sourceId: `${libraryVersion!.id}:${sourceCase.id}:${revision.revision}`,
      contentSha256: member.contentSha256,
      semanticSha256: revision.semanticSha256,
      content: structuredClone(content),
      sourceRequirementReleaseId: traceability.sourceRequirementReleaseId,
      sourceRequirementRefs,
      locator: {
        sourceProjectVersionId: inheritedSource!.id,
        testCaseLibraryVersionId: libraryVersion!.id,
        caseId: sourceCase.id,
        revision: revision.revision,
        status: sourceCase.status,
      },
    })
  }
  const base = {
    schemaVersion: 'historical-case-snapshot/v2' as const,
    items,
    ...(inheritedSource ? { sourceProjectVersionId: inheritedSource.id } : {}),
    ...(libraryVersion && sourceRun
      ? {
          sourceTestCaseLibraryVersionId: libraryVersion.id,
          sourceTestCaseLibraryVersionSha256: libraryVersion.contentSha256,
          sourceRequirementReleaseId: sourceRun.basisSnapshot.requirementReleaseId,
          sourceRequirementReleaseContentSha256: sourceRun.basisSnapshot.requirementReleaseContentSha256,
          sourceRequirementReleaseContent: structuredClone(sourceRun.basisSnapshot.content),
        }
      : {}),
    requirementMappings: mappings,
    createdAt,
  }
  return { ...base, snapshotSha256: canonicalSha256(base) }
}

function assetContentRef(state: DatabaseState, projectId: string, versionId: string, kind: 'knowledge_asset') {
  const version = required(
    state.versions.find(item => item.id === versionId && item.status === 'ready'),
    'TEST_DESIGN_ASSET_NOT_READY',
    `资产版本 ${versionId} 不存在或未就绪`,
  )
  const asset = required(
    state.assets.find(item => item.id === version.assetId),
    'TEST_DESIGN_ASSET_NOT_READY',
    '资产不存在',
  )
  const base = required(
    state.knowledgeBases.find(item => item.id === asset.knowledgeBaseId && item.projectId === projectId),
    'TEST_DESIGN_HISTORICAL_SOURCE_INVALID',
    '资产不属于当前项目',
  )
  return {
    id: `basis_asset_${version.id}`,
    kind,
    sourceId: version.id,
    contentSha256: version.contentHash,
    content: {
      assetId: asset.id,
      assetVersionId: version.id,
      assetType: asset.assetType,
      displayName: asset.displayName,
      logicalPath: asset.logicalPath,
      content: version.content,
      chunks: version.chunks.map(({ embedding: _embedding, ...chunk }) => chunk),
    },
    locator: {
      projectId,
      knowledgeBaseId: base.id,
      assetId: asset.id,
      assetVersionId: version.id,
      logicalPath: asset.logicalPath,
    },
  }
}

function knowledgeBasisItems(state: DatabaseState, projectId: string, versionId: string) {
  const source = assetContentRef(state, projectId, versionId, 'knowledge_asset')
  const content = source.content as {
    assetId: string
    assetVersionId: string
    assetType: string
    displayName: string
    logicalPath: string
    content: string
    chunks: Array<{
      id: string
      chunkKey?: string
      content: string
      headingPath?: string[]
      startLine?: number
      endLine?: number
    }>
  }
  return fixedContentUnits(content).map((unit, index) => ({
    id: `basis_knowledge_${versionId}_${canonicalSha256(unit.id).slice(0, 16)}`,
    kind: 'knowledge_asset' as const,
    sourceId: `${versionId}:${unit.id}`,
    contentSha256: canonicalSha256(unit.content),
    content: {
      title: unit.headingPath.at(-1) ?? `${content.displayName} ${index + 1}`,
      description: unit.content,
      assetType: content.assetType,
    },
    locator: {
      coverageTarget: true,
      projectId,
      assetId: content.assetId,
      assetVersionId: versionId,
      logicalPath: content.logicalPath,
      chunkId: unit.id,
      headingPath: unit.headingPath,
      ...(unit.startLine === undefined ? {} : { startLine: unit.startLine }),
      ...(unit.endLine === undefined ? {} : { endLine: unit.endLine }),
      ordinal: index,
    },
  }))
}

function retrievalCandidates(
  state: DatabaseState,
  projectId: string,
  versionId: string,
  filters?: Record<string, string | string[]>,
) {
  const source = assetContentRef(state, projectId, versionId, 'knowledge_asset')
  const content = source.content as {
    assetId: string
    assetVersionId: string
    assetType: string
    displayName: string
    logicalPath: string
    content: string
    chunks: Array<{
      id: string
      chunkKey?: string
      content: string
      headingPath?: string[]
      startLine?: number
      endLine?: number
    }>
  }
  if (!matchesRetrievalFilters(content, filters)) return []
  const classification = /defect|bug|incident|report|缺陷|复盘|报告/iu.test(
    `${content.assetType} ${content.logicalPath}`,
  )
    ? ('historical_defect' as const)
    : /requirement|technical|api|规范|需求|方案|接口/iu.test(`${content.assetType} ${content.logicalPath}`)
      ? ('normative_reference' as const)
      : ('context_only' as const)
  return fixedContentUnits(content).map((unit, index) => ({
    id: `${versionId}:${unit.id}`,
    assetVersionId: versionId,
    chunkId: unit.id,
    content: unit.content.slice(0, 2_000),
    classification,
    locator: {
      projectId,
      assetId: content.assetId,
      assetVersionId: versionId,
      logicalPath: content.logicalPath,
      headingPath: unit.headingPath,
      ...(unit.startLine === undefined ? {} : { startLine: unit.startLine }),
      ...(unit.endLine === undefined ? {} : { endLine: unit.endLine }),
      ordinal: index,
    },
  }))
}

function fixedContentUnits(content: {
  content: string
  chunks?: Array<{
    id: string
    chunkKey?: string
    content: string
    headingPath?: string[]
    startLine?: number
    endLine?: number
  }>
}) {
  if (content.chunks?.length)
    return content.chunks
      .map((chunk, index) => ({
        id: chunk.id || chunk.chunkKey || `chunk-${index + 1}`,
        content: chunk.content,
        headingPath: chunk.headingPath ?? [],
        startLine: chunk.startLine,
        endLine: chunk.endLine,
      }))
      .filter(item => item.content.trim())
  const units = content.content
    .split(/\r?\n\s*\r?\n/u)
    .map(item => item.trim())
    .filter(Boolean)
  return (units.length ? units : [content.content]).slice(0, 500).map((value, index) => ({
    id: `paragraph-${index + 1}`,
    content: value,
    headingPath: [] as string[],
    startLine: undefined,
    endLine: undefined,
  }))
}

export function buildTestDesignRetrievalQueries(
  input: CreateTestDesignInput,
  content: RequirementReleaseContent,
): RetrievalSnapshot['queryPlan'] {
  const requirementFacts = content.requirements.map(item =>
    [
      item.title,
      item.description,
      item.actor,
      item.action,
      item.object,
      ...item.conditions,
      ...item.businessRules,
      ...item.exceptions,
      ...item.acceptanceCriteria,
    ]
      .map(value => value.trim())
      .filter(Boolean)
      .join(' '),
  )
  const answeredClarifications = content.clarifications
    .filter(item => item.status === 'answered' && item.answer?.trim())
    .map(item => `${item.question.trim()} ${item.answer!.trim()}`)
  const scopedFacts = (input.includedScopes ?? []).map(item => `${item.kind} ${item.value}`)
  const dimensionQuery = (input.focusDimensions ?? []).length ? `${input.focusDimensions!.join(' ')} 测试风险` : ''
  const entries = [
    { query: input.objective, intent: 'test_objective' },
    ...requirementFacts.map(query => ({
      query: `${query} 异常 边界 非法 状态 回退 重复操作 组合查询 一致性 历史缺陷`,
      intent: 'requirement_risk',
    })),
    ...answeredClarifications.map(query => ({ query, intent: 'answered_clarification' })),
    ...scopedFacts.map(query => ({ query, intent: 'included_scope' })),
    { query: dimensionQuery, intent: 'test_dimension' },
  ]
  const seen = new Set<string>()
  return entries
    .flatMap(item => {
      const query = item.query.trim()
      const key = query.toLocaleLowerCase()
      if (!query || seen.has(key)) return []
      seen.add(key)
      return [{ query, intent: item.intent }]
    })
    .slice(0, 20)
}

export function selectRuntimeKnowledgeReferences(retrieval: RetrievalSnapshot) {
  const classificationPriority: Record<RetrievalSnapshot['hits'][number]['classification'], number> = {
    historical_defect: 0,
    normative_reference: 1,
    domain_practice: 2,
    context_only: 3,
  }
  const selectedByContent = new Map<string, RetrievalSnapshot['hits'][number]>()
  for (const hit of [...retrieval.hits].sort(
    (left, right) =>
      classificationPriority[left.classification] - classificationPriority[right.classification] ||
      right.score - left.score ||
      left.rank - right.rank ||
      left.id.localeCompare(right.id),
  )) {
    if (!selectedByContent.has(hit.contentSha256)) selectedByContent.set(hit.contentSha256, hit)
  }
  return [...selectedByContent.values()].slice(0, TEST_DESIGN_RUNTIME_KNOWLEDGE_REFERENCE_LIMIT).map(hit => ({
    id: hit.id,
    classification: hit.classification,
    content: hit.content,
    locator: structuredClone(hit.locator),
    assetVersionId: hit.assetVersionId,
    chunkId: hit.chunkId,
  }))
}

function searchTokens(value: string) {
  const normalized = value
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
  const words = normalized.split(/\s+/u).filter(item => item.length > 1)
  const han = [...normalized.replace(/[^\p{Script=Han}]/gu, '')]
  for (let index = 0; index < han.length - 1; index += 1) words.push(`${han[index]}${han[index + 1]}`)
  return [...new Set(words)].slice(0, 100)
}

function retrievalScore(tokens: string[], content: string) {
  const normalized = content.toLocaleLowerCase()
  if (!tokens.length) return 0
  const matched = tokens.filter(token => normalized.includes(token)).length
  return Number((matched / Math.sqrt(tokens.length * Math.max(tokens.length, 4))).toFixed(6))
}

function matchesRetrievalFilters(
  content: { assetType: string; logicalPath: string },
  filters?: Record<string, string | string[]>,
) {
  if (!filters) return true
  return Object.entries(filters).every(([key, raw]) => {
    const values = Array.isArray(raw) ? raw : [raw]
    const target = key === 'assetType' ? content.assetType : key === 'logicalPath' ? content.logicalPath : ''
    return target && values.some(value => target.toLocaleLowerCase().includes(value.toLocaleLowerCase()))
  })
}

export function validateDesignSources(
  state: DatabaseState,
  projectVersion: ProjectVersion,
  input: CreateTestDesignInput,
) {
  const projectId = projectVersion.projectId
  const augmentation = input.knowledgeAugmentation
  if (augmentation.mode === 'selected_assets')
    augmentation.assetVersionIds.forEach(id => assetContentRef(state, projectId, id, 'knowledge_asset'))
  if (augmentation.mode === 'fixed_index') {
    const index = required(
      state.indexes.find(item => item.id === augmentation.indexVersionId && item.status === 'active'),
      'TEST_DESIGN_AUGMENTATION_INVALID',
      '固定索引不存在或未激活',
    )
    const base = required(
      state.knowledgeBases.find(item => item.id === index.knowledgeBaseId),
      'TEST_DESIGN_AUGMENTATION_INVALID',
      '固定索引知识库不存在',
    )
    if (base.projectId !== projectId)
      throw new TestDesignError('TEST_DESIGN_AUGMENTATION_INVALID', '固定索引不属于当前项目')
  }
}

export function explicitlyInheritedSourceVersion(state: DatabaseState, projectVersion: ProjectVersion) {
  if (!projectVersion.inheritRequirementBindings) return undefined
  const source = projectVersion.sourceProjectVersionId
    ? state.projectVersions.find(
        item => item.id === projectVersion.sourceProjectVersionId && item.projectId === projectVersion.projectId,
      )
    : undefined
  return source
}

export function inheritedLibraryVersionsForSource(aggregate: TestDesignState, sourceProjectVersionId: string) {
  return aggregate.libraryVersions.filter(item => item.projectVersionId === sourceProjectVersionId)
}

export function latestPublishedLibraryVersion(versions: TestCaseLibraryVersion[]) {
  return [...versions].sort(
    (left, right) => right.version - left.version || right.publishedAt.localeCompare(left.publishedAt),
  )[0]
}

function publishedRequirementRelease(analysisRun: ReviewRun) {
  const release = required(
    analysisRun.workflow?.release,
    'TEST_DESIGN_REQUIREMENTS_PACKAGE_REQUIRED',
    '需求发布包不存在',
  )
  if (release.status !== 'published')
    throw new TestDesignError('TEST_DESIGN_REQUIREMENTS_PACKAGE_REQUIRED', '需求发布包尚未正式发布', 422)
  if (
    release.schemaVersion !== 'requirement-release/v1' ||
    release.projectVersionId !== analysisRun.projectVersionId ||
    release.verificationRunId !== analysisRun.id
  )
    throw new TestDesignError(
      'TEST_DESIGN_REQUIREMENTS_PACKAGE_INVALID',
      'Requirement Release 与固定需求分析运行不一致',
      422,
    )
  const content = release.content
  if (
    !content ||
    !Array.isArray(content.requirements) ||
    !Array.isArray(content.evidence) ||
    !Array.isArray(content.clarifications)
  )
    throw new TestDesignError('TEST_DESIGN_REQUIREMENTS_PACKAGE_INVALID', 'Requirement Release content 结构无效', 422)
  const allowedContentKeys = new Set(['requirements', 'evidence', 'clarifications', 'testFocus'])
  if (
    Object.keys(content).some(key => !allowedContentKeys.has(key)) ||
    (content.testFocus !== undefined && !Array.isArray(content.testFocus))
  )
    throw new TestDesignError(
      'TEST_DESIGN_REQUIREMENTS_PACKAGE_INVALID',
      'Requirement Release content 包含不属于当前 Schema 的字段',
      422,
    )
  if (canonicalSha256(content) !== release.contentSha256)
    throw new TestDesignError(
      'TEST_DESIGN_REQUIREMENTS_PACKAGE_HASH_MISMATCH',
      'Requirement Release content Hash 校验失败',
      422,
    )
  const requirementIds = content.requirements.map(item => item.clientRequirementPointId.trim())
  const evidenceIds = content.evidence.map(item => item.clientEvidenceId.trim())
  const requirementIdSet = new Set(requirementIds)
  const evidenceIdSet = new Set(evidenceIds)
  const sourceIdSet = new Set(release.sourceAssetVersionIds)
  const invalidRequirement = content.requirements.some(
    point =>
      !point.clientRequirementPointId.trim() ||
      !Array.isArray(point.evidenceRefs) ||
      point.evidenceRefs.some(reference => !evidenceIdSet.has(reference)) ||
      typeof point.coverageTarget !== 'boolean' ||
      (point.coverageRationale !== undefined && !point.coverageRationale.trim()),
  )
  const invalidEvidence = content.evidence.some(
    item => !item.clientEvidenceId.trim() || !sourceIdSet.has(item.sourceRef.assetVersionId),
  )
  const invalidClarification = content.clarifications.some(
    item =>
      !item.id.trim() ||
      item.requirementPointRefs.some(reference => !requirementIdSet.has(reference)) ||
      (item.blocking && item.status === 'pending'),
  )
  const invalidFrozenTestFocus =
    content.testFocus?.some(
      item =>
        !item.id.trim() ||
        !item.title.trim() ||
        !item.description.trim() ||
        !Array.isArray(item.requirementPointRefs) ||
        item.requirementPointRefs.some(reference => !requirementIdSet.has(reference)),
    ) ?? false
  if (
    !requirementIds.length ||
    requirementIds.some(id => !id) ||
    requirementIdSet.size !== requirementIds.length ||
    evidenceIdSet.size !== evidenceIds.length ||
    invalidRequirement ||
    invalidEvidence ||
    invalidClarification ||
    invalidFrozenTestFocus
  )
    throw new TestDesignError(
      'TEST_DESIGN_REQUIREMENTS_PACKAGE_INVALID',
      'Requirement Release content Schema、引用或发布来源无效',
      422,
    )
  return release
}

type BoundRequirementRelease = {
  binding: NonNullable<ReturnType<typeof activeRequirementReleaseBinding>>
  analysisRun: ReviewRun
  release: NonNullable<NonNullable<ReviewRun['workflow']>['release']>
}

export function presentRequirementRelease(requirement: BoundRequirementRelease, active: boolean) {
  return {
    id: requirement.release.id,
    analysisRunId: requirement.analysisRun.id,
    contentSha256: requirement.release.contentSha256,
    publishedAt: requirement.release.publishedAt,
    label: `${requirement.analysisRun.documentTitle ?? '正式需求'} / ${requirement.release.id.slice(-8)}`,
    active,
  }
}

export function boundRequirementRelease(
  state: DatabaseState,
  projectVersionId: string,
  releaseId?: string,
): BoundRequirementRelease | undefined {
  const projectVersion = state.projectVersions.find(item => item.id === projectVersionId)
  const binding = releaseId
    ? projectVersion && requirementReleaseBindings(projectVersion).find(item => item.releaseId === releaseId)
    : projectVersion && activeRequirementReleaseBinding(projectVersion)
  if (!projectVersion || !binding) return undefined
  const analysisRun = state.reviewRuns.find(
    item =>
      item.id === binding.verificationRunId &&
      item.projectVersionId === projectVersionId &&
      item.status === 'succeeded' &&
      item.workflow?.release?.id === binding.releaseId,
  )
  if (!analysisRun?.workflow?.release)
    throw new TestDesignError(
      'TEST_DESIGN_REQUIREMENT_RELEASE_BINDING_INVALID',
      'ProjectVersion 绑定的 Requirement Release 不存在',
      409,
    )
  const release = publishedRequirementRelease(analysisRun)
  if (release.verificationRunId !== binding.verificationRunId || release.contentSha256 !== binding.releaseContentSha256)
    throw new TestDesignError(
      'TEST_DESIGN_REQUIREMENT_RELEASE_BINDING_INVALID',
      'ProjectVersion 的 Requirement Release content Hash 与绑定不一致',
      409,
    )
  return { binding, analysisRun, release }
}

export function buildWorkspaceSnapshot(
  state: DatabaseState,
  design: TestDesign,
  requirement: BoundRequirementRelease,
  historical: HistoricalCaseSnapshot,
  createdAt: string,
): TestDesignWorkspaceSnapshot {
  const projectVersion = required(
    state.projectVersions.find(item => item.id === design.projectVersionId),
    'PROJECT_VERSION_NOT_FOUND',
    '项目版本不存在',
  )
  const knowledgeBase = required(
    state.knowledgeBases.find(item => item.projectId === design.projectId),
    'TEST_DESIGN_WORKSPACE_REQUIRED',
    '项目知识库不存在',
  )
  const index = required(
    state.indexes.find(item => item.id === knowledgeBase.activeIndexVersionId && item.status === 'active'),
    'TEST_DESIGN_WORKSPACE_REQUIRED',
    '项目 Workspace 没有活动索引',
  )
  const files = new Map<string, TestDesignWorkspaceFile>()
  const branch = `workspace/branches/${safeWorkspaceSegment(projectVersion.name)}`
  const currentInputVersionIds = new Set(
    requirement.analysisRun.snapshot.currentInputRefs.map(item => item.assetVersionId),
  )
  for (const asset of state.assets) {
    if (asset.knowledgeBaseId !== knowledgeBase.id || !asset.activeVersionId || !isWithinWorkspace(asset.logicalPath))
      continue
    const version = state.versions.find(
      item => item.id === asset.activeVersionId && item.assetId === asset.id && item.status === 'ready',
    )
    if (!version) continue
    const logicalPath = normalizeWorkspacePath(asset.logicalPath)
    const sourceScope = classifyWorkspaceSourceScope(logicalPath, branch, currentInputVersionIds.has(version.id))
    if (sourceScope === 'formal_output') continue
    files.set(logicalPath, {
      logicalPath,
      sourceType: 'asset_version',
      sourceId: version.id,
      assetId: asset.id,
      assetVersionId: version.id,
      contentSha256: version.contentHash,
      content: version.content,
      displayName: asset.displayName,
      sourceScope,
    })
  }
  if (historical.items.length) {
    const content = `${canonicalJson({ schemaVersion: historical.schemaVersion, snapshotSha256: historical.snapshotSha256, items: historical.items })}\n`
    const logicalPath = 'workspace/agent_workspace/planning_agent/historical-test-cases.json'
    files.set(logicalPath, {
      logicalPath,
      sourceType: 'run_candidate',
      sourceId: historical.snapshotSha256,
      contentSha256: canonicalSha256Text(content),
      content,
      displayName: 'historical-test-cases.json',
      sourceScope: 'historical_branch',
    })
  }
  const ordered = [...files.values()].sort((left, right) => left.logicalPath.localeCompare(right.logicalPath, 'zh-CN'))
  const base = {
    schemaVersion: 'project-workspace-snapshot/v1' as const,
    projectId: design.projectId,
    rootLogicalPath: 'workspace' as const,
    activeBranchLogicalPath: branch,
    agentLogicalPath: 'workspace/agent_workspace/planning_agent' as const,
    projectVersionId: projectVersion.id,
    projectVersionName: projectVersion.name,
    knowledgeBaseId: knowledgeBase.id,
    indexVersionId: index.id,
    requirementReleaseId: requirement.release.id,
    verificationRunId: requirement.analysisRun.id,
    requirementReleaseContentSha256: requirement.release.contentSha256,
    files: ordered,
    createdAt,
  }
  return { ...base, snapshotSha256: canonicalSha256(base) }
}

export function sameStringSet(left: readonly string[], right: readonly string[]) {
  return left.length === right.length && [...new Set(left)].every(item => new Set(right).has(item))
}

export function normalizeSemanticText(value: string) {
  return value.normalize('NFKC').trim().replace(/\s+/gu, ' ').toLocaleLowerCase('zh-CN')
}

function semanticTokens(values: readonly string[]) {
  const tokens = new Set<string>()
  for (const value of values) {
    const normalized = normalizeSemanticText(value)
    normalized
      .split(/[^\p{L}\p{N}]+/gu)
      .filter(token => token.length >= 2)
      .forEach(token => tokens.add(token))
    const han = [...normalized.replace(/[^\p{Script=Han}]/gu, '')]
    for (let index = 0; index < han.length - 1; index += 1) tokens.add(`${han[index]}${han[index + 1]}`)
  }
  return tokens
}

export function tokenSimilarity(left: readonly string[], right: readonly string[]) {
  const a = semanticTokens(left)
  const b = semanticTokens(right)
  if (!a.size || !b.size) return 0
  const intersection = [...a].filter(token => b.has(token)).length
  return intersection / Math.max(a.size, b.size)
}

type RequirementSemantic = TestDesignBasisSnapshot['content']['requirements'][number]

function normalizedRequirementSemantic(requirement: RequirementSemantic) {
  const values = (items: string[]) =>
    items
      .map(normalizeSemanticText)
      .filter(Boolean)
      .sort((left, right) => left.localeCompare(right, 'zh-CN'))
  return {
    title: normalizeSemanticText(requirement.title),
    description: normalizeSemanticText(requirement.description),
    actor: normalizeSemanticText(requirement.actor),
    action: normalizeSemanticText(requirement.action),
    object: normalizeSemanticText(requirement.object),
    conditions: values(requirement.conditions),
    businessRules: values(requirement.businessRules),
    exceptions: values(requirement.exceptions),
    acceptanceCriteria: values(requirement.acceptanceCriteria),
    coverageTarget: requirement.coverageTarget,
  }
}

export function requirementSemanticSha256(requirement: RequirementSemantic) {
  return canonicalSha256(normalizedRequirementSemantic(requirement))
}

function semanticFieldSimilarity(left: string | string[], right: string | string[]) {
  const leftValues = Array.isArray(left) ? left : [left]
  const rightValues = Array.isArray(right) ? right : [right]
  if (canonicalSha256(leftValues) === canonicalSha256(rightValues)) return 1
  return tokenSimilarity(leftValues, rightValues)
}

function requirementSimilarity(left: RequirementSemantic, right: RequirementSemantic) {
  if (left.coverageTarget !== right.coverageTarget) return 0
  const a = normalizedRequirementSemantic(left)
  const b = normalizedRequirementSemantic(right)
  const title = semanticFieldSimilarity(a.title, b.title)
  const actor = semanticFieldSimilarity(a.actor, b.actor)
  const action = semanticFieldSimilarity(a.action, b.action)
  const object = semanticFieldSimilarity(a.object, b.object)
  const anchors = [actor, action, object].filter(score => score >= 0.85).length
  if (title < 0.8 || anchors < 2) return 0
  return (
    title * 0.25 +
    semanticFieldSimilarity(a.description, b.description) * 0.15 +
    actor * 0.1 +
    action * 0.15 +
    object * 0.15 +
    semanticFieldSimilarity(a.conditions, b.conditions) * 0.05 +
    semanticFieldSimilarity(a.businessRules, b.businessRules) * 0.05 +
    semanticFieldSimilarity(a.exceptions, b.exceptions) * 0.05 +
    semanticFieldSimilarity(a.acceptanceCriteria, b.acceptanceCriteria) * 0.05
  )
}

export function mapRequirementsAcrossReleases(
  source: RequirementSemantic[],
  current: RequirementSemantic[],
): HistoricalCaseSnapshot['requirementMappings'] {
  return source.map(sourceRequirement => {
    const sourceRequirementId = sourceRequirement.clientRequirementPointId.trim()
    const sourceSemanticSha256 = requirementSemanticSha256(sourceRequirement)
    const exact = current.filter(candidate => requirementSemanticSha256(candidate) === sourceSemanticSha256)
    if (exact.length === 1)
      return {
        sourceRequirementId,
        sourceSemanticSha256,
        status: 'exact' as const,
        targetRequirementId: exact[0]!.clientRequirementPointId.trim(),
        targetSemanticSha256: requirementSemanticSha256(exact[0]!),
        confidence: 1,
      }
    if (exact.length > 1)
      return {
        sourceRequirementId,
        sourceSemanticSha256,
        status: 'ambiguous' as const,
        candidateRequirementIds: exact.map(item => item.clientRequirementPointId.trim()).sort(),
        confidence: 1,
      }
    const highConfidence = current
      .map(candidate => ({ candidate, score: requirementSimilarity(sourceRequirement, candidate) }))
      .filter(item => item.score >= 0.88)
      .sort(
        (left, right) =>
          right.score - left.score ||
          left.candidate.clientRequirementPointId.localeCompare(right.candidate.clientRequirementPointId),
      )
    if (highConfidence.length === 1) {
      const target = highConfidence[0]!
      return {
        sourceRequirementId,
        sourceSemanticSha256,
        status: 'high_confidence' as const,
        targetRequirementId: target.candidate.clientRequirementPointId.trim(),
        targetSemanticSha256: requirementSemanticSha256(target.candidate),
        confidence: Number(target.score.toFixed(6)),
      }
    }
    if (highConfidence.length > 1)
      return {
        sourceRequirementId,
        sourceSemanticSha256,
        status: 'ambiguous' as const,
        candidateRequirementIds: highConfidence.map(item => item.candidate.clientRequirementPointId.trim()).sort(),
        confidence: Number(highConfidence[0]!.score.toFixed(6)),
      }
    return { sourceRequirementId, sourceSemanticSha256, status: 'unmapped' as const }
  })
}
