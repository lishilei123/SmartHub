import type { AgentModelConnection, ReviewRunSnapshot } from './agent-types.js'
import type { CandidateReviewResult } from './review-types.js'

export interface ReviewQuestionQuote {
  text: string
  assetVersionId: string
  heading: string
  startLine?: number
  endLine?: number
  findingId?: string
}

export interface ReviewAnswerCandidate {
  answer: string
  citations: string[]
  limitations: string[]
}

export interface ReviewQaExecutionInput {
  question: string
  quote?: ReviewQuestionQuote
  snapshot: ReviewRunSnapshot
  reviewResult: CandidateReviewResult
  documentContent: string
  model: AgentModelConnection
}

export interface ReviewQaRuntime {
  answer(input: ReviewQaExecutionInput, signal: AbortSignal): Promise<ReviewAnswerCandidate>
}

