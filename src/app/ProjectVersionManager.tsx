import { useState } from 'react'
import { AlertTriangle, GitBranch, Plus, Trash2 } from 'lucide-react'
import {
  createProjectVersion,
  deleteProjectVersion,
  updateProjectVersionStatus,
  type ProjectVersion,
  type ProjectVersionStatus,
} from '../project-version-api'
import { type Notify } from './types'
import { Modal, Badge } from './shared'

export function ProjectVersionManager({
  versions,
  selectedId,
  onSelect,
  onRefresh,
  onClose,
  notify,
}: {
  versions: ProjectVersion[]
  selectedId: string
  onSelect: (id: string) => void
  onRefresh: () => Promise<ProjectVersion[]>
  onClose: () => void
  notify: Notify
}) {
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [sourceId, setSourceId] = useState('')
  const [inherit, setInherit] = useState(true)
  const [saving, setSaving] = useState(false)
  const [deleteTarget, setDeleteTarget] = useState<ProjectVersion | null>(null)
  const [deleting, setDeleting] = useState(false)
  const create = async () => {
    if (!name.trim() || saving) return
    setSaving(true)
    try {
      const created = await createProjectVersion({
        name,
        description,
        sourceProjectVersionId: sourceId || undefined,
        inheritRequirementBindings: Boolean(sourceId && inherit),
      })
      await onRefresh()
      notify(`项目版本 ${created.name} 已创建。`)
      onSelect(created.id)
    } catch (error) {
      notify(error instanceof Error ? error.message : '项目版本创建失败', 'error')
    } finally {
      setSaving(false)
    }
  }
  const changeStatus = async (version: ProjectVersion, status: ProjectVersionStatus) => {
    try {
      await updateProjectVersionStatus(version.id, status)
      await onRefresh()
      notify(`${version.name} 已设为${status === 'open' ? '可编辑' : status === 'locked' ? '已锁定' : '已归档'}。`)
    } catch (error) {
      notify(error instanceof Error ? error.message : '版本状态更新失败', 'error')
    }
  }
  const remove = async () => {
    if (!deleteTarget || deleting) return
    setDeleting(true)
    try {
      const deleted = await deleteProjectVersion(deleteTarget.id)
      const remaining = await onRefresh()
      const workspaceCleanup = deleted.workspaceCleanupTaskIds.length
        ? `；已安排清理 ${deleted.deletedWorkspaceDirectories} 个版本工作区目录和 ${deleted.deletedWorkspaceAssets} 个版本资产`
        : ''
      notify(
        `项目版本 ${deleted.name} 已删除，同时移除 ${deleted.deletedBindings} 条需求绑定、${deleted.deletedAnalysisRuns} 条需求分析运行和 ${deleted.deletedTestDesigns} 个测试设计${workspaceCleanup}。`,
      )
      if (deleteTarget.id === selectedId) onSelect(remaining[0]?.id ?? '')
      else setDeleteTarget(null)
    } catch (error) {
      notify(error instanceof Error ? error.message : '项目版本删除失败', 'error')
    } finally {
      setDeleting(false)
    }
  }
  return (
    <>
      <Modal title="项目版本" onClose={onClose} className="version-manager-modal">
        <div className="version-manager">
          <section>
            <h3>当前项目版本</h3>
            <p>
              需求分析数据按版本隔离；锁定和归档版本只能查看。只有可编辑版本可删除；删除时会同时移除该版本的需求绑定、已结束分析运行和版本工作区产物。
            </p>
            <div className="project-version-list">
              {versions.map(version => (
                <article className={version.id === selectedId ? 'active' : ''} key={version.id}>
                  <button className="version-select" onClick={() => onSelect(version.id)}>
                    <GitBranch />
                    <span>
                      <b>{version.name}</b>
                      <small>
                        {version.description || '未填写版本说明'} ·{' '}
                        {new Date(version.createdAt).toLocaleString('zh-CN')}
                      </small>
                    </span>
                    <Badge tone={version.status === 'open' ? 'green' : version.status === 'locked' ? 'orange' : 'gray'}>
                      {version.status === 'open' ? '可编辑' : version.status === 'locked' ? '已锁定' : '已归档'}
                    </Badge>
                  </button>
                  <select
                    aria-label={`设置 ${version.name} 状态`}
                    value={version.status}
                    onChange={event => void changeStatus(version, event.target.value as ProjectVersionStatus)}
                  >
                    <option value="open">可编辑</option>
                    <option value="locked">锁定</option>
                    <option value="archived">归档</option>
                  </select>
                  <button
                    className="version-delete"
                    disabled={version.status !== 'open'}
                    title={version.status === 'open' ? `删除 ${version.name}` : '只有可编辑版本可以删除'}
                    aria-label={version.status === 'open' ? `删除 ${version.name}` : `${version.name} 不可删除`}
                    onClick={() => setDeleteTarget(version)}
                  >
                    <Trash2 />
                  </button>
                </article>
              ))}
              {!versions.length && (
                <div className="version-empty">
                  <GitBranch />
                  <b>尚无项目版本</b>
                  <span>创建第一个版本后，才能进入需求分析。</span>
                </div>
              )}
            </div>
          </section>
          <section className="version-create">
            <h3>新建版本</h3>
            <label>
              版本名称
              <input value={name} onChange={event => setName(event.target.value)} placeholder="例如：V1.0 / 2026-Q3" />
            </label>
            <label>
              版本说明
              <textarea
                value={description}
                onChange={event => setDescription(event.target.value)}
                placeholder="本版本目标或范围（可选）"
              />
            </label>
            <label>
              来源版本
              <select value={sourceId} onChange={event => setSourceId(event.target.value)}>
                <option value="">空白版本</option>
                {versions.map(version => (
                  <option value={version.id} key={version.id}>
                    {version.name}
                  </option>
                ))}
              </select>
            </label>
            {sourceId && (
              <label className="version-inherit">
                <input type="checkbox" checked={inherit} onChange={event => setInherit(event.target.checked)} />
                继承来源版本的需求绑定（不继承需求分析运行和对话）
              </label>
            )}
            <button className="btn primary full" disabled={!name.trim() || saving} onClick={() => void create()}>
              <Plus />
              {saving ? '创建中…' : '创建并进入版本'}
            </button>
          </section>
        </div>
      </Modal>
      {deleteTarget && (
        <Modal
          title="删除项目版本"
          onClose={() => {
            if (!deleting) setDeleteTarget(null)
          }}
        >
          <div className="modal-form version-delete-confirm">
            <div className="danger-confirm">
              <AlertTriangle />
              <span>
                <b>确定删除“{deleteTarget.name}”吗？</b>
                <small>
                  该版本的需求绑定、已结束的需求分析运行及 `workspace/branches/{deleteTarget.name}`
                  下的版本专属资料将一并删除，操作不可恢复；共享知识库资料不会删除。如有运行中的需求分析，请先取消。
                </small>
              </span>
            </div>
            <div className="modal-actions">
              <button className="btn ghost" disabled={deleting} onClick={() => setDeleteTarget(null)}>
                取消
              </button>
              <button className="btn danger" disabled={deleting} onClick={() => void remove()}>
                <Trash2 />
                {deleting ? '删除中…' : '确认删除'}
              </button>
            </div>
          </div>
        </Modal>
      )}
    </>
  )
}
