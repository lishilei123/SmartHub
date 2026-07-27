export interface ReviewSubmissionFeedback {
  accepted: boolean
  issues?: Array<{ path: string; message: string }>
}
