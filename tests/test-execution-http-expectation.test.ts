import assert from 'node:assert/strict'
import test from 'node:test'
import { verificationCheckRequiresHttpStatus } from '../server/application/test-execution-http-expectation.js'

for (const status of [404, 405]) {
  test(`冻结 HTTP ${status} 预期与业务数字、否定和条件描述分离`, () => {
    for (const description of [`接口返回 HTTP ${status}`, `响应状态码为 ${status}，不得返回用户数据`, `接口返回${status}`, `HTTP status must be ${status}`]) {
      assert.equal(verificationCheckRequiresHttpStatus(description, status), true, description)
    }
    for (const description of [`编号${status}的资源正常显示`, `HTTP 状态码不得为 ${status}`, `响应不是 HTTP ${status}`, `接口返回${status}条记录`, `如果返回 HTTP ${status} 则显示错误`, `排除 HTTP ${status}`]) {
      assert.equal(verificationCheckRequiresHttpStatus(description, status), false, description)
    }
  })

  test(`冻结 HTTP ${status} 业务条件结果不受逗号影响，局部否定不会覆盖状态预期`, () => {
    for (const description of [
      `当资源不存在时，接口返回 HTTP ${status}。`,
      `当资源不存在时接口返回 HTTP ${status}。`,
      `如果请求的方法不受支持，则响应状态码应为 ${status}。`,
      `如果请求的方法不受支持则响应状态码应为 ${status}。`,
      `若资源不存在，响应状态码应为${status}`,
      `若资源不存在响应状态码应为${status}`,
      `资源不存在时应返回${status}。`,
      `资源不可见时应返回${status}。`,
      `资源不存在时，应返回${status}。`,
      `When the resource does not exist, the response status must be ${status}.`,
      `When the resource does not exist the response status must be ${status}.`,
      `If the method is unsupported, the response status must be ${status}.`,
      `If the method is unsupported then the response status must be ${status}.`,
      `If the method is unsupported the response status must be ${status}.`,
      `The response status must be ${status} when the resource does not exist.`,
      `The response status must be ${status} if the resource does not exist.`,
      `当资源不存在时接口返回 HTTP ${status} 且不得泄露信息`,
      `资源不存在时应返回${status}，不得泄露信息`,
      `接口返回 HTTP ${status} and must not disclose information`,
      `页面不得泄露信息，接口返回 HTTP ${status}`,
    ]) {
      assert.equal(verificationCheckRequiresHttpStatus(description, status), true, description)
    }
  })

  test(`冻结 HTTP ${status} 分支条件、否定和含糊描述不会授权状态码`, () => {
    for (const description of [
      `如果返回 HTTP ${status}，则显示错误提示。`,
      `如果返回 HTTP ${status}则显示错误提示。`,
      `当接口返回${status}时，页面展示错误。`,
      `当接口返回${status}时页面展示错误。`,
      `接口返回 HTTP ${status}时，页面展示错误。`,
      `When the response status is ${status}, show an error.`,
      `If the response status is ${status} then show an error.`,
      `If the response status must be ${status} show an error.`,
      `若响应状态码应为${status}页面展示错误`,
      `Show an error when the response status is ${status}.`,
      `Show an error if the response status is ${status}.`,
      `接口不得返回${status}。`,
      `资源不存在时不应返回 HTTP ${status}`,
      `响应状态码应不为 ${status}`,
      `The response must not return HTTP ${status}.`,
      `The response status must not be ${status}.`,
      `响应不应当返回 HTTP ${status}`,
      `不要求返回 HTTP ${status}`,
      `接口无需返回 HTTP ${status}`,
      `接口不必返回 HTTP ${status}`,
      `There is no requirement to return HTTP ${status}.`,
      `HTTP ${status} is not required.`,
      `排除 HTTP 404/405。`,
      `HTTP ${status} 除外`,
      `编号${status}的资源正常显示。`,
      `接口返回${status}条记录。`,
      `接口返回 HTTP ${status} 个记录`,
      `The response returns ${status} records.`,
      `接口可能返回 HTTP ${status}`,
      `接口返回 HTTP 404 或 HTTP 405`,
      `响应状态码为 404/405`,
      `如果返回 HTTP 404，或者 HTTP 405，则显示错误`,
    ]) {
      assert.equal(verificationCheckRequiresHttpStatus(description, status), false, description)
    }
  })
}
