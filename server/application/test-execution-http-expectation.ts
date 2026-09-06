/** v1 Verification Checks are the frozen expectedResults, never titles or steps.
 * Ambiguous prose is not an authorization to accept a routing error.
 */
export function verificationCheckRequiresHttpStatus(description: string, status: number) {
  return description.split(/[,，;；。\n]/u).some(clause => {
    if (/(?:不应|不得|不能|不返回|不是|排除|除外|非|not\b|except\b|exclude\w*|如果|若|当|\bif\b)/iu.test(clause)) return false
    return new RegExp(`(?:\\bHTTP(?:\\s+(?:status(?:\\s+code)?|response))?|状态码|响应码|status(?:\\s+code)?|(?:接口|请求|响应)(?:应|必须)?返回)\\s*(?:应为|必须为|返回|为|是|为：|[:：=]|is|equals?|must\\s+be)?\\s*${status}(?!\\d|\\s*(?:条|个))`, 'iu').test(clause)
  })
}
