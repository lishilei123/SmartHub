/** v1 Verification Checks are the frozen expectedResults, never titles or steps.
 * Ambiguous prose is not an authorization to accept a routing error.
 */
export function verificationCheckRequiresHttpStatus(description: string, status: number) {
  if (!Number.isInteger(status) || status < 100 || status > 599) return false
  const statusDescription = new RegExp(
    `(?:\\bHTTP(?:\\s+(?:status(?:\\s+code)?|response))?|状态码|响应码|\\b(?:response\\s+)?status(?:\\s+code)?|(?:接口|请求|响应)(?:应当|应该|应|必须)?返回|(?:应当|应该|应|必须)返回|\\b(?:response|request|api)\\s+(?:(?:must|should|shall)\\s+)?returns?)`
    + `\\s*(?:应当为|应该为|应为|必须为|返回|为|是|[:：=]|is|equals?|(?:must|should|shall)\\s+be)?\\s*(?:HTTP\\s*)?${status}(?!\\d|\\s*(?:条|个|records?\\b|items?\\b))`,
    'giu',
  )
  return description.split(/[;；。.!！?？\n]/u).some(sentence => {
    // Keep commas until antecedents have been located: a status inside "if ...,
    // then ..." is a branch condition, not a frozen status requirement.
    const conditions = conditionalRanges(sentence)
    for (const match of sentence.matchAll(statusDescription)) {
      const start = match.index
      const end = start + match[0].length
      if (conditions.some(range => start < range.end && end > range.start)) continue
      const suffix = sentence.slice(end)
      if (/^\s*(?:时(?:候)?|的话|则|除外|\b(?:then|except|excluded)\b|\b(?:(?:is|was)\s+)?not\s+(?:required|expected)\b)/iu.test(suffix)) continue

      // Scope negation/uncertainty to this status predicate. A later obligation
      // such as "不得泄露信息" must not negate a preceding explicit HTTP 404.
      const previous = sentence.slice(0, start)
      const boundary = Math.max(
        0,
        ...conditions.filter(range => range.end <= start).map(range => range.end),
        ...[...sentence.slice(0, end).matchAll(/时(?:候)?(?=\s*(?:应当|应该|应|必须))/gu)]
          .map(part => part.index + part[0].length).filter(position => position <= start),
        ...[...previous.matchAll(/[,，]|并且|而且|同时|且|\b(?:and|but)\b/giu)].map(part => part.index + part[0].length),
      )
      const prefix = sentence.slice(boundary, start)
      if (/(?:不应|不得|不能|不返回|不是|不为|不可|不要求|未要求|不必|无需|无须|禁止|排除|除外|非|可能|也许|或许|例如|比如|\b(?:not|never|except|exclude\w*|may|might|could|possibly)\b|\bno\s+(?:requirement|need)\b)/iu.test(prefix + match[0])) continue
      // An alternative set does not freeze either individual status.
      if (/^\s*(?:[/／、]|或(?:者)?|\bor\b)\s*(?:HTTP\s*)?[1-5]\d{2}/iu.test(suffix)
        || /[1-5]\d{2}\s*(?:[/／、]|或(?:者)?|\bor\b)\s*$/iu.test(prefix)) continue
      return true
    }
    return false
  })
}

function conditionalRanges(sentence: string) {
  const ranges: Array<{ start: number; end: number }> = []
  for (const marker of sentence.matchAll(/如果|假如|若|(?<!应)当(?!然)|\b(?:if|when|unless)\b/giu)) {
    const afterMarker = marker.index + marker[0].length
    const remainder = sentence.slice(afterMarker)
    // Prefer an explicit result introducer over commas inside the condition.
    // Without a supported boundary, conservatively keep the rest conditional.
    const boundary = /则|\bthen\b/iu.exec(remainder) ?? /时(?:候)?|[,，]/u.exec(remainder)
    // A repeated response subject plus an obligation is also a bounded result
    // form when punctuation is omitted; it must follow a nonempty condition.
    const result = !boundary
      ? /(?:接口|请求|响应)(?:状态码)?(?:应当|应该|应|必须)(?:返回|为)|\b(?:the\s+)?(?:response(?:\s+status(?:\s+code)?)?|status(?:\s+code)?)\s+(?:must|should|shall)\s+(?:be|return)\b/iu.exec(remainder)
      : null
    ranges.push({
      start: marker.index,
      end: boundary ? afterMarker + boundary.index + boundary[0].length
        : result && remainder.slice(0, result.index).trim() ? afterMarker + result.index : sentence.length,
    })
  }
  return ranges
}
