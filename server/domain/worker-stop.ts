export type WorkerStopReason = 'user_cancelled' | 'lease_lost' | 'heartbeat_unavailable' | 'worker_shutdown'

export type LeaseRenewResult = { status: 'renewed' | 'cancel_requested' | 'lease_lost' }

export class WorkerStoppedError extends Error {
  constructor(readonly reason: WorkerStopReason, options?: ErrorOptions) {
    super(`WORKER_STOPPED: ${reason}`, options)
    this.name = 'WorkerStoppedError'
  }
}

/** An unclassified abort must never manufacture a database cancellation fact. */
export function workerStopReason(signal?: AbortSignal): WorkerStopReason | undefined {
  if (!signal?.aborted) return undefined
  return signal.reason instanceof WorkerStoppedError ? signal.reason.reason : 'heartbeat_unavailable'
}

export function throwIfWorkerStopped(signal?: AbortSignal) {
  if (signal?.aborted) throw signal.reason instanceof WorkerStoppedError
    ? signal.reason : new WorkerStoppedError('heartbeat_unavailable', { cause: signal.reason })
}

export function throwIfInfrastructureStopped(signal?: AbortSignal) {
  const reason = workerStopReason(signal)
  if (reason && reason !== 'user_cancelled') throwIfWorkerStopped(signal)
}
