export type ReviewRunIdentity = { id?: string; runId?: string }

export function resolveReviewRunId(run: ReviewRunIdentity | null | undefined) {
  return run?.id ?? run?.runId ?? ''
}

export function persistedRunningReviewRunIds(runs: Array<ReviewRunIdentity & { status: string }>) {
  return [...new Set(runs
    .filter(run => run.status === 'running')
    .map(resolveReviewRunId)
    .filter(runId => runId && !runId.startsWith('pending-')))]
}
