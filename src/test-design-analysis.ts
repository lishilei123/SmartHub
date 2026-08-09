export interface TestAnalysisDisplayGroup {
  key: string
  items: unknown[]
}

function recordOf(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

export function normalizeTestAnalysisGroups(value: unknown): TestAnalysisDisplayGroup[] {
  const content = recordOf(value)
  const groups = new Map<string, unknown[]>()
  const seenFields = new Set<string>(['schemaVersion', 'findings'])
  const add = (key: string, candidate: unknown) => {
    const items = Array.isArray(candidate) ? candidate : candidate === undefined || candidate === null || candidate === '' ? [] : [candidate]
    if (!items.length) return
    const current = groups.get(key) ?? []
    const fingerprints = new Set(current.map(item => JSON.stringify(item)))
    for (const item of items) {
      const fingerprint = JSON.stringify(item)
      if (!fingerprints.has(fingerprint)) {
        current.push(item)
        fingerprints.add(fingerprint)
      }
    }
    groups.set(key, current)
  }
  const aliases: Array<[string, string]> = [
    ['coverageUnits', 'coverageUnits'], ['features', 'features'], ['rules', 'rules'], ['constraints', 'constraints'],
    ['states', 'states'], ['state', 'states'], ['transitions', 'transitions'], ['roles', 'roles'], ['actors', 'roles'],
    ['entities', 'entities'], ['terms', 'terms'], ['actions', 'actions'], ['interfaces', 'interfaces'],
    ['assertions', 'assertions'], ['oracles', 'assertions'], ['verificationOracles', 'assertions'], ['risks', 'risks'],
    ['pendingItems', 'pendingItems'], ['confirmationItems', 'pendingItems'],
  ]

  const scope = content.scope
  seenFields.add('scope')
  if (typeof scope === 'string') add('scopeSummary', scope)
  else {
    const scopeValue = recordOf(scope)
    const scopeAliases: Array<[string, string]> = [['summary', 'scopeSummary'], ['objectives', 'objectives'], ['inclusions', 'inclusions'], ['exclusions', 'exclusions']]
    for (const [field, key] of scopeAliases) if (field in scopeValue) add(key, scopeValue[field])
    for (const [field, item] of Object.entries(scopeValue)) if (!scopeAliases.some(([known]) => known === field) && Array.isArray(item)) add(field, item)
  }
  for (const [field, key] of aliases) {
    seenFields.add(field)
    if (field in content) add(key, content[field])
  }
  for (const [field, item] of Object.entries(content)) if (!seenFields.has(field) && Array.isArray(item)) add(field, item)
  return [...groups.entries()].map(([key, items]) => ({ key, items }))
}
