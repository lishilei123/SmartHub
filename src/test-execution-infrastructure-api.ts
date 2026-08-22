const apiBase = 'http://127.0.0.1:8787/api'

export type ExecutionTarget = { protocol: 'http' | 'https'; host: string; port: number }
export type ExecutionEnvironmentProfile = {
  environmentId: string
  name: string
  baseUrl: string
  targets: ExecutionTarget[]
  networkName: string
  secretEnvironmentVariables?: Record<string, string>
}
export type ExecutionRunnerConfiguration = {
  containerRuntime: 'docker' | 'podman'
  runnerVersion: string
  playwrightVersion: string
  imageReference: string
  imageDigest: string
  entrypoint?: string
  workingRoot?: string
}
export type ExecutionInfrastructureVersion = {
  id: string
  version: number
  status: 'active' | 'superseded'
  environments: ExecutionEnvironmentProfile[]
  runner?: ExecutionRunnerConfiguration
  contentSha256: string
  createdAt: string
  publishedBy: string
}
export type ExecutionInfrastructureState = {
  activeVersion: ExecutionInfrastructureVersion | null
  versions: Array<Pick<ExecutionInfrastructureVersion, 'id' | 'version' | 'status' | 'contentSha256' | 'createdAt' | 'publishedBy'>>
}

export async function loadExecutionInfrastructureConfiguration() {
  return await request<ExecutionInfrastructureState>('/test-execution-infrastructure-configuration')
}

export async function publishExecutionInfrastructureConfiguration(input: {
  expectedActiveVersion?: number | null
  environments: ExecutionEnvironmentProfile[]
  runner?: ExecutionRunnerConfiguration
}) {
  return await request<ExecutionInfrastructureVersion>('/test-execution-infrastructure-configuration', {
    method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input),
  })
}

async function request<T>(path: string, init?: RequestInit) {
  const response = await fetch(`${apiBase}${path}`, init)
  const value = await response.json().catch(() => ({})) as { error?: string; message?: string }
  if (!response.ok) throw new Error(value.message ?? value.error ?? `请求失败（HTTP ${response.status}）`)
  return value as T
}
