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
}
