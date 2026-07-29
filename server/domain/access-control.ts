export type ProjectVersionPermission =
  | 'project-version:create'
  | 'project-version:read'
  | 'project-version:manage'
  | 'review:create'
  | 'review:read'
  | 'review:cancel'
  | 'review:retry'
  | 'review:handle'
  | 'tool:approve'
  | 'audit:read'

export interface Principal {
  subjectId: string
  displayName: string
}

export class UnauthenticatedError extends Error {
  constructor(message = 'UNAUTHENTICATED') {
    super(message)
    this.name = 'UnauthenticatedError'
  }
}

export class ForbiddenError extends Error {
  constructor(message = 'FORBIDDEN') {
    super(message)
    this.name = 'ForbiddenError'
  }
}
