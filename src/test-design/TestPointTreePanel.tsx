import { GitMerge, Pencil, Scissors, Trash2 } from 'lucide-react'
import type { TestPointNode, TestPointTreeOperation } from './types'

export function TestPointTreePanel({ nodes, selected, onSelect, onOperation, readOnly }: { nodes: TestPointNode[]; selected: string[]; onSelect: (ids: string[]) => void; onOperation: (operations: TestPointTreeOperation[], reason: string) => void; readOnly: boolean }) {
  const active = nodes.filter(item => !item.deleted).sort((left, right) => left.sortKey.localeCompare(right.sortKey))
  const depth = (node: TestPointNode) => { let count = 0; let parent = node.parentId; const seen = new Set<string>(); while (parent && !seen.has(parent)) { seen.add(parent); count += 1; parent = active.find(item => item.nodeId === parent)?.parentId ?? null } return count }
  const rename = (node: TestPointNode) => { const title = window.prompt('测试点标题', node.title)?.trim(); if (title && title !== node.title) onOperation([{ op: 'rename', nodeId: node.nodeId, title }], '人工重命名测试点') }
  const remove = (node: TestPointNode) => { if (window.confirm(`删除测试点“${node.title}”？其子节点将提升到当前层级。`)) onOperation([{ op: 'delete', nodeId: node.nodeId }], '人工删除测试点') }
  const split = (node: TestPointNode) => {
    const raw = window.prompt('输入拆分后的测试点标题，使用逗号分隔', `${node.title} - 场景 1, ${node.title} - 场景 2`)
    const titles = raw?.split(/[,，\n]/u).map(item => item.trim()).filter(Boolean) ?? []
    if (titles.length < 2) return
    const value = contentOf(node)
    onOperation([{ op: 'split', nodeId: node.nodeId, children: titles.map((title, index) => ({ clientNodeRef: `split-${Date.now()}-${index}`, sortKey: `${node.sortKey}-${String(index + 1).padStart(2, '0')}`, value: { ...value, title, objective: `验证 ${title}` } })) }], '人工拆分测试点')
  }
  const merge = () => {
    if (selected.length < 2) return
    const target = active.find(item => item.nodeId === selected[0]); if (!target) return
    const title = window.prompt('合并后的测试点标题', target.title)?.trim(); if (!title) return
    onOperation([{ op: 'merge', sourceNodeIds: selected, targetNodeId: target.nodeId, value: { title } }], '人工合并测试点'); onSelect([])
  }
  return <div className="td2-tree">
    <div className="td2-tree-toolbar"><span>{active.length} 个节点 · {active.filter(item => !active.some(child => child.parentId === item.nodeId)).length} 个可执行叶子</span><button className="td2-button ghost" disabled={readOnly || selected.length < 2} onClick={merge}><GitMerge />合并所选</button></div>
    <div className="td2-tree-list">{active.map(node => <article key={node.nodeId} className={selected.includes(node.nodeId) ? 'selected' : ''} style={{ '--tree-depth': depth(node) } as React.CSSProperties}>
      <input type="checkbox" checked={selected.includes(node.nodeId)} onChange={() => onSelect(selected.includes(node.nodeId) ? selected.filter(id => id !== node.nodeId) : [...selected, node.nodeId])} />
      <div className={`td2-dimension ${node.dimension}`}>{node.dimension.slice(0, 1).toUpperCase()}</div>
      <div className="td2-tree-content"><div><b>{node.title}</b><span className={`td2-priority ${node.priority}`}>{node.priority}</span><span>{node.applicability}</span></div><p>{node.objective}</p><small>{node.entryMethods.map(item => item.toUpperCase()).join(' / ') || '无执行入口'} · {node.designTechniques.join(' · ') || '未标注方法'}</small><code>{node.nodeId}</code></div>
      {!readOnly && <div className="td2-row-actions"><button aria-label="重命名" onClick={() => rename(node)}><Pencil /></button><button aria-label="拆分" onClick={() => split(node)}><Scissors /></button><button aria-label="删除" onClick={() => remove(node)}><Trash2 /></button></div>}
    </article>)}</div>
  </div>
}

function contentOf(node: TestPointNode): Omit<TestPointNode, 'nodeId' | 'parentId' | 'sortKey' | 'deleted'> { const { nodeId: _nodeId, parentId: _parentId, sortKey: _sortKey, deleted: _deleted, ...content } = node; return content }
