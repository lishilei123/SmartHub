export type OutputTokenModel = {
  displayName: string
  maxOutputTokens: number
}

export function limitingOutputTokenModel(primary: OutputTokenModel | undefined, fallbacks: OutputTokenModel[], fallbackEnabled: boolean) {
  if (!primary) return undefined
  return [primary, ...(fallbackEnabled ? fallbacks : [])].reduce((limit, model) => model.maxOutputTokens < limit.maxOutputTokens ? model : limit)
}

export function clampOutputTokens(value: number, maximum: number, minimum = 1_024) {
  if (!Number.isFinite(value)) return minimum
  return Math.min(maximum, Math.max(minimum, Math.trunc(value)))
}
