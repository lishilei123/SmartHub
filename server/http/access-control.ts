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

export function createBootstrapAccessControl(production: boolean): AccessControl {
  const subjectId = clean(process.env.SMARTHUB_BOOTSTRAP_SUBJECT_ID, 'local-developer')
  const displayName = clean(process.env.SMARTHUB_BOOTSTRAP_DISPLAY_NAME, '本地开发者')
  const authenticator = new BootstrapAuthenticator({ subjectId, displayName }, production)
  return new StaticAccessControl(authenticator, new StaticProjectVersionAuthorizer([{ subjectId, projectVersionId: '*', permissions: ['*'] }]))
}

export function unauthenticated() { throw new UnauthenticatedError() }

function clean(value: string | undefined, fallback: string) { return value?.trim().slice(0, 200) || fallback }
