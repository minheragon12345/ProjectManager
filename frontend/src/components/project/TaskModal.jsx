import { Save, Loader, Trash2, X, Plus, MessageSquare } from 'lucide-react';
import TimeLogSection from '../TimeLogSection';
import TaskRelationsSection from '../TaskRelationsSection';
import { useI18n } from '../../i18n';
import { unitLabel } from '../../utils/timeUnit';

export default function TaskModal({ editor, id, project, tasks, user, canEdit, canComment, fetchTasks }) {
  const { t: tr, locale } = useI18n();
  const {
    showTaskModal,
    setShowTaskModal,
    editingTaskId,
    editingTaskRef,
    editMode,
    setEditMode,
    editingTaskParent,
    editingSubtaskStats,
    taskForm,
    setTaskForm,
    taskSaving,
    pendingBlockers,
    setPendingBlockers,
    pendingSubtasks,
    setPendingSubtasks,
    blockerQuery,
    setBlockerQuery,
    newSubtaskDraft,
    setNewSubtaskDraft,
    commentList,
    commentText,
    setCommentText,
    commentsLoading,
    assigneeOptions,
    handleOpenEditTask,
    handleSaveTask,
    handleDeleteTask,
    handleSendComment,
    handleCloseTaskModal,
  } = editor;

  if (!showTaskModal) return null;
  const taskAccess = editingTaskRef?.access;
  const canWriteTask = taskAccess === 'owner' || taskAccess === 'write' || (canEdit && !editingTaskId);
  const taskReadOnly = !!editingTaskId && (!canWriteTask || !editMode);
  return (
    <div className="modal-overlay" onClick={handleCloseTaskModal}>
      <div className="modal-content" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h3>{editingTaskId ? (editMode ? tr('task.edit') : tr('task.title')) : tr('task.new')}</h3>
          <div className="modal-header-actions">
            {editingTaskId && editingTaskRef ? (
              <>
                {canWriteTask && !editMode ? (
                  <button
                    type="button"
                    className="btn-primary"
                    title={tr('common.edit')}
                    onClick={() => setEditMode(true)}
                  >
                    <Save size={16} />
                    <span>{tr('common.edit')}</span>
                  </button>
                ) : null}
                {editingTaskRef.access === 'owner' ? (
                  <button
                    type="button"
                    className="icon-btn danger"
                    title={tr('task.moveToTrash')}
                    onClick={async () => {
                      setShowTaskModal(false);
                      await handleDeleteTask(editingTaskRef);
                    }}
                  >
                    <Trash2 size={18} />
                  </button>
                ) : null}
              </>
            ) : null}
            <button className="btn-close" onClick={handleCloseTaskModal} title={tr('common.close')}>
              <X size={24} />
            </button>
          </div>
        </div>

        <div className="form-group">
          <label>{tr('task.title')}</label>
          <input
            type="text"
            className="custom-input title-input"
            placeholder={tr('task.titlePlaceholder')}
            value={taskForm.title}
            onChange={(e) => setTaskForm({ ...taskForm, title: e.target.value })}
            maxLength={120}
            autoFocus
            disabled={taskReadOnly}
          />
        </div>

        <form onSubmit={handleSaveTask}>
        <fieldset disabled={taskReadOnly} style={{ border: 'none', padding: 0, margin: 0 }}>
          <div className="form-row">
            <div className="form-group half">
              <label>{tr('task.duration')} ({unitLabel(project?.timeUnit || 'day')})</label>
              <input
                type="number"
                className="custom-input"
                min={0}
                max={100000}
                step={0.5}
                value={taskForm.duration}
                onChange={(e) => setTaskForm({ ...taskForm, duration: Number(e.target.value || 0) })}
              />
            </div>

            <div className="form-group half">
              <label>{tr('task.peopleRequired')}</label>
              <input
                type="number"
                className="custom-input"
                min={1}
                max={10000}
                step={1}
                value={taskForm.peopleRequired}
                onChange={(e) => setTaskForm({ ...taskForm, peopleRequired: parseInt(e.target.value || '1', 10) })}
              />
            </div>
          </div>

          <div className="form-row">
            <div className="form-group half">
              <label title={tr('task.minDurationHint')}>
                {tr('task.minDuration')} ({unitLabel(project?.timeUnit || 'day')}) — {tr('common.optional')}
              </label>
              <input
                type="number"
                className="custom-input"
                min={0}
                max={100000}
                step={0.5}
                placeholder={tr('task.notCrashable')}
                value={taskForm.minDuration}
                onChange={(e) => setTaskForm({ ...taskForm, minDuration: e.target.value })}
              />
            </div>

            <div className="form-group half">
              <label title={tr('task.marginalCostHint')}>
                {tr('task.marginalCost')} — {tr('common.optional')}
              </label>
              <input
                type="number"
                className="custom-input"
                min={0}
                step={0.01}
                placeholder={tr('task.notCrashable')}
                value={taskForm.marginalCost}
                onChange={(e) => setTaskForm({ ...taskForm, marginalCost: e.target.value })}
              />
            </div>
          </div>

          <div className="form-row">
            <div className="form-group half">
              <label>
                {tr('task.progress')}: {Math.max(0, Math.min(100, Number(taskForm.progress) || 0))}%
                {(editingSubtaskStats?.total || 0) > 0 ? (
                  <span className="progress-locked-hint" title={tr('task.progressAutoHint')}> {tr('task.progressAuto')}</span>
                ) : null}
              </label>
              <div className="progress-edit">
                <input
                  type="range"
                  min={0}
                  max={100}
                  value={taskForm.progress}
                  disabled={taskForm.cancelled || (editingSubtaskStats?.total || 0) > 0}
                  onChange={(e) => setTaskForm({ ...taskForm, progress: parseInt(e.target.value || '0', 10) })}
                />
                <input
                  type="number"
                  min={0}
                  max={100}
                  value={taskForm.progress}
                  disabled={taskForm.cancelled || (editingSubtaskStats?.total || 0) > 0}
                  onChange={(e) => setTaskForm({ ...taskForm, progress: parseInt(e.target.value || '0', 10) })}
                />
              </div>
            </div>

            <div className="form-group half">
              <label>{tr('task.status')}</label>
              <select
                className="custom-select"
                value={taskForm.cancelled ? 'cancelled' : 'active'}
                onChange={(e) =>
                  setTaskForm({ ...taskForm, cancelled: e.target.value === 'cancelled' })
                }
              >
                <option value="active">{tr('task.status.active')}</option>
                <option value="cancelled">{tr('task.status.cancelled')}</option>
              </select>
            </div>
          </div>

          <div className="form-row">
            <div className="form-group half">
              <label>{tr('task.assignees')}</label>
              <div className="assignee-picker">
                {assigneeOptions.length === 0 ? (
                  <span className="muted">{tr('task.noMembers')}</span>
                ) : (
                  assigneeOptions.map((o) => {
                    const checked = (taskForm.assignees || []).includes(o.id);
                    return (
                      <label className={`assignee-pill-toggle ${checked ? 'on' : ''}`} key={o.id}>
                        <input
                          type="checkbox"
                          checked={checked}
                          onChange={(e) => {
                            const next = new Set(taskForm.assignees || []);
                            if (e.target.checked) next.add(o.id);
                            else next.delete(o.id);
                            setTaskForm({ ...taskForm, assignees: Array.from(next) });
                          }}
                        />
                        <span>{o.label}{o.role === 'owner' ? ` (${tr('task.ownerTag')})` : ''}</span>
                      </label>
                    );
                  })
                )}
              </div>
            </div>
            <div className="form-group half">
              <label>{tr('task.deadline')}</label>
              <input
                type="date"
                className="custom-input"
                value={taskForm.deadline}
                onChange={(e) => setTaskForm({ ...taskForm, deadline: e.target.value })}
              />
            </div>
          </div>

          <div className="form-row">
            <div className="form-group half">
              <label title={tr('task.estimatedHoursHint')}>{tr('task.estimatedHours')}</label>
              <input
                type="number"
                className="custom-input"
                min={0}
                max={10000}
                step={0.5}
                value={taskForm.estimatedHours}
                onChange={(e) => setTaskForm({ ...taskForm, estimatedHours: e.target.value })}
              />
            </div>
          </div>

          <div className="form-group">
            <label>{tr('task.content')}</label>
            <textarea
              className="custom-input"
              placeholder={tr('task.contentPlaceholder')}
              rows="6"
              value={taskForm.content}
              onChange={(e) => setTaskForm({ ...taskForm, content: e.target.value })}
              maxLength={5000}
              required
            />
          </div>

          {editingTaskId ? (
            <TimeLogSection
              taskId={editingTaskId}
              canWrite={canEdit}
              currentUserId={user?.id}
              onChange={fetchTasks}
            />
          ) : null}

          <div className="modal-footer">
            {taskReadOnly ? null : (
              <button
                type="button"
                className="btn-cancel"
                onClick={() => {
                  if (editingTaskId && editMode) {
                    if (editingTaskRef) handleOpenEditTask(editingTaskRef);
                    else setEditMode(false);
                  } else {
                    handleCloseTaskModal();
                  }
                }}
                disabled={taskSaving}
              >
                {tr('common.cancel')}
              </button>
            )}
            {taskReadOnly ? null : (
              <button type="submit" className="btn-save" disabled={taskSaving}>
                {taskSaving ? <Loader size={16} className="spin" /> : null}
                <span>{taskSaving ? tr('common.saving') : editingTaskId ? tr('common.save') : tr('common.create')}</span>
              </button>
            )}
          </div>
        </fieldset>
        </form>

        {!editingTaskId ? (
          <section className="task-precreate-relations">
            <div className="precreate-block">
              <h4>{tr('task.blockedBy')} ({pendingBlockers.length})</h4>
              {pendingBlockers.length === 0 ? (
                <div className="muted small">{tr('task.noBlockers')}</div>
              ) : (
                <div className="pending-chip-row">
                  {pendingBlockers.map((b) => (
                    <span key={b.id} className="pending-chip">
                      {b.title || tr('common.untitled')}
                      <button
                        type="button"
                        className="pending-chip-x"
                        onClick={() => setPendingBlockers((prev) => prev.filter((x) => x.id !== b.id))}
                        aria-label={tr('task.removeBlocker')}
                      >
                        <X size={10} />
                      </button>
                    </span>
                  ))}
                </div>
              )}
              <input
                type="text"
                className="custom-input"
                placeholder={tr('task.searchBlocker')}
                value={blockerQuery}
                onChange={(e) => setBlockerQuery(e.target.value)}
              />
              {blockerQuery.trim() ? (
                <div className="picker-results">
                  {(() => {
                    const q = blockerQuery.trim().toLowerCase();
                    const selectedIds = new Set(pendingBlockers.map((b) => b.id));
                    const matches = (tasks || [])
                      .filter((t) => {
                        const id = String(t._id || t.id);
                        if (selectedIds.has(id)) return false;
                        return (t.title || '').toLowerCase().includes(q)
                          || (t.content || '').toLowerCase().includes(q);
                      })
                      .slice(0, 8);
                    if (matches.length === 0) {
                      return <div className="muted small">{tr('task.noMatch')}</div>;
                    }
                    return matches.map((t) => (
                      <button
                        key={String(t._id || t.id)}
                        type="button"
                        className="picker-row"
                        onClick={() => {
                          setPendingBlockers((prev) => [
                            ...prev,
                            { id: String(t._id || t.id), title: t.title || t.content?.slice(0, 60) || tr('common.untitled') },
                          ]);
                          setBlockerQuery('');
                        }}
                      >
                        <span>{t.title || t.content?.slice(0, 60) || tr('common.untitled')}</span>
                        {t.status === 'done' ? <span className="muted small">{tr('task.status.done')}</span> : null}
                      </button>
                    ));
                  })()}
                </div>
              ) : null}
            </div>

            <div className="precreate-block">
              <h4>{tr('task.subtasks')} ({pendingSubtasks.length})</h4>
              {pendingSubtasks.length === 0 ? (
                <div className="muted small">{tr('task.noSubtasks')}</div>
              ) : (
                <ul className="pending-sub-list">
                  {pendingSubtasks.map((s, i) => (
                    <li key={i}>
                      <div className="pending-sub-text">
                        <strong>{s.title || tr('common.noTitle')}</strong>
                        {s.content ? <span className="muted small"> — {s.content}</span> : null}
                      </div>
                      <button
                        type="button"
                        className="pending-chip-x"
                        onClick={() => setPendingSubtasks((prev) => prev.filter((_, j) => j !== i))}
                        aria-label={tr('task.removeSubtask')}
                      >
                        <X size={10} />
                      </button>
                    </li>
                  ))}
                </ul>
              )}
              <div className="precreate-sub-add">
                <input
                  type="text"
                  className="custom-input"
                  placeholder={tr('task.subtask.title')}
                  value={newSubtaskDraft.title}
                  onChange={(e) => setNewSubtaskDraft({ ...newSubtaskDraft, title: e.target.value })}
                />
                <input
                  type="text"
                  className="custom-input"
                  placeholder={tr('task.subtask.content')}
                  value={newSubtaskDraft.content}
                  onChange={(e) => setNewSubtaskDraft({ ...newSubtaskDraft, content: e.target.value })}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && newSubtaskDraft.content.trim()) {
                      e.preventDefault();
                      setPendingSubtasks((prev) => [...prev, {
                        title: newSubtaskDraft.title.trim(),
                        content: newSubtaskDraft.content.trim(),
                      }]);
                      setNewSubtaskDraft({ title: '', content: '' });
                    }
                  }}
                />
                <button
                  type="button"
                  className="btn-secondary"
                  disabled={!newSubtaskDraft.content.trim()}
                  onClick={() => {
                    setPendingSubtasks((prev) => [...prev, {
                      title: newSubtaskDraft.title.trim(),
                      content: newSubtaskDraft.content.trim(),
                    }]);
                    setNewSubtaskDraft({ title: '', content: '' });
                  }}
                >
                  <Plus size={14} /> {tr('common.add')}
                </button>
              </div>
              <small className="muted">
                {tr('task.precreateNote')}
              </small>
            </div>
          </section>
        ) : null}

        {editingTaskId ? (
          <TaskRelationsSection
            taskId={editingTaskId}
            projectId={id}
            parentTaskId={editingTaskParent}
            canEdit={canEdit && editMode}
            onEditTask={(t) => handleOpenEditTask(t)}
            onChange={fetchTasks}
          />
        ) : null}

        {editingTaskId ? (
          <section className="task-comments-inline">
            <h4><MessageSquare size={14} /> {tr('task.comments')} {commentList.length ? `(${commentList.length})` : ''}</h4>
            <div className="comment-list">
              {commentsLoading && commentList.length === 0 ? (
                <div className="muted">{tr('common.loading')}</div>
              ) : commentList.length === 0 ? (
                <div className="muted">{tr('task.noComments')}</div>
              ) : (
                commentList.map((c, idx) => (
                  <div key={c._id || idx} className="comment-item">
                    <div className="comment-meta">
                      <span className="comment-author">{c.user?.username || c.user?.email || tr('task.unknownUser')}</span>
                      <span className="comment-date">
                        {c.createdAt ? new Date(c.createdAt).toLocaleString(locale) : ''}
                      </span>
                    </div>
                    <div className="comment-text">{c.text}</div>
                  </div>
                ))
              )}
            </div>
            {canComment ? (
              <div className="comment-box">
                <textarea
                  className="custom-input"
                  rows={2}
                  placeholder={tr('task.commentPlaceholder')}
                  value={commentText}
                  onChange={(e) => setCommentText(e.target.value)}
                  disabled={commentsLoading}
                />
                <button
                  type="button"
                  className="btn-save"
                  onClick={handleSendComment}
                  disabled={commentsLoading || !commentText.trim()}
                >
                  {tr('task.send')}
                </button>
              </div>
            ) : (
              <div className="muted">{tr('task.cannotComment')}</div>
            )}
          </section>
        ) : null}
      </div>
    </div>
  );
}
