import { posix } from 'node:path'
import { parse } from '@babel/parser'
import type { Node } from '@babel/types'

type FunctionValue = { kind: 'function'; node: Node; module: string; scope: Scope; receiver?: Value }
type Value = { kind: 'page' | 'request' | 'ui' | 'locator' | 'response' | 'data'; read?: number }
  | FunctionValue
  | { kind: 'class'; node: Node; module: string }
  | { kind: 'object'; members: Map<string, Value>; declaration?: Value }
type Scope = Map<string, Value>
export interface ExecutionSourceProof {
  navigation: boolean
  interactionBeforeNavigation: boolean
  uiAssertionKeys: Set<string>
  persistedAssertionKeys: Set<string>
}

/** Deliberately bounded interpretation of managed, straight-line calls. Unknown
 * control flow, dynamic dispatch and uncalled function bodies prove nothing. */
export function proveExecutionSource(input: {
  files: readonly { path: string; content: string }[]
  entrypoint: string
  callback: Node
  method: 'ui' | 'api'
}): ExecutionSourceProof {
  const modules = new Map(input.files.map(file => [file.path, parse(file.content, { sourceType: 'module', plugins: ['typescript', 'jsx'] })]))
  const scopes = new Map<string, Scope>()
  const invalidated = new WeakSet<Value>()
  const result: ExecutionSourceProof = { navigation: false, interactionBeforeNavigation: false, uiAssertionKeys: new Set(), persistedAssertionKeys: new Set() }
  let sequence = 0
  let mutation = -1
  let uiRead = -1
  let depth = 0
  let activeAnchor: string | undefined

  function resolveModule(from: string, specifier: string) {
    const base = posix.normalize(posix.join(posix.dirname(from), specifier))
    const stem = base.replace(/\.(?:mjs|cjs|js)$/u, '')
    return [base, `${base}.ts`, `${base}.tsx`, `${stem}.ts`, `${stem}.tsx`, `${base}/index.ts`, `${base}/index.tsx`].find(path => modules.has(path))
  }

  function moduleScope(path: string): Scope {
    const existing = scopes.get(path)
    if (existing) return existing
    const scope: Scope = new Map()
    scopes.set(path, scope)
    for (const statement of modules.get(path)?.program.body ?? []) {
      if (statement.type === 'ImportDeclaration' && statement.source.value.startsWith('.')) {
        const target = resolveModule(path, statement.source.value)
        if (!target) continue
        for (const item of statement.specifiers) {
          const exported = item.type === 'ImportSpecifier' ? name(item.imported) : item.type === 'ImportDefaultSpecifier' ? 'default' : undefined
          const value = exported ? moduleScope(target).get(exported) : undefined
          if (value) scope.set(item.local.name, value)
        }
        continue
      }
      const declaration = statement.type === 'ExportNamedDeclaration' || statement.type === 'ExportDefaultDeclaration' ? statement.declaration : statement
      if (!declaration) continue
      if (declaration.type === 'FunctionDeclaration' && declaration.id) {
        const value: Value = { kind: 'function', node: declaration, module: path, scope }
        scope.set(declaration.id.name, value)
        if (statement.type === 'ExportDefaultDeclaration') scope.set('default', value)
      } else if (declaration.type === 'ClassDeclaration' && declaration.id) {
        const value: Value = { kind: 'class', node: declaration, module: path }
        scope.set(declaration.id.name, value)
        if (statement.type === 'ExportDefaultDeclaration') scope.set('default', value)
      } else if (declaration.type === 'VariableDeclaration') {
        for (const item of declaration.declarations) {
          if (item.id.type === 'Identifier' && item.init && ['ArrowFunctionExpression', 'FunctionExpression'].includes(item.init.type)) {
            scope.set(item.id.name, { kind: 'function', node: item.init, module: path, scope })
          }
        }
      }
    }
    return scope
  }

  function bind(parameter: Node, value: Value | undefined, scope: Scope) {
    if (parameter.type === 'TSParameterProperty') return bind(parameter.parameter, value, scope)
    if (parameter.type === 'Identifier' && value) scope.set(parameter.name, value)
    if (parameter.type === 'AssignmentPattern') bind(parameter.left, value, scope)
  }

  function invoke(value: FunctionValue, args: Array<Value | undefined>) {
    if (++depth > 16) { depth--; return undefined }
    const scope = new Map(value.scope)
    if (value.receiver) scope.set('this', value.receiver)
    const node = value.node
    if ('params' in node && Array.isArray(node.params)) {
      node.params.forEach((parameter, index) => bind(parameter, args[index], scope))
    }
    const returned = 'body' in node && node.body ? evaluateBody(node.body as Node, scope, value.module).value : undefined
    depth--
    return returned
  }

  function evaluateBody(node: Node, scope: Scope, module: string): { returned?: boolean; value?: Value } {
    if (node.type !== 'BlockStatement') return { returned: true, value: evaluate(node, scope, module, true) }
    for (const statement of node.body) {
      if (statement.type === 'ReturnStatement') return { returned: true, value: statement.argument ? evaluate(statement.argument, scope, module, true) : undefined }
      if (statement.type === 'ThrowStatement') return { returned: true }
      if (statement.type === 'VariableDeclaration') {
        for (const declaration of statement.declarations) bind(declaration.id, declaration.init ? evaluate(declaration.init, scope, module) : undefined, scope)
      } else if (statement.type === 'FunctionDeclaration' && statement.id) {
        scope.set(statement.id.name, { kind: 'function', node: statement, module, scope: new Map(scope) })
      } else if (statement.type === 'ExpressionStatement') {
        const previousAnchor = activeAnchor
        activeAnchor = [...(statement.leadingComments ?? []), ...(statement.innerComments ?? [])].map(comment => comment.value.match(/smarthub:assert\s+([A-Za-z0-9._-]+)/u)?.[1]).find(Boolean) ?? activeAnchor
        evaluate(statement.expression, scope, module)
        activeAnchor = previousAnchor
      } else if (statement.type === 'BlockStatement') {
        const nested = evaluateBody(statement, new Map(scope), module)
        if (nested.returned) return nested
      } else if (statement.type === 'IfStatement') {
        // Only constant conditions are supported. Any other branch could return,
        // throw or replace a binding, so later statements cannot prove execution.
        if (statement.test.type !== 'BooleanLiteral') return { returned: true }
        const branch = statement.test.value ? statement.consequent : statement.alternate
        if (branch) {
          const nested = branch.type === 'BlockStatement' ? evaluateBody(branch, scope, module) : evaluateBody({ type: 'BlockStatement', body: [branch], directives: [] }, scope, module)
          if (nested.returned) return nested
        }
      } else if (!['EmptyStatement', 'TSTypeAliasDeclaration', 'TSInterfaceDeclaration'].includes(statement.type)) {
        return { returned: true }
      }
    }
    return {}
  }

  function evaluate(node: Node, scope: Scope, module: string, awaited = false): Value | undefined {
    if (node.type === 'AwaitExpression') return evaluate(node.argument, scope, module, true)
    if (node.type === 'TSAsExpression' || node.type === 'TSNonNullExpression' || node.type === 'TSTypeAssertion') return evaluate(node.expression, scope, module, awaited)
    if (node.type === 'Identifier') {
      const value = scope.get(node.name)
      return value && !invalidated.has(value) ? value : undefined
    }
    if (node.type === 'ThisExpression') return scope.get('this')
    if (node.type === 'ArrowFunctionExpression' || node.type === 'FunctionExpression') return { kind: 'function', node, module, scope: new Map(scope) }
    if (node.type === 'MemberExpression' && !node.computed) {
      const object = evaluate(node.object, scope, module)
      if (object?.kind === 'object') return object.members.get(name(node.property) ?? '')
      if (object?.kind === 'data' || object?.kind === 'ui') return object
    }
    if (node.type === 'AssignmentExpression') {
      const value = evaluate(node.right, scope, module)
      if (node.left.type === 'Identifier') {
        scope.delete(node.left.name)
        if (value) scope.set(node.left.name, value)
      } else if (node.left.type === 'MemberExpression' && !node.left.computed) {
        const object = evaluate(node.left.object, scope, module)
        const key = name(node.left.property)
        if (object?.kind === 'object' && key && value) object.members.set(key, value)
        else if (object) invalidated.add(object)
      }
      return value
    }
    if (node.type === 'NewExpression') {
      const constructor = evaluate(node.callee, scope, module)
      if (constructor?.kind !== 'class' || constructor.node.type !== 'ClassDeclaration') return undefined
      const instance: Value = { kind: 'object', members: new Map(), declaration: constructor }
      const args = node.arguments.map(argument => evaluate(argument, scope, module))
      for (const method of constructor.node.body.body) {
        if (method.type !== 'ClassMethod' || method.computed) continue
        const value: FunctionValue = { kind: 'function', node: method, module: constructor.module, scope: moduleScope(constructor.module), receiver: instance }
        if (method.kind === 'constructor') {
          method.params.forEach((parameter, index) => {
            if (parameter.type !== 'TSParameterProperty' || parameter.parameter.type !== 'Identifier' || !args[index]) return
            instance.members.set(parameter.parameter.name, args[index]!)
          })
          invoke(value, args)
        } else if (name(method.key)) instance.members.set(name(method.key)!, value)
      }
      return instance
    }
    if (node.type !== 'CallExpression') return undefined
    if (node.callee.type === 'Identifier' && node.callee.name === 'expect') {
      const received = node.arguments[0] ? evaluate(node.arguments[0], scope, module) : undefined
      if (activeAnchor && (received?.kind === 'ui' || received?.kind === 'locator')) result.uiAssertionKeys.add(activeAnchor)
      const read = received?.kind === 'locator' ? uiRead : received && 'read' in received ? received.read : undefined
      if (activeAnchor && read !== undefined && read > mutation && mutation >= 0) result.persistedAssertionKeys.add(activeAnchor)
      return undefined
    }
    if (node.callee.type === 'MemberExpression' && !node.callee.computed) {
      const method = name(node.callee.property) ?? ''
      if (node.callee.object.type === 'Identifier' && node.callee.object.name === 'test' && method === 'step') {
        if (!awaited) return undefined
        const callback = node.arguments[1] ? evaluate(node.arguments[1], scope, module) : undefined
        return callback?.kind === 'function' ? invoke(callback, []) : undefined
      }
      const receiver = evaluate(node.callee.object, scope, module)
      if (receiver?.kind === 'page' || receiver?.kind === 'locator') {
        if (method === 'goto' && receiver.kind === 'page') {
          if (!awaited) return undefined
          sequence++
          result.navigation = true
          uiRead = sequence
          return undefined
        }
        if (!/^(?:locator|frameLocator|getByAltText|getByLabel|getByPlaceholder|getByRole|getByTestId|getByText|getByTitle|filter|first|last|nth|and|or|title|url|content|textContent|innerText|inputValue|allTextContents|count|isVisible|isEnabled|isChecked|getAttribute|reload|goBack|goForward|click|dblclick|fill|press|pressSequentially|check|uncheck|selectOption|setChecked|dragTo)$/u.test(method)) return undefined
        sequence++
        result.interactionBeforeNavigation ||= !result.navigation
        if (awaited && /^(?:reload|goBack|goForward)$/u.test(method)) uiRead = sequence
        if (awaited && /^(?:click|dblclick|fill|press|pressSequentially|check|uncheck|selectOption|setChecked|dragTo)$/u.test(method)) mutation = sequence
        return { kind: /^(?:locator|frameLocator|getByAltText|getByLabel|getByPlaceholder|getByRole|getByTestId|getByText|getByTitle|filter|first|last|nth|and|or)$/u.test(method) ? 'locator' : 'ui', read: uiRead }
      }
      if (receiver?.kind === 'request' && /^(?:get|post|put|patch|delete|head|options)$/u.test(method)) {
        if (!awaited) return undefined
        sequence++
        if (/^(?:post|put|patch|delete)$/u.test(method)) mutation = sequence
        return { kind: 'response', ...(/^(?:get|head)$/u.test(method) ? { read: sequence } : {}) }
      }
      if (receiver?.kind === 'response') return { kind: 'data', read: receiver.read }
      if (receiver?.kind === 'data') return receiver
      const callable = receiver?.kind === 'object' ? receiver.members.get(method) : undefined
      if (callable?.kind === 'function' && awaited) return invoke(callable, node.arguments.map(argument => evaluate(argument, scope, module)))
      // Visit expect(...).matcher(...) without claiming unknown methods are IO.
      node.arguments.forEach(argument => {
        const value = evaluate(argument, scope, module)
        if (value && ['page', 'request', 'locator'].includes(value.kind)) invalidated.add(value)
      })
      return undefined
    }
    const callable = evaluate(node.callee, scope, module)
    if (callable?.kind === 'function' && awaited) return invoke(callable, node.arguments.map(argument => evaluate(argument, scope, module)))
    node.arguments.forEach(argument => {
      const value = evaluate(argument, scope, module)
      if (value && ['page', 'request', 'locator'].includes(value.kind)) invalidated.add(value)
    })
    return undefined
  }

  const scope = new Map(moduleScope(input.entrypoint))
  if ('params' in input.callback && Array.isArray(input.callback.params)) {
    const parameter = input.callback.params[0]
    if (parameter?.type === 'ObjectPattern') for (const property of parameter.properties) {
      if (property.type !== 'ObjectProperty' || !['page', 'request'].includes(name(property.key) ?? '')) continue
      bind(property.value, { kind: name(property.key) as 'page' | 'request' }, scope)
    }
  }
  if ('body' in input.callback && input.callback.body) evaluateBody(input.callback.body as Node, scope, input.entrypoint)
  return result
}

function name(node: Node) {
  return node.type === 'Identifier' ? node.name : node.type === 'StringLiteral' ? node.value : undefined
}
