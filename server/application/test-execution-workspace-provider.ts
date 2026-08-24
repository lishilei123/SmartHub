import { createHash } from 'node:crypto'
import type { TestExecutionAgentWorkspaceProjection } from '../domain/agent-types.js'
import type { ExecutionRun, ExecutionTask } from '../domain/test-execution-types.js'
import { canonicalJson } from './canonical-json.js'
import type { TestExecutionWorkspaceProvider } from './test-execution-service.js'

export class FrozenTestExecutionWorkspaceProvider implements TestExecutionWorkspaceProvider {
  async project(input: { run: ExecutionRun; task: ExecutionTask }): Promise<TestExecutionAgentWorkspaceProjection> {
    if (input.task.runId !== input.run.id) throw new Error('TEST_EXECUTION_WORKSPACE_TASK_SCOPE_INVALID')
    const rootLogicalPath = `test-execution/${input.run.id}/${input.task.id}`
    const files = [
      workspaceJson(`${rootLogicalPath}/run.json`, '冻结 Agent Test Run', frozenRunView(input.run)),
      workspaceJson(`${rootLogicalPath}/task.json`, '冻结 Agent Test Task', input.task),
    ]
    return {
      runId: input.run.id,
      taskId: input.task.id,
      projectId: input.run.projectId,
      projectName: input.run.projectId,
      projectVersionId: input.run.projectVersionId,
      projectVersionName: input.run.projectVersionId,
      knowledgeBaseId: input.run.knowledge?.knowledgeBaseId ?? `agent-test:${input.run.projectId}`,
      indexVersionId: input.run.knowledge?.indexVersionId ?? `agent-test:${input.run.handoff.handoffSha256}`,
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
      workspaceFiles: files,
    }
  }
}

function frozenRunView(run: ExecutionRun) {
  return {
    id: run.id,
    projectId: run.projectId,
    projectVersionId: run.projectVersionId,
    handoff: run.handoff,
    agentUnderTest: run.agentUnderTest,
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

function workspaceJson(logicalPath: string, displayName: string, value: unknown) {
  const content = canonicalJson(value)
  return {
    logicalPath,
    displayName,
    content,
    contentSha256: createHash('sha256').update(content, 'utf8').digest('hex'),
  }
}
