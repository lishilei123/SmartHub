import type { AgentCandidateResult, PlanningClarification } from './review-types.js'

export type AgentReasoningEffort = 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'
export type RequirementInputMode = 'full_context' | 'segmented_context' | 'agent_directory'

export interface AgentExecutionLimits {
  maxTurns: number
  maxToolCalls: number
  deadlineMs: number
  toolTimeoutMs: number
  maxCandidateBytes: number
  maxFindings: number
  maxRepeatedToolCall: number
  reasoningEffort?: AgentReasoningEffort
  reservedOutputTokens?: number
  correctionReserveTokens?: number
}

export interface AgentDefinitionVersion {
  agentKey: 'planning' | 'test-script' | 'failure-analysis' | 'script-repair'
  agentType: 'planning' | 'test_script' | 'failure_analysis' | 'script_repair'
  version: string
  status: 'published'
  modelScene: 'planning' | 'test_execution'
  resultSchemaVersion: 'planning/v1' | 'test-script-generation/v1' | 'failure-analysis/v1' | 'script-repair/v1'
  systemPrompt: string
  taskTemplate: string
  promptRef: { promptKey: string; version: string; contentSha256: string }
  toolsetVersion: string
  toolsetContentSha256: string
  skillBindings: Array<{ skillKey: string; version: string; enabled: boolean; configurationHash: string }>
  enabledSkills: string[]
  mcpBindings: Array<{ serverKey: string; version: string; enabled: boolean; toolIds: string[]; policyHash: string }>
  toolIds: string[]
  limits: AgentExecutionLimits
  contentSha256: string
}

export type ProjectWorkspaceSourceScope =
  | 'current_input'
  | 'current_branch'
  | 'shared'
  | 'historical_branch'
  | 'formal_output'

export interface ProjectWorkspaceSnapshotFile {
  assetId?: string
  assetVersionId?: string
  logicalPath: string
  displayName: string
  contentSha256: string
  sourceScope: ProjectWorkspaceSourceScope
}

export interface ProjectWorkspaceSnapshot {
  schemaVersion: 'project-workspace-snapshot/v1'
  projectId: string
  projectVersionId: string
  rootLogicalPath: 'workspace'
  activeBranchLogicalPath: string
  files: ProjectWorkspaceSnapshotFile[]
  snapshotSha256: string
  createdAt: string
}

export interface CurrentInputRef {
  assetId: string
  assetVersionId: string
  logicalPath: string
  contentSha256: string
}

export interface AgentDefinitionResolver {
  resolve(agentKey: AgentDefinitionVersion['agentKey']): AgentDefinitionVersion | Promise<AgentDefinitionVersion>
  resolveActive?(agentKey: AgentDefinitionVersion['agentKey']): import('./types.js').AgentConfigurationVersion | null | Promise<import('./types.js').AgentConfigurationVersion | null>
  resolveVersion?(id: string): import('./types.js').AgentConfigurationVersion | Promise<import('./types.js').AgentConfigurationVersion>
}

export interface ReviewRunSnapshot {
  runId: string
  reviewId?: string
  projectId: string
  projectName: string
  projectVersionId: string
  projectVersionName: string
  knowledgeBaseId: string
  assetId: string
  assetVersionId: string
  assetContentHash: string
  indexVersionId: string
  logicalPath: string
  assets: Array<{ assetId: string; assetVersionId: string; assetContentHash: string; logicalPath: string; displayName: string; assetType?: string }>
  currentInputRefs: CurrentInputRef[]
  workspaceSnapshot: ProjectWorkspaceSnapshot
  formalClarifications?: PlanningClarification[]
  documentWorkspace?: {
    mode: 'agent_directory'
    logicalPath: string
    rootLogicalPath?: string
    activeBranchLogicalPath?: string
    branchLogicalPaths?: string[]
    agentLogicalPath?: string
    layoutVersion?: 'workspace/v1'
    candidateAssetVersionIds: string[]
  }
  modelRef: { sourceId: string; modelId: string; providerType: 'openai' | 'anthropic' | 'openai_compatible'; modelName: string; contextWindow: number; maxOutputTokens: number; supportsReasoning: boolean }
  agentConfigurationRef?: { id: string; version: number; contentSha256: string }
  focusAreas: string[]
  excludedAreas: string[]
  agentDefinition: AgentDefinitionVersion
  analysisCoveragePlan: Array<{
    assetVersionId: string
    chunks: Array<{ chunkId: string; contentHash: string; headingPath: string[]; startLine: number; endLine: number; excludedReason?: string }>
  }>
  analysisToolBudget: { directoryCalls: number; chunkCalls: number; knowledgeCalls: number; submissionCalls: number; minimumToolCalls: number }
  analysisInput: {
    policyVersion: string
    mode: RequirementInputMode
    estimatedInputTokens: number
    safeInputBudget: number
    packageSha256: string
    batches: Array<{ batchId: string; ordinal: number; tokenCount: number; contentSha256: string; assetVersionIds: string[]; chunkIds: string[] }>
  }
  createdAt: string
}

export interface RequirementInputBatch {
  batchId: string
  ordinal: number
  tokenCount: number
  assetVersionIds: string[]
  chunkIds: string[]
  content: string
}

export interface RequirementInputPlan {
  policyVersion: string
  mode: RequirementInputMode
  estimatedInputTokens: number
  safeInputBudget: number
  packageSha256: string
  batches: RequirementInputBatch[]
}

export interface InputDeliveryManifestEntry {
  batchId: string
  ordinal: number
  assetVersionIds: string[]
  chunkIds: string[]
  contentSha256: string
  tokenCount: number
  modelCallSequence: number
}

export interface InputDeliveryManifest {
  policyVersion: string
  mode: RequirementInputMode
  packageSha256: string
  entries: InputDeliveryManifestEntry[]
  toolReads?: Array<{
    toolCallId: string
    toolId: 'workspace.read_file'
    relativePath: string
    assetVersionIds: string[]
    chunkIds: string[]
    startLine: number
    endLine: number
    sourceScope?: ProjectWorkspaceSourceScope
  }>
  finalMergeCompleted: boolean
}

export interface AgentModelConnection {
  sourceId: string
  providerType: 'openai' | 'anthropic' | 'openai_compatible'
  baseUrl: string
  apiKey: string
  modelId: string
  modelName: string
  contextWindow: number
  maxOutputTokens: number
  supportsReasoning: boolean
  requestTimeoutMs?: number
  retryCount?: number
}

export interface AgentExecutionContext {
  sessionId: string
  sessionFile?: string
  sessionRole: 'planning_parent' | 'reviewer' | 'execution_agent'
  parentSessionKey?: string
  contextWindow: number
  currentTokens: number | null
  usagePercent: number | null
  compactionCount: number
  lastCompactionAt?: string
  totalMessages: number
  autoCompactionEnabled: boolean
}

export interface AgentExecutionEvent {
  sequence: number
  type: string
  occurredAt: string
  turn?: number
  toolId?: string
  toolCallId?: string
  isError?: boolean
  role?: 'user' | 'assistant' | 'tool'
  content?: string
  toolCalls?: Array<{ id: string; name: string }>
  toolArguments?: unknown
  toolResult?: unknown
  skillKey?: string
  version?: string
  stopReason?: string
  model?: string
  usage?: { input: number; output: number; cacheRead: number; cacheWrite: number; totalTokens: number }
  framework?: { name: 'pi-agent-core' | 'pi-coding-agent'; version: string }
  context?: AgentExecutionContext
  compaction?: {
    reason: 'manual' | 'threshold' | 'overflow'
    aborted?: boolean
    willRetry?: boolean
    tokensBefore?: number
    estimatedTokensAfter?: number
    compactedTokens?: number
  }
  parentSessionId?: string
  subAgentRunId?: string
  reviewerType?: 'requirement' | 'test_point' | 'test_case' | 'coverage'
}

export type PlanningReviewerType = 'requirement' | 'test_point' | 'test_case' | 'coverage'

export interface ReviewCandidate {
  schemaVersion: 'planning-review-candidate/v1'
  reviewerType: PlanningReviewerType
  verdict: 'pass' | 'changes_required' | 'blocked'
  summary: string
  findings: Array<{
    ref: string
    severity: 'blocker' | 'high' | 'medium' | 'low'
    category: string
    title: string
    detail: string
    evidenceRefs: string[]
    recommendation?: string
  }>
  suggestedActions: string[]
}

export interface PlanningReviewerWorkspaceFile {
  logicalPath: string
  contentSha256: string
  content: string
  displayName: string
  assetId?: string
  assetVersionId?: string
}

export interface PlanningReviewerSnapshot {
  runId: string
  projectId: string
  projectName: string
  projectVersionId: string
  projectVersionName: string
  knowledgeBaseId: string
  indexVersionId: string
  assets: Array<{ assetId: string; assetVersionId: string; assetContentHash: string; logicalPath: string; displayName: string; assetType?: string }>
  documentWorkspace: NonNullable<ReviewRunSnapshot['documentWorkspace']>
  workspaceFiles: PlanningReviewerWorkspaceFile[]
  agentDefinition: AgentDefinitionVersion
  taskSha256: string
  createdAt: string
}

export interface ReviewerExecutionInput {
  runId: string
  reviewerType: PlanningReviewerType
  snapshot: ReviewRunSnapshot | PlanningTestDesignSnapshot | PlanningReviewerSnapshot
  model: AgentModelConnection
  task: string
  requiredReadPaths: string[]
  onEvent?: (event: AgentExecutionEvent) => void | Promise<void>
}

export interface ReviewerExecutionOutput {
  runId: string
  reviewerType: PlanningReviewerType
  parentSessionId?: string
  candidate: ReviewCandidate
  events: AgentExecutionEvent[]
  turns: number
  toolCalls: number
  toolErrors: number
  framework: { name: 'pi-coding-agent'; version: string }
  context: AgentExecutionContext
}

export interface AgentExecutionInput {
  snapshot: ReviewRunSnapshot | PlanningTestDesignSnapshot | TestExecutionAgentSnapshot
  model: AgentModelConnection
  requirementInputPlan?: RequirementInputPlan
  executionProfile?: {
    mode: 'workspace_tools'
    workflowStage: 'analysis' | 'repair' | 'verification' | 'release' | 'test_point_design' | 'test_case_design' | 'test_design_repair' | 'script_generation' | 'failure_diagnosis' | 'script_repair'
    allowedToolIds: string[]
    submitToolId: string
    schemaVersion: string
    agentLabel: string
    initialTask: string
    validateCandidate: (candidate: Record<string, unknown>, manifest: InputDeliveryManifest) => Promise<{ valid: boolean; result?: AgentCandidateResult | Record<string, unknown>; issues: Array<{ path: string; message: string }> }>
  }
  onEvent?: (event: AgentExecutionEvent) => void | Promise<void>
}

export interface AgentExecutionOutput {
  candidate: AgentCandidateResult | Record<string, unknown>
  events: AgentExecutionEvent[]
  turns: number
  toolCalls: number
  toolErrors: number
  framework: { name: 'pi-agent-core' | 'pi-coding-agent'; version: string }
  context?: AgentExecutionContext
  inputDeliveryManifest?: InputDeliveryManifest
}

export type PlanningReviewerSourceReference =
  | {
      kind: 'requirement'
      requirementRunId: string
      assetVersions: Array<{
        assetVersionId: string
        contentSha256: string
      }>
      resultSha256: string
    }
  | {
      kind: 'test_design'
      testDesignRunId: string
      requirementReleaseId: string
      requirementsJsonSha256: string
      testPointTreeId: string
      testPointTreeRevision: number
      testPointTreeSha256: string
      approvedTestPointTreeVersionId?: string
      testCases: Array<{
        caseId: string
        treeVersionId: string
        revision: number
        contentSha256: string
      }>
      dataSetVersionId?: string
      dataSetContentSha256?: string
      coverageAuditId?: string
      coverageAuditInputSha256?: string
    }

export interface PlanningSubAgentRunRecord {
  runId: string
  reviewerType: PlanningReviewerType
  status: 'running' | 'succeeded' | 'failed' | 'cancelled'
  sourceKind: 'requirement_run' | 'test_design_run'
  sourceId: string
  sourceSha256: string
  sourceReference: PlanningReviewerSourceReference
  parentSessionId?: string
  reviewerSessionId?: string
  turns: number
  toolCalls: number
  toolErrors: number
  framework?: { name: 'pi-coding-agent'; version: string }
  context?: AgentExecutionContext
  events: AgentExecutionEvent[]
  startedAt: string
  finishedAt?: string
  error?: string
}

export type PlanningWorkflowStage =
  | 'requirement_analysis'
  | 'requirement_clarification'
  | 'requirement_understanding'
  | 'requirement_repair'
  | 'requirement_verification'
  | 'requirement_release'
  | 'test_point_design'
  | 'test_point_review'
  | 'test_case_design'
  | 'test_design_repair'
  | 'test_design_release'

export interface PlanningStageProfile {
  stage: PlanningWorkflowStage
  agentKey: 'planning'
  allowedToolIds: string[]
  submitToolId?: string
  resultSchemaVersion?: string
  reviewers: PlanningReviewerType[]
  humanGate: boolean
}

export interface PlanningAgentProfile {
  agentKey: 'planning'
  label: 'PlanningAgent'
  parentSession: 'project_version'
  subAgents: Array<{
    reviewerType: PlanningReviewerType
    label: string
    session: 'independent'
    workspace: 'read_only'
    resultSchemaVersion: 'planning-review-candidate/v1'
  }>
  context: {
    autoCompaction: true
    proactiveThresholdPercent: number
    checkpoints: string[]
    summaryIsFormalBusinessFact: false
  }
  stageProfiles: PlanningStageProfile[]
  configurations: Array<{
    scene: 'planning'
    agentKey: 'planning'
    activeVersion: import('./types.js').AgentConfigurationVersion | null
  }>
}

export interface TestExecutionAgentWorkspaceFile {
  logicalPath: string
  contentSha256: string
  content: string
  assetId?: string
  assetVersionId?: string
  displayName: string
}

export interface TestExecutionAgentWorkspaceProjection {
  runId: string
  projectId: string
  projectName: string
  projectVersionId: string
  projectVersionName: string
  knowledgeBaseId: string
  indexVersionId: string
  assets: []
  documentWorkspace: NonNullable<ReviewRunSnapshot['documentWorkspace']>
  workspaceFiles: TestExecutionAgentWorkspaceFile[]
}

export interface TestExecutionAgentSnapshot
  extends TestExecutionAgentWorkspaceProjection {
  agentDefinition: AgentDefinitionVersion
  taskSha256: string
  createdAt: string
}

export interface PlanningTestDesignSnapshot {
  runId: string
  projectId: string
  projectName: string
  projectVersionId: string
  projectVersionName: string
  knowledgeBaseId: string
  indexVersionId: string
  assets: Array<{ assetId: string; assetVersionId: string; assetContentHash: string; logicalPath: string; displayName: string; assetType?: string }>
  currentInputRefs: CurrentInputRef[]
  documentWorkspace: NonNullable<ReviewRunSnapshot['documentWorkspace']>
  workspaceFiles: import('./test-design-types.js').TestDesignWorkspaceFile[]
  workspaceSnapshot: import('./test-design-types.js').TestDesignWorkspaceSnapshot
  agentDefinition: AgentDefinitionVersion
  taskSha256: string
  createdAt: string
}

export interface AgentRuntime {
  execute(input: AgentExecutionInput, signal: AbortSignal): Promise<AgentExecutionOutput>
}
