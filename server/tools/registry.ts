import type { ToolDescriptor, ToolHandler } from '../domain/tool-types.js'

export class ToolRegistry {
  private readonly tools = new Map<string, { descriptor: ToolDescriptor; handler: ToolHandler }>()

  register(descriptor: ToolDescriptor, handler: ToolHandler) {
    if (this.tools.has(descriptor.id) || [...this.tools.values()].some(item => item.descriptor.piName === descriptor.piName)) throw new Error(`工具重复注册：${descriptor.id}`)
    this.tools.set(descriptor.id, { descriptor: structuredClone(descriptor), handler })
    return this
  }

  get(id: string) { return this.tools.get(id) }
  descriptors(ids?: Iterable<string>) {
    const allowed = ids ? new Set(ids) : null
    return [...this.tools.values()].map(item => item.descriptor).filter(item => !allowed || allowed.has(item.id))
  }
}
