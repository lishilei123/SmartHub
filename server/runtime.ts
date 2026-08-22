import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { KnowledgeService } from './application/knowledge-service.js'
import { ModelService } from './application/model-service.js'
import { RequirementAnalysisService } from './application/requirement-analysis-service.js'
import { PiAgentRuntimeAdapter } from './agent/pi-agent-runtime.js'
import { PiSessionRuntime } from './agent/pi-session-runtime.js'
import { ContextManager } from './agent/context-manager.js'
import { LocalModelRuntime } from './infrastructure/local-model-runtime.js'
import { PostgresStore } from './infrastructure/postgres-store.js'
import { RawDocumentStore } from './infrastructure/raw-document-store.js'
import { JsonStore, type StateStore } from './infrastructure/store.js'
import { ProjectVersionService } from './application/project-version-service.js'
import { AgentConfigurationService } from './application/agent-configuration-service.js'
import { AiResourceService } from './application/ai-resource-service.js'
import { SkillPackageStore } from './infrastructure/skill-package-store.js'
import { applicationRoot, dataRoot } from './infrastructure/runtime-paths.js'
import { ReviewGovernanceService } from './application/review-governance-service.js'
import { createBootstrapAccessControl } from './http/access-control.js'
import { TestDesignService } from './application/test-design-service.js'
import { PlanningWorkflowService } from './application/planning-workflow-service.js'
import { PiTestDesignRuntimeAdapter } from './agent/pi-test-design-runtime.js'
import { PiTestExecutionRuntimeAdapter } from './agent/pi-test-execution-runtime.js'
import { TestExecutionService } from './application/test-execution-service.js'
import { TestReportService } from './application/test-report-service.js'
import {
  LocalBaseUrlExecutionEnvironmentResolver,
} from './application/test-execution-environment.js'
import { TestExecutionInfrastructureConfigurationService } from './application/test-execution-infrastructure-configuration-service.js'
import { FrozenTestExecutionWorkspaceProvider } from './application/test-execution-workspace-provider.js'
import { LocalExecutionArtifactStore } from './infrastructure/execution-artifact-store.js'
import { PostgresTestExecutionStore } from './infrastructure/test-execution-store.js'
import {
  type PlaywrightRunner,
} from './runner/playwright-runner.js'
import { LocalWorkspaceRunner } from './runner/local-workspace-runner.js'
import { LocalExecutionWorkspaceStore } from './infrastructure/execution-workspace-store.js'
import { PlaywrightCliAdapter, UIExecutionAgent } from './agent/ui-execution-agent.js'
import { StateStoreTestExecutionKnowledgeResolver } from './application/test-execution-knowledge.js'

const envFile = resolve(applicationRoot, '.env.local')
if (existsSync(envFile)) process.loadEnvFile(envFile)

const dataFile = process.env.SMARTHUB_DATA_FILE ?? resolve(dataRoot, 'smarthub.json')
const documentRoot = process.env.SMARTHUB_DOCUMENT_ROOT ?? resolve(dataRoot, 'knowledge-bases')
const modelRoot = process.env.SMARTHUB_MODEL_ROOT ?? resolve(dataRoot, 'models')
const skillRoot = process.env.SMARTHUB_SKILL_ROOT ?? resolve(dataRoot, 'skills')
const executionArtifactRoot = process.env.SMARTHUB_EXECUTION_ARTIFACT_ROOT
  ?? resolve(dataRoot, 'test-execution-artifacts')
const executionWorkspaceRoot = process.env.SMARTHUB_EXECUTION_WORKSPACE_ROOT
  ?? resolve(dataRoot, 'test-execution-workspaces')
const production = process.env.NODE_ENV === 'production'
const databaseUrl = process.env.SMARTHUB_FORCE_JSON_STORE === 'true' ? undefined : process.env.DATABASE_URL

if (production && !databaseUrl) throw new Error('生产模式必须配置 DATABASE_URL')

export const localModelRuntime = new LocalModelRuntime(modelRoot)
export const stateStore: StateStore = databaseUrl ? new PostgresStore(databaseUrl) : new JsonStore(dataFile)
export const rawDocumentStore = new RawDocumentStore(documentRoot)
export const service = new KnowledgeService(stateStore, rawDocumentStore, localModelRuntime)
export const modelService = new ModelService(stateStore)
export const skillPackageStore = new SkillPackageStore(skillRoot)
export const aiResourceService = new AiResourceService(stateStore, skillPackageStore)
export const agentConfigurationService = new AgentConfigurationService(stateStore)
export const reviewGovernanceService = new ReviewGovernanceService(stateStore)
export const piSessionRuntime = new PiSessionRuntime(resolve(dataRoot, 'pi-sessions'))
export const contextManager = new ContextManager()
export const piAgentRuntime = new PiAgentRuntimeAdapter(
  stateStore,
  {},
  skillPackageStore,
  reviewGovernanceService,
  service,
  piSessionRuntime,
  contextManager,
)
export const requirementAnalysisService = new RequirementAnalysisService(stateStore, piAgentRuntime, agentConfigurationService)
export const testDesignRuntime = new PiTestDesignRuntimeAdapter(stateStore, piAgentRuntime, agentConfigurationService)
export const testDesignService = new TestDesignService(stateStore, testDesignRuntime, service)
export const planningWorkflowService = new PlanningWorkflowService(
  stateStore,
  agentConfigurationService,
  piAgentRuntime,
  requirementAnalysisService,
  testDesignService,
)
requirementAnalysisService.onRequirementReleaseReady(async runId => { await planningWorkflowService.requirementReleaseReady(runId) })
export const executionWorkspaceStore = new LocalExecutionWorkspaceStore(executionWorkspaceRoot)
export const projectVersionService = new ProjectVersionService(stateStore, service, executionWorkspaceStore)
export const accessControl = createBootstrapAccessControl(production)
export const usingPostgres = stateStore instanceof PostgresStore

export const testExecutionInfrastructureConfigurationService =
  new TestExecutionInfrastructureConfigurationService(stateStore)
export const executionEnvironmentCatalog = new LocalBaseUrlExecutionEnvironmentResolver()
export const executionArtifactStore =
  new LocalExecutionArtifactStore(executionArtifactRoot)
export const testExecutionStore = databaseUrl
  ? new PostgresTestExecutionStore(databaseUrl)
  : undefined
export const testExecutionAgentRuntime =
  new PiTestExecutionRuntimeAdapter(
    stateStore,
    piAgentRuntime,
    agentConfigurationService,
  )
export const testExecutionWorkspaceProvider = testExecutionStore
  ? new FrozenTestExecutionWorkspaceProvider(
      testExecutionStore,
      executionArtifactStore,
    )
  : undefined
export const playwrightRunner: PlaywrightRunner = new LocalWorkspaceRunner(executionArtifactStore)
export const uiExecutionAgent = new UIExecutionAgent(new PlaywrightCliAdapter())
export const testExecutionKnowledgeResolver = new StateStoreTestExecutionKnowledgeResolver(stateStore)
export const testExecutionService =
  testExecutionStore && testExecutionWorkspaceProvider
    ? new TestExecutionService(
        testDesignService,
        testExecutionStore,
        testExecutionAgentRuntime,
        executionArtifactStore,
        testExecutionWorkspaceProvider,
        executionEnvironmentCatalog,
        playwrightRunner,
        undefined,
        executionWorkspaceStore,
        uiExecutionAgent,
        testExecutionKnowledgeResolver,
      )
    : undefined
export const testReportService = testExecutionStore
  ? new TestReportService(testExecutionStore)
  : undefined
