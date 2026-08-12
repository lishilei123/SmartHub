/**
 * Repair and release submissions are registered dynamically by the generic
 * workspace registry because their validators are owned by the Workflow Stage.
 * This module is the governed source anchor referenced by the built-in catalog.
 */
export const requirementWorkflowSubmitHandlers = ['requirement-repair.submit_result', 'requirement-release.submit_result'] as const
