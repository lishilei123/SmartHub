export type PageKey = 'dashboard' | 'planning' | 'test-cases' | 'documents' | 'execution' | 'reports' | 'settings'

export type PlanningTab = 'requirements' | 'test-design' | 'workflow'

export type NotifyTone = 'success' | 'error' | 'warning'

export type Notify = (message: string, tone?: NotifyTone) => void

export type JobStatus = 'idle' | 'running' | 'completed' | 'cancelled' | 'failed'
