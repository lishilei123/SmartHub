export type ProjectVersionPermission =
  | 'project-version:create'
  | 'project-version:read'
  | 'project-version:manage'
  | 'requirement-analysis:create'
  | 'requirement-analysis:read'
  | 'requirement-analysis:cancel'
  | 'requirement-analysis:retry'
  | 'requirement-analysis:handle'
  | 'tool:approve'
  | 'audit:read'
  | 'test-design:create'
  | 'test-design:read'
  | 'test-design:cancel'
  | 'test-design:edit'
  | 'test-design:review'
  | 'test-design:publish'
  | 'test-design:export'
  | 'test-execution:create'
  | 'test-execution:read'
  | 'test-execution:cancel'
  | 'test-execution:retry'
  | 'test-execution:download'
  | 'test-execution:maintain'

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
