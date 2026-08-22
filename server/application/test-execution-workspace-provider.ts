import { createHash } from 'node:crypto'
import type {
  TestExecutionAgentWorkspaceFile,
  TestExecutionAgentWorkspaceProjection,
} from '../domain/agent-types.js'
import type {
  ExecutionArtifact,
  ExecutionAttempt,
  ExecutionRun,
  ExecutionTask,
  FailureDiagnosis,
  ScriptRevision,
} from '../domain/test-execution-types.js'
import type { ExecutionArtifactStore } from '../infrastructure/execution-artifact-store.js'
import type { TestExecutionStore } from '../infrastructure/test-execution-store.js'
import { canonicalJson } from './canonical-json.js'
import type { TestExecutionWorkspaceProvider } from './test-execution-service.js'

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
    if (input.scriptRevision) {
      const source = await this.readRevisionSource(input)
      files.push(
        workspaceJson(
          `${rootLogicalPath}/script-revision.json`,
          '当前 ScriptRevision',
          input.scriptRevision,
        ),
        workspaceFile(
          `${rootLogicalPath}/current.spec.ts`,
          '当前受保护 Playwright 脚本',
          source,
        ),
      )
    }
    return {
      runId: input.run.id,
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
        activeBranchLogicalPath: rootLogicalPath,
        branchLogicalPaths: [rootLogicalPath],
        agentLogicalPath: rootLogicalPath,
        layoutVersion: 'workspace/v1',
        candidateAssetVersionIds: [],
      },
      workspaceFiles: files.sort((left, right) =>
        left.logicalPath.localeCompare(right.logicalPath, 'en')),
    }
  }

  private async readRevisionSource(input: {
    run: ExecutionRun
    task: ExecutionTask
    scriptRevision?: ScriptRevision
  }) {
    const revision = input.scriptRevision!
    const artifact = await this.store.getArtifact(revision.sourceArtifactId)
    if (
      !artifact
      || artifact.runId !== input.run.id
      || artifact.taskId !== input.task.id
      || artifact.attemptId
      || artifact.type !== 'script'
      || artifact.sha256 !== revision.contentSha256
    ) {
      throw new Error('TEST_EXECUTION_WORKSPACE_SCRIPT_ARTIFACT_INVALID')
    }
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
      if (bytes > 512 * 1024) {
        throw new Error('TEST_EXECUTION_WORKSPACE_SCRIPT_TOO_LARGE')
      }
      chunks.push(chunk)
    }
    const source = Buffer.concat(chunks).toString('utf8')
    if (
      !source
      || bytes !== artifact.size
      || sha256(source) !== artifact.sha256
    ) {
      throw new Error('TEST_EXECUTION_WORKSPACE_SCRIPT_ARTIFACT_INVALID')
    }
    return source
  }
}

function assertScope(input: {
  run: ExecutionRun
  task: ExecutionTask
  scriptRevision?: ScriptRevision
  attempts: readonly ExecutionAttempt[]
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
