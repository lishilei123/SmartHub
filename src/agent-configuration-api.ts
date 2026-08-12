const apiBase = 'http://127.0.0.1:8787/api'

export type AgentModelReference = { sourceId: string; modelId: string }
export type AgentConfigurationAgentKey =
  | 'requirementAnalysis'
  | 'requirementPointExtraction'
  | 'requirementReview'
  | 'reviewQa'
  | 'technicalSolutionExtraction'
  | 'technicalSolutionReview'
  | 'testAnalysis'
  | 'functionalTestDesign'
  | 'nonFunctionalTestDesign'
  | 'testCaseSynthesis'
export type AgentExecutionLimits = {
  maxTurns: number
  maxToolCalls: number
  deadlineMs: number
  toolTimeoutMs: number
  maxCandidateBytes: number
  maxFindings: number
  maxRepeatedToolCall: number
  reasoningEffort?: 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'
  reservedOutputTokens?: number
  correctionReserveTokens?: number
}
export type AgentDefinitionDraft = { systemPrompt: string; taskTemplate: string; skillKeys: string[]; mcpServerKeys: string[]; toolIds: string[]; limits: AgentExecutionLimits }
export type AgentRoutingConfiguration = {
  primaryModel: AgentModelReference | null
  fallbackModels: AgentModelReference[]
  intelligentRouting: boolean
  fallbackEnabled: boolean
  maxOutputTokens: number
  requestTimeoutSeconds: number
  retryCount: number
  structuredOutput: boolean
}
export type AgentConfigurationAgentDraft = {
  revision: number
  routing: AgentRoutingConfiguration
  definition: AgentDefinitionDraft
  updatedAt: string
}
export type AgentConfigurationVersionSummary = {
  id: string
  agentKey: AgentConfigurationAgentKey
  version: number
  status: 'active' | 'superseded'
  createdAt: string
  publishedBy: string
  contentSha256: string
  primaryModel: AgentModelReference | null
}
export type AgentConfigurationVersion = AgentConfigurationVersionSummary & {
  scene: 'requirement_analysis' | 'technical_solution_analysis' | 'test_design'
  routing: AgentRoutingConfiguration
  agentDefinition: { version: string; promptRef: { version: string }; skillBindings: Array<{ skillKey: string; version: string; enabled: boolean; configurationHash: string }>; mcpBindings: Array<{ serverKey: string; version: string; enabled: boolean; toolIds: string[]; policyHash: string }>; toolIds: string[]; limits: AgentExecutionLimits; contentSha256: string }
}
export type AgentConfigurationAgentState = {
  draft: AgentConfigurationAgentDraft
  requiredToolIds: string[]
  requiredSkillKeys: string[]
  requiredMcpServerKeys: string[]
  activeVersion: AgentConfigurationVersion | null
  versions: AgentConfigurationVersionSummary[]
}
export type AgentConfigurationState = {
  scene: 'requirement_analysis'
  agents: Record<AgentConfigurationAgentKey, AgentConfigurationAgentState>
}

export async function loadAgentConfiguration() {
  return request<AgentConfigurationState>('/agent-configurations/requirement-analysis')
}

export async function saveAgentConfigurationDraft(agentKey: AgentConfigurationAgentKey, draft: AgentConfigurationAgentDraft) {
  return request<AgentConfigurationAgentDraft>('/agent-configurations/requirement-analysis/draft', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ agentKey, revision: draft.revision, routing: draft.routing, definition: draft.definition }),
  })
}

export async function publishAgentConfiguration(agentKey: AgentConfigurationAgentKey, revision: number) {
  return request<AgentConfigurationVersion>('/agent-configurations/requirement-analysis/publish', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ agentKey, revision }),
  })
}

async function request<T>(path: string, init?: RequestInit) {
  const response = await fetch(`${apiBase}${path}`, init)
  const value = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error((value as { error?: string }).error ?? `请求失败（HTTP ${response.status}）`)
  return value as T
}
