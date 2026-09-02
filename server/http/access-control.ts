import { timingSafeEqual } from 'node:crypto'
import type { IncomingMessage } from 'node:http'
import { ForbiddenError, UnauthenticatedError, type Principal, type ProjectVersionPermission } from '../domain/access-control.js'

export interface RequestAuthenticator {
  authenticate(request: IncomingMessage): Promise<Principal>
}

export interface ProjectVersionAuthorizer {
  require(principal: Principal, projectVersionId: string, permission: ProjectVersionPermission): Promise<void>
  can(principal: Principal, projectVersionId: string, permission: ProjectVersionPermission): Promise<boolean>
}

export interface AccessControl {
  authenticate(request: IncomingMessage): Promise<Principal>
  authorize(principal: Principal, projectVersionId: string, permission: ProjectVersionPermission): Promise<void>
  canAccess(principal: Principal, projectVersionId: string, permission: ProjectVersionPermission): Promise<boolean>
}

export type StaticProjectVersionGrant = {
  subjectId: string
  projectVersionId: string | '*'
  permissions: Array<ProjectVersionPermission | '*'>
}

export class StaticAccessControl implements AccessControl {
  constructor(
    private readonly authenticator: RequestAuthenticator,
    private readonly authorizer: ProjectVersionAuthorizer,
  ) {}

  authenticate(request: IncomingMessage) { return this.authenticator.authenticate(request) }
  authorize(principal: Principal, projectVersionId: string, permission: ProjectVersionPermission) { return this.authorizer.require(principal, projectVersionId, permission) }
  canAccess(principal: Principal, projectVersionId: string, permission: ProjectVersionPermission) { return this.authorizer.can(principal, projectVersionId, permission) }
}

export class BootstrapAuthenticator implements RequestAuthenticator {
  constructor(private readonly principal: Principal, production: boolean) {
    if (production) throw new Error('生产模式必须接入可信身份认证适配器，不能使用 bootstrap 身份')
  }

  async authenticate() { return this.principal }
}

export class StaticProjectVersionAuthorizer implements ProjectVersionAuthorizer {
  constructor(private readonly grants: StaticProjectVersionGrant[]) {}

  async require(principal: Principal, projectVersionId: string, permission: ProjectVersionPermission) {
    if (!await this.can(principal, projectVersionId, permission)) throw new ForbiddenError()
  }

  async can(principal: Principal, projectVersionId: string, permission: ProjectVersionPermission) {
    return this.grants.some(grant => grant.subjectId === principal.subjectId
      && (grant.projectVersionId === '*' || grant.projectVersionId === projectVersionId)
      && (grant.permissions.includes('*') || grant.permissions.includes(permission)))
  }
}

/**
 * Production identity adapter for a loopback API placed behind a trusted
 * reverse proxy. The proxy must remove incoming SMARTHUB headers and inject
 * them only after it has authenticated the request.
 */
export class TrustedProxyAuthenticator implements RequestAuthenticator {
  constructor(private readonly sharedSecret: string) {
    if (Buffer.byteLength(sharedSecret, 'utf8') < 32) {
      throw new Error('SMARTHUB_TRUSTED_PROXY_SECRET 至少需要 32 字节')
    }
  }

  async authenticate(request: IncomingMessage) {
    const suppliedSecret = singleHeader(request, 'x-smarthub-proxy-secret')
    if (!suppliedSecret || !secretEquals(suppliedSecret, this.sharedSecret)) unauthenticated()
    const subjectId = requiredHeader(request, 'x-smarthub-subject-id', 200)
    const displayName = optionalHeader(request, 'x-smarthub-display-name', 200) ?? subjectId
    return { subjectId, displayName }
  }
}

/** V1 boundary: authenticate every request; project RBAC is added separately. */
export class AuthenticatedProjectVersionAuthorizer implements ProjectVersionAuthorizer {
  async require(principal: Principal) {
    if (!principal.subjectId) throw new ForbiddenError()
  }

  async can(principal: Principal) { return Boolean(principal.subjectId) }
}

export function createBootstrapAccessControl(production: boolean): AccessControl {
  const subjectId = clean(process.env.SMARTHUB_BOOTSTRAP_SUBJECT_ID, 'local-developer')
  const displayName = clean(process.env.SMARTHUB_BOOTSTRAP_DISPLAY_NAME, '本地开发者')
  const authenticator = new BootstrapAuthenticator({ subjectId, displayName }, production)
  return new StaticAccessControl(authenticator, new StaticProjectVersionAuthorizer([{ subjectId, projectVersionId: '*', permissions: ['*'] }]))
}

export function createEnvironmentAccessControl(
  environment: NodeJS.ProcessEnv = process.env,
): AccessControl {
  const production = environment.NODE_ENV === 'production'
  if (!production) return createBootstrapAccessControl(false)
  const sharedSecret = environment.SMARTHUB_TRUSTED_PROXY_SECRET?.trim()
  if (!sharedSecret) {
    throw new Error('生产 API 必须配置 SMARTHUB_TRUSTED_PROXY_SECRET')
  }
  return new StaticAccessControl(
    new TrustedProxyAuthenticator(sharedSecret),
    new AuthenticatedProjectVersionAuthorizer(),
  )
}

export function unauthenticated(): never { throw new UnauthenticatedError() }

function clean(value: string | undefined, fallback: string) { return value?.trim().slice(0, 200) || fallback }

function singleHeader(request: IncomingMessage, name: string) {
  const value = request.headers[name]
  return Array.isArray(value) ? undefined : value?.trim()
}

function requiredHeader(request: IncomingMessage, name: string, maxLength: number) {
  const value = optionalHeader(request, name, maxLength)
  if (!value) unauthenticated()
  return value
}

function optionalHeader(request: IncomingMessage, name: string, maxLength: number) {
  const value = singleHeader(request, name)
  if (!value || value.length > maxLength || /[\u0000-\u001f\u007f]/u.test(value)) return undefined
  return value
}

function secretEquals(left: string, right: string) {
  const leftBuffer = Buffer.from(left, 'utf8')
  const rightBuffer = Buffer.from(right, 'utf8')
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer)
}
