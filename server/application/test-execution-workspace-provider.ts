import { createHash } from 'node:crypto'
import type {
  TestExecutionAgentWorkspaceFile,
  TestExecutionAgentWorkspaceProjection,
} from '../domain/agent-types.js'
import type {
  ExecutionArtifact,
  ExecutionAttempt,
  ExecutionEvent,
  ExecutionRun,
  ExecutionTask,
  FailureDiagnosis,
  ScriptRevision,
} from '../domain/test-execution-types.js'
import type { ExecutionArtifactStore } from '../infrastructure/execution-artifact-store.js'
import type { TestExecutionStore } from '../infrastructure/test-execution-store.js'
import { canonicalJson } from './canonical-json.js'
import type { TestExecutionWorkspaceProvider } from './test-execution-service.js'

const MAX_DIAGNOSTIC_LOG_ARTIFACTS = 6
const MAX_DIAGNOSTIC_LOG_EXCERPT_BYTES = 40 * 1024

export class FrozenTestExecutionWorkspaceProvider
implements TestExecutionWorkspaceProvider {
  constructor(
    private readonly store: TestExecutionStore,
    private readonly artifactStore: ExecutionArtifactStore,
  ) {}

  async project(input: {
    run: ExecutionRun
    task: ExecutionTask
    scriptRevision?: ScriptRevision
    attempts: readonly ExecutionAttempt[]
    events: readonly ExecutionEvent[]
    diagnoses: readonly FailureDiagnosis[]
    artifacts: readonly ExecutionArtifact[]
  }): Promise<TestExecutionAgentWorkspaceProjection> {
    assertScope(input)
    const rootLogicalPath = executionRoot(input.run.id, input.task.id)
    const files = [
      workspaceJson(
        `${rootLogicalPath}/run.json`,
        '冻结执行运行',
        frozenRunView(input.run),
      ),
      workspaceJson(
        `${rootLogicalPath}/task.json`,
        '冻结执行任务',
        input.task,
      ),
      workspaceJson(
        `${rootLogicalPath}/attempts.json`,
        '不可变 Runner Attempts',
        orderedAttempts(input.attempts),
      ),
      workspaceJson(
        `${rootLogicalPath}/events.json`,
        '结构化 Playwright Reporter 事件',
        orderedEvents(input.events),
      ),
      workspaceJson(
        `${rootLogicalPath}/diagnoses.json`,
        '不可变失败诊断',
        orderedDiagnoses(input.diagnoses),
      ),
      workspaceJson(
        `${rootLogicalPath}/artifacts.json`,
        '执行 Artifact 元数据',
        orderedArtifacts(input.artifacts),
      ),
    ]
    files.push(...await this.readDiagnosticLogEvidence(input, rootLogicalPath))
    if (input.scriptRevision) {
      const sources = await this.readRevisionSources(input)
      const source = sources.find(file => file.path === input.scriptRevision!.package.entrypoint)
      if (!source) throw new Error('TEST_EXECUTION_WORKSPACE_SCRIPT_ARTIFACT_INVALID')
      files.push(
        workspaceJson(
          `${rootLogicalPath}/script-revision.json`,
          '当前 ScriptRevision',
          input.scriptRevision,
        ),
        workspaceFile(
          `${rootLogicalPath}/current.spec.ts`,
          '当前受保护 Playwright 脚本',
          source.content,
        ),
        ...sources.map(file => workspaceFile(
          `${rootLogicalPath}/revision-source/${file.path}`,
          `当前 ScriptRevision 依赖 · ${file.path}`,
          file.content,
        )),
      )
    }
    return {
      runId: input.run.id,
      taskId: input.task.id,
      projectId: input.run.projectId,
      projectName: input.run.projectId,
      projectVersionId: input.run.projectVersionId,
      projectVersionName: input.run.projectVersionId,
      knowledgeBaseId: input.run.knowledge?.knowledgeBaseId ?? `test-execution:${input.run.projectId}`,
      indexVersionId: input.run.knowledge?.indexVersionId ?? `test-execution:${input.run.handoff.handoffSha256}`,
      assets: [],
      documentWorkspace: {
        mode: 'agent_directory',
        logicalPath: rootLogicalPath,
        rootLogicalPath,
        agentLogicalPath: rootLogicalPath,
        candidateAssetVersionIds: [],
      },
      workspaceFiles: files.sort((left, right) =>
        left.logicalPath.localeCompare(right.logicalPath, 'en')),
    }
  }

  private async readRevisionSources(input: {
    run: ExecutionRun
    task: ExecutionTask
    scriptRevision?: ScriptRevision
  }) {
    const revision = input.scriptRevision!
    if (
      revision.sourceArtifacts.length !== revision.package.files.length
      || revision.sourceArtifacts.some((file, index) => file.path !== revision.package.files[index].path)
      || revision.sourceArtifacts.find(file => file.path === revision.package.entrypoint)?.artifactId !== revision.sourceArtifactId
    ) {
      throw new Error('TEST_EXECUTION_WORKSPACE_SCRIPT_ARTIFACT_INVALID')
    }
    let packageBytes = 0
    return await Promise.all(revision.sourceArtifacts.map(async (reference, index) => {
      const manifestFile = revision.package.files[index]
      const artifact = await this.store.getArtifact(reference.artifactId)
      if (
        !artifact
        || artifact.runId !== input.run.id
        || artifact.taskId !== input.task.id
        || artifact.attemptId
        || artifact.type !== 'script'
        || artifact.sha256 !== manifestFile.contentSha256
        || artifact.size !== manifestFile.size
      ) throw new Error('TEST_EXECUTION_WORKSPACE_SCRIPT_ARTIFACT_INVALID')
      const metadata = await this.artifactStore.stat(artifact.storagePath)
      if (metadata.sha256 !== artifact.sha256 || metadata.size !== artifact.size) {
        throw new Error('TEST_EXECUTION_WORKSPACE_SCRIPT_ARTIFACT_DRIFT')
      }
      const stream = await this.artifactStore.open(artifact.storagePath)
      const chunks: Buffer[] = []
      let bytes = 0
      for await (const value of stream) {
        const chunk = Buffer.from(value)
        bytes += chunk.length
        if (bytes > 512 * 1024) throw new Error('TEST_EXECUTION_WORKSPACE_SCRIPT_TOO_LARGE')
        chunks.push(chunk)
      }
      packageBytes += bytes
      if (packageBytes > 4 * 1024 * 1024) throw new Error('TEST_EXECUTION_WORKSPACE_SCRIPT_TOO_LARGE')
      const source = Buffer.concat(chunks).toString('utf8')
      if (!source || bytes !== artifact.size || sha256(source) !== artifact.sha256) {
        throw new Error('TEST_EXECUTION_WORKSPACE_SCRIPT_ARTIFACT_INVALID')
      }
      return { path: reference.path, content: source }
    }))
  }

  private async readDiagnosticLogEvidence(input: {
    attempts: readonly ExecutionAttempt[]
    artifacts: readonly ExecutionArtifact[]
  }, rootLogicalPath: string) {
    const attemptOrdinal = new Map(input.attempts.map(attempt => [attempt.id, attempt.ordinal]))
    const logs = input.artifacts
      .filter(artifact =>
        artifact.type === 'log'
        && artifact.attemptId
        && attemptOrdinal.has(artifact.attemptId)
        && artifact.mimeType.toLocaleLowerCase().startsWith('text/plain'))
      .sort((left, right) =>
        (attemptOrdinal.get(left.attemptId!) ?? 0) - (attemptOrdinal.get(right.attemptId!) ?? 0)
        || left.id.localeCompare(right.id, 'en'))
      .slice(0, MAX_DIAGNOSTIC_LOG_ARTIFACTS)
    return await Promise.all(logs.map(async artifact => {
      const metadata = await this.artifactStore.stat(artifact.storagePath)
      if (metadata.sha256 !== artifact.sha256 || metadata.size !== artifact.size) {
        throw new Error('TEST_EXECUTION_WORKSPACE_DIAGNOSTIC_ARTIFACT_DRIFT')
      }
      const { text, truncated } = await diagnosticLogExcerpt(
        await this.artifactStore.open(artifact.storagePath),
        artifact.size,
      )
      const ordinal = attemptOrdinal.get(artifact.attemptId!)!
      const content = [
        'SMARTHUB RUNNER LOG EVIDENCE',
        `attemptOrdinal: ${ordinal}`,
        `artifactType: ${artifact.type}`,
        `artifactSha256: ${artifact.sha256}`,
        `originalBytes: ${artifact.size}`,
        `truncated: ${truncated}`,
        '---',
        sanitizeDiagnosticLog(text),
        '',
      ].join('\n')
      return workspaceFile(
        `${rootLogicalPath}/evidence/attempt-${ordinal}/runner-${safePathIdentity(artifact.id)}.log`,
        `Runner 终态日志摘录 · Attempt ${ordinal}`,
        content,
      )
    }))
  }
}

async function diagnosticLogExcerpt(
  stream: AsyncIterable<Uint8Array>,
  expectedBytes: number,
) {
  const headLimit = Math.floor(MAX_DIAGNOSTIC_LOG_EXCERPT_BYTES / 2)
  const tailLimit = MAX_DIAGNOSTIC_LOG_EXCERPT_BYTES - headLimit
  const prefix: Buffer[] = []
  let prefixBytes = 0
  let tail = Buffer.alloc(0)
  let bytes = 0
  for await (const value of stream) {
    const chunk = Buffer.from(value)
    bytes += chunk.length
    if (prefixBytes < MAX_DIAGNOSTIC_LOG_EXCERPT_BYTES) {
      const selected = chunk.subarray(0, Math.min(
        chunk.length,
        MAX_DIAGNOSTIC_LOG_EXCERPT_BYTES - prefixBytes,
      ))
      prefix.push(selected)
      prefixBytes += selected.length
    }
    tail = Buffer.concat([tail, chunk])
    if (tail.length > tailLimit) tail = tail.subarray(tail.length - tailLimit)
  }
  if (bytes !== expectedBytes) {
    throw new Error('TEST_EXECUTION_WORKSPACE_DIAGNOSTIC_ARTIFACT_INVALID')
  }
  const prefixBuffer = Buffer.concat(prefix)
  if (bytes <= MAX_DIAGNOSTIC_LOG_EXCERPT_BYTES) {
    return { text: prefixBuffer.toString('utf8'), truncated: false }
  }
  return {
    text: `${prefixBuffer.subarray(0, headLimit).toString('utf8')}\n\n... <TRUNCATED ${bytes - MAX_DIAGNOSTIC_LOG_EXCERPT_BYTES} BYTES> ...\n\n${tail.toString('utf8')}`,
    truncated: true,
  }
}

function sanitizeDiagnosticLog(value: string) {
  return value
    .replace(/\u001B\[[0-?]*[ -/]*[@-~]/gu, '')
    .replace(/[A-Za-z]:\\[^\r\n]*/gu, redactDiagnosticLocalPath)
    .replace(/\bBearer\s+[^\s,;]+/giu, 'Bearer <REDACTED>')
    .replace(
      /\b(authorization|cookie|set-cookie|password|token|api[_ -]?key|secret)\b\s*[:=]\s*[^\r\n,;]+/giu,
      '$1=<REDACTED>',
    )
}

function redactDiagnosticLocalPath(value: string) {
  const normalized = value.replaceAll('\\', '/')
  const workspacePath = normalized.lastIndexOf('/tests/')
  return workspacePath >= 0 ? `<workspace>${normalized.slice(workspacePath)}` : '<local-path>'
}

function assertScope(input: {
  run: ExecutionRun
  task: ExecutionTask
  scriptRevision?: ScriptRevision
  attempts: readonly ExecutionAttempt[]
  events: readonly ExecutionEvent[]
  diagnoses: readonly FailureDiagnosis[]
  artifacts: readonly ExecutionArtifact[]
}) {
  if (input.task.runId !== input.run.id) {
    throw new Error('TEST_EXECUTION_WORKSPACE_TASK_SCOPE_INVALID')
  }
  if (
    input.scriptRevision
    && (
      input.scriptRevision.runId !== input.run.id
      || input.scriptRevision.taskId !== input.task.id
      || input.scriptRevision.id !== input.task.currentScriptRevisionId
    )
  ) {
    throw new Error('TEST_EXECUTION_WORKSPACE_REVISION_SCOPE_INVALID')
  }
  if (input.attempts.some(attempt =>
    attempt.runId !== input.run.id
    || attempt.taskId !== input.task.id
    || (
      input.scriptRevision
      && attempt.scriptRevisionId !== input.scriptRevision.id
    ))) {
    throw new Error('TEST_EXECUTION_WORKSPACE_ATTEMPT_SCOPE_INVALID')
  }
  if (input.diagnoses.some(diagnosis =>
    diagnosis.runId !== input.run.id
    || diagnosis.taskId !== input.task.id)) {
    throw new Error('TEST_EXECUTION_WORKSPACE_DIAGNOSIS_SCOPE_INVALID')
  }
  const attemptIds = new Set(input.attempts.map(attempt => attempt.id))
  if (input.events.some(event =>
    event.runId !== input.run.id
    || event.taskId !== input.task.id
    || !attemptIds.has(event.attemptId))) {
    throw new Error('TEST_EXECUTION_WORKSPACE_EVENT_SCOPE_INVALID')
  }
  if (input.artifacts.some(artifact =>
    artifact.runId !== input.run.id
    || artifact.taskId !== input.task.id
    || !artifact.attemptId
    || !attemptIds.has(artifact.attemptId))) {
    throw new Error('TEST_EXECUTION_WORKSPACE_ARTIFACT_SCOPE_INVALID')
  }
}

function frozenRunView(run: ExecutionRun) {
  return {
    id: run.id,
    projectId: run.projectId,
    projectVersionId: run.projectVersionId,
    handoff: run.handoff,
    environment: run.environment,
    ...(run.knowledge ? { knowledge: run.knowledge } : {}),
    runner: run.runner,
    agents: run.agents,
    status: run.status,
    stateVersion: run.stateVersion,
    taskCount: run.taskCount,
    createdBy: run.createdBy,
    createdAt: run.createdAt,
    ...(run.startedAt ? { startedAt: run.startedAt } : {}),
    ...(run.cancelRequestedAt ? { cancelRequestedAt: run.cancelRequestedAt } : {}),
  }
}

function orderedAttempts(attempts: readonly ExecutionAttempt[]) {
  return attempts
    .slice()
    .sort((left, right) => left.ordinal - right.ordinal)
}

function orderedEvents(events: readonly ExecutionEvent[]) {
  return events
    .slice()
    .sort((left, right) =>
      left.attemptId.localeCompare(right.attemptId, 'en')
      || left.sequence - right.sequence
      || left.id.localeCompare(right.id, 'en'))
}

function orderedDiagnoses(diagnoses: readonly FailureDiagnosis[]) {
  return diagnoses
    .slice()
    .sort((left, right) =>
      left.createdAt.localeCompare(right.createdAt)
      || left.id.localeCompare(right.id))
}

function orderedArtifacts(artifacts: readonly ExecutionArtifact[]) {
  return artifacts
    .map(artifact => ({
      id: artifact.id,
      runId: artifact.runId,
      taskId: artifact.taskId,
      attemptId: artifact.attemptId,
      type: artifact.type,
      sha256: artifact.sha256,
      size: artifact.size,
      mimeType: artifact.mimeType,
      createdAt: artifact.createdAt,
    }))
    .sort((left, right) =>
      String(left.attemptId).localeCompare(String(right.attemptId))
      || left.type.localeCompare(right.type)
      || left.id.localeCompare(right.id))
}

function workspaceJson(
  logicalPath: string,
  displayName: string,
  value: unknown,
) {
  return workspaceFile(logicalPath, displayName, canonicalJson(value))
}

function workspaceFile(
  logicalPath: string,
  displayName: string,
  content: string,
): TestExecutionAgentWorkspaceFile {
  return {
    logicalPath,
    displayName,
    content,
    contentSha256: sha256(content),
  }
}

function executionRoot(runId: string, taskId: string) {
  return `test-execution/${safePathIdentity(runId)}/${safePathIdentity(taskId)}`
}

function safePathIdentity(value: string) {
  if (!/^[A-Za-z0-9._-]{1,200}$/u.test(value)) {
    throw new Error('TEST_EXECUTION_WORKSPACE_IDENTITY_INVALID')
  }
  return value
}

function sha256(value: string) {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}
