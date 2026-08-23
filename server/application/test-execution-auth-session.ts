import { createHash } from 'node:crypto'
import type { ExecutionTask } from '../domain/test-execution-types.js'

export type AuthSessionMode =
  | 'reuse_authenticated'
  | 'fresh_anonymous'
  | 'isolated_role'
  | 'custom'

export interface AuthSessionPolicy {
  mode: AuthSessionMode
  /** Non-secret logical identity used to separate Run-scoped state files. */
  role?: string
  /** Safe filename key. It never contains an account, password, cookie or token. */
  stateKey?: string
}

export interface RuntimeAuthStateScope {
  projectVersionId: string
  runId: string
  environmentSignature: string
  baseUrl: string
  role: string
  stateKey: string
}

/** Sensitive paths and callbacks remain inside Runtime and are never projected to Agent input. */
export interface RuntimeAuthStateAccess {
  loadPath?: string
  savePath?: string
  commit?(): Promise<void>
  discard?(): Promise<void>
}

/**
 * Determines browser authentication authority from the frozen TestCase only.
 * Agent output, Task order and an existing state file never influence policy.
 */
export function resolveAuthSessionPolicy(
  input: Pick<ExecutionTask['input'], 'caseId' | 'caseContent' | 'executionSpec' | 'testDataBindings'>,
): AuthSessionPolicy {
  const testCase = input.caseContent
  const intent = normalizedIntent([
    testCase.title,
    ...testCase.steps,
    ...testCase.expectedResults,
    JSON.stringify(input.executionSpec ?? {}),
    JSON.stringify(input.testDataBindings ?? []),
  ])
  const preconditions = normalizedIntent(testCase.preconditions)
  const role = authenticatedRole(preconditions, intent)

  if (customAuthenticationIntent(intent)) return { mode: 'custom' }
  if (authenticatedIsolationIntent(intent)) {
    return { mode: 'isolated_role', role: role.role, stateKey: role.stateKey }
  }
  if (freshAuthenticationIntent(intent)) return { mode: 'fresh_anonymous' }
  if (authenticatedPrecondition(preconditions)) {
    return { mode: 'reuse_authenticated', role: role.role, stateKey: role.stateKey }
  }
  return { mode: 'fresh_anonymous' }
}

function normalizedIntent(values: readonly string[]) {
  return values
    .join('\n')
    .toLocaleLowerCase()
    // A business Case may state "after login" without testing authentication.
    .replace(/(?:成功)?登录后|完成登录后|在已登录状态下|after\s+(?:logging\s+in|login)|once\s+authenticated/giu, '')
}

function authenticatedPrecondition(value: string) {
  return /(?:已登录|登录状态|已认证|authenticated|signed[ -]?in|logged[ -]?in)/iu.test(value)
}

function freshAuthenticationIntent(value: string) {
  return /(?:登录成功|登录失败|密码错误|用户名错误|账号不存在|验证码错误|账号锁定|登录安全|未登录|未授权|未经认证|匿名访问|公开(?:注册|登录|首页|页面)|\blog\s*in\b|\blogin\b|sign[ -]?in|unauthenticated|unauthori[sz]ed|anonymous|public\s+(?:registration|login|home|page)|invalid\s+(?:password|username)|account\s+lock)/iu.test(value)
}

function authenticatedIsolationIntent(value: string) {
  return /(?:退出登录|登出|会话(?:超时|失效|过期)|session\s*(?:timeout|invalid|expir)|token\s*(?:过期|失效|expir|invalid)|cookie\s*(?:过期|失效|expir|invalid)|普通用户.*(?:管理员|管理页面)|越权|无权访问|权限不足|\blogout\b|sign[ -]?out|access\s+denied|forbidden)/iu.test(value)
}

function customAuthenticationIntent(value: string) {
  return /(?:权限切换|角色切换|账号隔离|多账号登录|并发登录|异地登录|多会话|role\s*switch|account\s*isolation|multi[- ]?(?:account|session)|concurrent\s+login|remote\s+login)/iu.test(value)
}

function authenticatedRole(preconditions: string, intent: string) {
  const source = `${preconditions}\n${intent}`
  if (/(?:普通用户|标准用户|regular\s+user|standard\s+user|member)/iu.test(source)) {
    return { role: 'user', stateKey: 'user' }
  }
  if (/(?:管理员|administrator|\badmin\b)/iu.test(source)) {
    return { role: 'admin', stateKey: 'admin' }
  }
  const named = /([\p{L}\p{N}_-]{1,24})(?:角色)?(?:用户)?(?:已登录|已认证|authenticated|signed[ -]?in|logged[ -]?in)/iu.exec(preconditions)?.[1]
  if (named && !/^(?:用户|账号|账户|user|account)$/iu.test(named)) {
    const normalized = named.toLocaleLowerCase()
    return {
      role: normalized,
      stateKey: /^[a-z0-9._-]{1,40}$/u.test(normalized)
        ? normalized
        : `role-${hash(normalized).slice(0, 16)}`,
    }
  }
  return { role: 'default', stateKey: 'default' }
}

function hash(value: string) {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}
