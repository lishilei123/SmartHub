import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { KnowledgeService } from './application/knowledge-service.js'
import { ModelService } from './application/model-service.js'
import { RequirementAnalysisService } from './application/requirement-analysis-service.js'
import { PiAgentRuntimeAdapter } from './agent/pi-agent-runtime.js'
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
import { PiTestDesignRuntimeAdapter } from './agent/pi-test-design-runtime.js'
import { PiTestExecutionRuntimeAdapter } from './agent/pi-test-execution-runtime.js'
import { TestExecutionService } from './application/test-execution-service.js'
import { TestReportService } from './application/test-report-service.js'
import {
  ConfiguredExecutionEnvironmentCatalog,
  executionEnvironmentProfilesFromJson,
} from './application/test-execution-environment.js'
import { FrozenTestExecutionWorkspaceProvider } from './application/test-execution-workspace-provider.js'
import { LocalExecutionArtifactStore } from './infrastructure/execution-artifact-store.js'
import { PostgresTestExecutionStore } from './infrastructure/test-execution-store.js'
import { OciExecutionSandbox } from './runner/execution-sandbox.js'
import {
  OciPlaywrightRunner,
  type PlaywrightRunner,
} from './runner/playwright-runner.js'

const envFile = resolve(applicationRoot, '.env.local')
if (existsSync(envFile)) process.loadEnvFile(envFile)

const dataFile = process.env.SMARTHUB_DATA_FILE ?? resolve(dataRoot, 'smarthub.json')
const documentRoot = process.env.SMARTHUB_DOCUMENT_ROOT ?? resolve(dataRoot, 'knowledge-bases')
const modelRoot = process.env.SMARTHUB_MODEL_ROOT ?? resolve(dataRoot, 'models')
const skillRoot = process.env.SMARTHUB_SKILL_ROOT ?? resolve(dataRoot, 'skills')
const executionArtifactRoot = process.env.SMARTHUB_EXECUTION_ARTIFACT_ROOT
  ?? resolve(dataRoot, 'test-execution-artifacts')
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
export const piAgentRuntime = new PiAgentRuntimeAdapter(stateStore, {}, skillPackageStore, reviewGovernanceService)
export const requirementAnalysisService = new RequirementAnalysisService(stateStore, piAgentRuntime, agentConfigurationService, service)
export const testDesignRuntime = new PiTestDesignRuntimeAdapter(stateStore, piAgentRuntime, agentConfigurationService)
export const testDesignService = new TestDesignService(stateStore, testDesignRuntime, service)
export const projectVersionService = new ProjectVersionService(stateStore)
export const accessControl = createBootstrapAccessControl(production)
export const usingPostgres = stateStore instanceof PostgresStore

export const executionEnvironmentCatalog =
  new ConfiguredExecutionEnvironmentCatalog(
    executionEnvironmentProfilesFromJson(
      process.env.SMARTHUB_TEST_EXECUTION_ENVIRONMENTS,
    ),
  )
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
function createPlaywrightRunner(): PlaywrightRunner {
  const runnerVersion = process.env.SMARTHUB_RUNNER_VERSION
  const playwrightVersion = process.env.SMARTHUB_PLAYWRIGHT_VERSION
  const imageReference = process.env.SMARTHUB_RUNNER_IMAGE
  const imageDigest = process.env.SMARTHUB_RUNNER_IMAGE_DIGEST
  const runtimeExecutable = process.env.SMARTHUB_CONTAINER_RUNTIME
  if (
    runnerVersion
    && playwrightVersion
    && imageReference
    && imageDigest
    && runtimeExecutable
  ) {
    return new OciPlaywrightRunner(
      new OciExecutionSandbox({
        runtimeExecutable,
        imageReference,
        imageDigest,
        runnerVersion,
        playwrightVersion,
        networkPolicies: executionEnvironmentCatalog.networkPolicies(),
        ...(process.env.SMARTHUB_RUNNER_ENTRYPOINT
          ? { entrypoint: process.env.SMARTHUB_RUNNER_ENTRYPOINT }
          : {}),
        ...(process.env.SMARTHUB_RUNNER_WORK_ROOT
          ? { workingRoot: process.env.SMARTHUB_RUNNER_WORK_ROOT }
          : {}),
      }, executionArtifactStore),
      executionEnvironmentCatalog,
    )
  }
  return new UnavailablePlaywrightRunner({
    runnerVersion: runnerVersion ?? 'unconfigured',
    playwrightVersion: playwrightVersion ?? 'unconfigured',
    imageReference: imageReference ?? 'unconfigured',
    imageDigest: imageDigest ?? `sha256:${'0'.repeat(64)}`,
  })
}

class UnavailablePlaywrightRunner implements PlaywrightRunner {
  constructor(
    private readonly value: ReturnType<PlaywrightRunner['snapshot']>,
  ) {}

  snapshot() {
    return structuredClone(this.value)
  }

  async readiness() {
    return {
      ready: false,
      reason: 'TEST_EXECUTION_RUNNER_UNAVAILABLE: OCI Runner 配置不完整',
      snapshot: this.snapshot(),
    }
  }

  async execute(): Promise<never> {
    throw new Error(
      'TEST_EXECUTION_RUNNER_UNAVAILABLE: 禁止降级为宿主执行',
    )
  }
}

export const playwrightRunner: PlaywrightRunner =
  createPlaywrightRunner()
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
      )
    : undefined
export const testReportService = testExecutionStore
  ? new TestReportService(testExecutionStore)
  : undefined
