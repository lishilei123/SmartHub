const apiBase = 'http://127.0.0.1:8787/api'

export type AgentModelReference = { sourceId: string; modelId: string }
export type AgentConfigurationAgentKey =
  | 'planning'
  | 'testScript'
  | 'failureAnalysis'
  | 'scriptRepair'
export type AgentConfigurationScene =
  | 'planning'
  | 'test_execution'
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
  contextWindow: number
  maxOutputTokens: number
  requestTimeoutSeconds: number
  retryCount: number
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
  scene: AgentConfigurationScene
  routing: AgentRoutingConfiguration
  agentDefinition: { version: string; systemPrompt: string; taskTemplate: string; promptRef: { version: string }; skillBindings: Array<{ skillKey: string; version: string; enabled: boolean; configurationHash: string }>; enabledSkills: string[]; mcpBindings: Array<{ serverKey: string; version: string; enabled: boolean; toolIds: string[]; policyHash: string }>; toolIds: string[]; limits: AgentExecutionLimits; contentSha256: string }
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
  agents: Record<AgentConfigurationAgentKey, AgentConfigurationAgentState>
}

type AgentConfigurationSceneState = {
  scene: AgentConfigurationScene
  agents: Partial<Record<AgentConfigurationAgentKey, AgentConfigurationAgentState>>
}

const scenePaths: Record<AgentConfigurationScene, string> = {
  planning: 'planning',
  test_execution: 'test-execution',
}

const agentScenes: Record<AgentConfigurationAgentKey, AgentConfigurationScene> = {
  planning: 'planning',
  testScript: 'test_execution',
  failureAnalysis: 'test_execution',
  scriptRepair: 'test_execution',
}

export function materializeRequiredAgentCapabilities(
  draft: AgentConfigurationAgentDraft,
  requirements: Pick<AgentConfigurationAgentState, 'requiredToolIds' | 'requiredSkillKeys' | 'requiredMcpServerKeys'>,
): AgentConfigurationAgentDraft {
  return {
    ...draft,
    definition: {
      ...draft.definition,
      toolIds: uniqueKeys(requirements.requiredToolIds, draft.definition.toolIds),
      skillKeys: uniqueKeys(requirements.requiredSkillKeys, draft.definition.skillKeys),
      mcpServerKeys: uniqueKeys(requirements.requiredMcpServerKeys, draft.definition.mcpServerKeys),
    },
  }
}

export async function loadAgentConfiguration(): Promise<AgentConfigurationState> {
  const scenes = await Promise.all(
    Object.values(scenePaths).map(path => request<AgentConfigurationSceneState>(`/agent-configurations/${path}`)),
  )
  const agents = Object.assign({}, ...scenes.map(scene => scene.agents)) as Record<AgentConfigurationAgentKey, AgentConfigurationAgentState>
  for (const agentKey of Object.keys(agentScenes) as AgentConfigurationAgentKey[]) {
    if (!agents[agentKey]) throw new Error(`Agent 配置缺少 ${agentKey}`)
  }
  return { agents }
}

export async function saveAgentConfigurationDraft(agentKey: AgentConfigurationAgentKey, draft: AgentConfigurationAgentDraft) {
  const path = scenePaths[agentScenes[agentKey]]
  return request<AgentConfigurationAgentDraft>(`/agent-configurations/${path}/draft`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ agentKey, revision: draft.revision, routing: draft.routing, definition: draft.definition }),
  })
}

export async function publishAgentConfiguration(agentKey: AgentConfigurationAgentKey, revision: number) {
  const path = scenePaths[agentScenes[agentKey]]
  return request<AgentConfigurationVersion>(`/agent-configurations/${path}/publish`, {
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

function uniqueKeys(required: readonly string[], selected: readonly string[]) {
  return [...new Set([...selected, ...required].map(item => item.trim()).filter(Boolean))]
}
