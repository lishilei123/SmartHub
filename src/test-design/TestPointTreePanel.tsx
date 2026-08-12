import { GitMerge, Pencil, Scissors, Trash2 } from 'lucide-react'
import type { CSSProperties } from 'react'
import type { TestPointNode } from './types'

type Props = {
  nodes: TestPointNode[]
  selected: string[]
  onSelect: (ids: string[]) => void
  onEdit: (node: TestPointNode) => void
  onSplit: (node: TestPointNode) => void
  onDelete: (node: TestPointNode) => void
  onMerge: (nodes: TestPointNode[]) => void
  readOnly: boolean
}

export function TestPointTreePanel({ nodes, selected, onSelect, onEdit, onSplit, onDelete, onMerge, readOnly }: Props) {
  const active = nodes.filter(item => !item.deleted).sort((left, right) => left.sortKey.localeCompare(right.sortKey))
  const depth = (node: TestPointNode) => {
    let count = 0
    let parent = node.parentId
    const seen = new Set<string>()
    while (parent && !seen.has(parent)) {
      seen.add(parent); count += 1; parent = active.find(item => item.nodeId === parent)?.parentId ?? null
    }
    return count
  }
  const mergeSelection = active.filter(node => selected.includes(node.nodeId))
  const mergeAllowed = mergeSelection.length >= 2 && mergeSelection.every(node => node.parentId === mergeSelection[0].parentId)
  return <div className="td2-tree">
    <div className="td2-tree-toolbar"><span>{active.length} 个节点 · {active.filter(item => !active.some(child => child.parentId === item.nodeId)).length} 个可执行叶子{mergeSelection.length >= 2 && !mergeAllowed ? ' · 仅同级测试点可合并' : ''}</span><button className="td2-button ghost" title={mergeSelection.length >= 2 && !mergeAllowed ? '仅支持合并同一父节点下的测试点' : undefined} disabled={readOnly || !mergeAllowed} onClick={() => onMerge(mergeSelection)}><GitMerge />合并所选</button></div>
    <div className="td2-tree-list">{active.map(node => <article key={node.nodeId} className={selected.includes(node.nodeId) ? 'selected' : ''} style={{ '--tree-depth': depth(node) } as CSSProperties}>
      <input aria-label={`选择测试点 ${node.title}`} type="checkbox" checked={selected.includes(node.nodeId)} disabled={readOnly} onChange={() => onSelect(selected.includes(node.nodeId) ? selected.filter(id => id !== node.nodeId) : [...selected, node.nodeId])} />
      <div className={`td2-dimension ${node.dimension}`}>{node.dimension.slice(0, 1).toUpperCase()}</div>
      <div className="td2-tree-content"><div><b>{node.title}</b><span className={`td2-priority ${node.priority}`}>{node.priority}</span><span>{node.applicability}</span></div><p>{node.objective}</p><small>{node.entryMethods.map(item => item.toUpperCase()).join(' / ') || '无执行入口'} · {node.designTechniques.join(' · ') || '未标注方法'}</small><code title={node.nodeId}>{node.nodeId}</code></div>
      {!readOnly && <div className="td2-row-actions"><button aria-label={`编辑测试点 ${node.title}`} onClick={() => onEdit(node)}><Pencil /></button><button aria-label={`拆分测试点 ${node.title}`} onClick={() => onSplit(node)}><Scissors /></button><button aria-label={`删除测试点 ${node.title}`} onClick={() => onDelete(node)}><Trash2 /></button></div>}
    </article>)}</div>
  </div>
}
