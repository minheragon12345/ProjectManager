import { useCallback, useEffect, useState } from 'react';
import { toast } from 'react-toastify';
import { List, Trash2, Plus, Loader, Lock, GitBranch, MessageSquare, Search, RefreshCcw } from 'lucide-react';
import { getTrashNotes, restoreNote, deleteNotePermanent } from '../../services/noteService';
import { useI18n } from '../../i18n';
import { unitLabel } from '../../utils/timeUnit';

export default function TaskListTab({
  id,
  project,
  tasks,
  tasksLoading,
  fetchTasks,
  scheduleByTaskId,
  canEdit,
  listSearch,
  setListSearch,
  listTrashView,
  setListTrashView,
  handleOpenCreateTask,
  handleOpenEditTask,
  handleToggleTaskDone,
  handleDeleteTask,
}) {
  const { t: tr, locale } = useI18n();
  const [trashTasks, setTrashTasks] = useState([]);
  const [trashLoading, setTrashLoading] = useState(false);

  const fetchTrash = useCallback(async () => {
    setTrashLoading(true);
    try {
      const data = await getTrashNotes({ projectId: id });
      setTrashTasks(Array.isArray(data?.notes) ? data.notes : []);
    } catch (err) {
      toast.error(err.message || 'Failed to load trash');
    } finally {
      setTrashLoading(false);
    }
  }, [id]);

  const handleRestoreTask = async (task) => {
    try {
      await restoreNote(task._id || task.id);
      toast.success(tr('list.restored'));
      fetchTrash();
    } catch (err) {
      toast.error(err.message || tr('list.restoreFailed'));
    }
  };

  const handleHardDeleteTask = async (task) => {
    if (!window.confirm(tr('settings.permDeleteTaskConfirm'))) return;
    try {
      await deleteNotePermanent(task._id || task.id);
      toast.success(tr('settings.permDeleteToast'));
      fetchTrash();
    } catch (err) {
      toast.error(err.message || tr('settings.permDeleteToast'));
    }
  };

  useEffect(() => {
    fetchTasks();
    if (listTrashView) fetchTrash();
  }, [listTrashView, fetchTasks, fetchTrash]);

  const sourceTasks = listTrashView ? trashTasks : tasks;
  const q = listSearch.trim().toLowerCase();
  const visibleTasks = q
    ? sourceTasks.filter((t) =>
        (t.title || '').toLowerCase().includes(q) ||
        (t.content || '').toLowerCase().includes(q),
      )
    : sourceTasks;
  const isLoading = listTrashView ? trashLoading : tasksLoading;
  return (
    <div className="task-list-panel">
      <div className="task-list-header">
        <h3>
          {listTrashView ? tr('list.trash') : tr('list.heading', { n: visibleTasks.length })}
          {listTrashView ? ` (${visibleTasks.length})` : ''}
        </h3>
        <div className="task-list-actions">
          <div className="task-list-search">
            <Search size={14} />
            <input
              type="text"
              placeholder={tr('list.search')}
              value={listSearch}
              onChange={(e) => setListSearch(e.target.value)}
            />
          </div>
          <button
            type="button"
            className={`btn-secondary ${listTrashView ? 'active' : ''}`}
            onClick={() => setListTrashView((v) => !v)}
            title={tr('list.trash')}
          >
            {listTrashView ? <List size={14} /> : <Trash2 size={14} />}
            <span>{listTrashView ? tr('list.exitTrash') : tr('list.trash')}</span>
          </button>
          {canEdit && !listTrashView ? (
            <button className="btn-primary" onClick={handleOpenCreateTask}>
              <Plus size={16} />
              <span>{tr('board.newTask')}</span>
            </button>
          ) : null}
        </div>
      </div>
      {isLoading ? (
        <div className="projects-loading"><Loader className="spin" size={24} /> <span>{tr('common.loading')}</span></div>
      ) : visibleTasks.length === 0 ? (
        <div className="tab-placeholder">
          {listTrashView ? <Trash2 size={40} /> : <List size={40} />}
          <p>
            {listTrashView
              ? 'Trash is empty for this project.'
              : q
                ? 'No tasks match your search.'
                : 'No tasks yet. Create the first task to get started.'}
          </p>
        </div>
      ) : (
        <div className="task-list">
          {visibleTasks.map((t) => {
            const tid = t._id || t.id;
            const progress = typeof t.progress === 'number' ? t.progress : 0;
            const overdue =
              t.deadline &&
              t.status !== 'done' &&
              t.status !== 'cancelled' &&
              new Date(t.deadline).getTime() < Date.now() &&
              progress < 100;
            return (
              <div
                className={`task-row ${t.status} ${overdue ? 'overdue' : ''} ${listTrashView ? 'is-trashed' : ''}`}
                key={tid}
                onClick={() => !listTrashView && handleOpenEditTask(t)}
                role={listTrashView ? undefined : 'button'}
                tabIndex={listTrashView ? -1 : 0}
                onKeyDown={(e) => {
                  if (!listTrashView && e.key === 'Enter') handleOpenEditTask(t);
                }}
              >
                <input
                  type="checkbox"
                  checked={t.status === 'done'}
                  onChange={() => handleToggleTaskDone(t)}
                  onClick={(e) => e.stopPropagation()}
                  disabled={listTrashView || (!canEdit && t.access !== 'owner' && t.access !== 'write')}
                  aria-label={tr('list.markDone')}
                />
                <div className="task-main">
                  <div className="task-title">
                    {t.title || <span className="task-placeholder">{tr('common.noTitle')}</span>}
                  </div>
                  <div className="task-sub">
                    {(() => {
                      const sched = scheduleByTaskId.get(String(t._id || t.id));
                      if (!sched) return null;
                      if (sched.isCritical) {
                        return (
                          <span className="critical-chip" title={tr('chip.criticalFull')}>
                            {tr('chip.criticalFull')}
                          </span>
                        );
                      }
                      if (sched.totalSlack > 0) {
                        return (
                          <span className="slack-chip" title={tr('chip.slack', { n: sched.totalSlack, unit: unitLabel(project?.timeUnit || 'day') })}>
                            {tr('chip.slack', { n: sched.totalSlack, unit: unitLabel(project?.timeUnit || 'day') })}
                          </span>
                        );
                      }
                      return null;
                    })()}
                    {t.duration > 0 ? (
                      <span className="duration-chip" title={tr('task.duration')}>
                        {tr('chip.duration', { n: t.duration, unit: unitLabel(project?.timeUnit || 'day') })}
                      </span>
                    ) : null}
                    {t.peopleRequired > 1 ? (
                      <span className="people-chip" title={tr('task.peopleRequired')}>
                        {tr('chip.people', { n: t.peopleRequired })}
                      </span>
                    ) : null}
                    {t.isBlocked ? (
                      <span className="blocked-chip" title={tr('chip.blocked')}>
                        <Lock size={10} /> {tr('chip.blocked')}
                      </span>
                    ) : null}
                    {t.subtaskStats?.total > 0 ? (
                      <span className="subtask-mini" title={tr('task.subtasks')}>
                        <GitBranch size={10} /> {tr('chip.subtaskCount', { done: t.subtaskStats.done, total: t.subtaskStats.total })}
                      </span>
                    ) : null}
                    {t.deadline ? (
                      <span className={overdue ? 'overdue-text' : ''}>
                        {tr('list.deadlinePrefix', { date: new Date(t.deadline).toLocaleDateString(locale) })}
                      </span>
                    ) : (
                      <span className="muted">{tr('list.noDeadline')}</span>
                    )}
                    {Array.isArray(t.assignees) && t.assignees.length > 0 ? (
                      <span className="assignees-row">
                        {t.assignees.slice(0, 3).map((a) => (
                          <span className="assignee-pill" key={a.id} title={a.email || ''}>
                            @{a.username}
                          </span>
                        ))}
                        {t.assignees.length > 3 ? (
                          <span className="assignee-pill more">+{t.assignees.length - 3}</span>
                        ) : null}
                      </span>
                    ) : (
                      <span className="muted">{tr('list.unassigned')}</span>
                    )}
                    {t.owner?.username ? <span className="muted">• {t.owner.username}</span> : null}
                  </div>
                  <div className="task-progress">
                    <div className="task-progress-bar">
                      <div className="task-progress-fill" style={{ width: `${progress}%` }} />
                    </div>
                    <span className="task-progress-text">{progress}%</span>
                  </div>
                </div>
                <div className="task-actions" onClick={(e) => e.stopPropagation()}>
                  {listTrashView ? (
                    <>
                      <button
                        type="button"
                        className="icon-btn"
                        title={tr('common.restore')}
                        onClick={() => handleRestoreTask(t)}
                      >
                        <RefreshCcw size={16} />
                      </button>
                      <button
                        type="button"
                        className="icon-btn danger"
                        title={tr('list.deleteForever')}
                        onClick={() => handleHardDeleteTask(t)}
                      >
                        <Trash2 size={16} />
                      </button>
                    </>
                  ) : (
                    <>
                      <button
                        type="button"
                        className="icon-btn"
                        title={tr('list.open')}
                        onClick={() => handleOpenEditTask(t)}
                      >
                        <MessageSquare size={16} />
                      </button>
                      {t.access === 'owner' ? (
                        <button
                          type="button"
                          className="icon-btn danger"
                          title={tr('task.moveToTrash')}
                          onClick={() => handleDeleteTask(t)}
                        >
                          <Trash2 size={16} />
                        </button>
                      ) : null}
                    </>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
