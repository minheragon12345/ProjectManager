import React, { useMemo, useState } from 'react';
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  KeyboardSensor,
  useSensor,
  useSensors,
  useDraggable,
  useDroppable,
  closestCorners,
} from '@dnd-kit/core';
import { GripVertical, Lock, GitBranch } from 'lucide-react';
import { useI18n } from '../i18n';
import './KanbanBoard.css';

// `i18n` field is the dictionary key; resolved at render time.
const BOARD_COLUMNS = [
  { key: 'not_done', i18n: 'board.col.toDo' },
  { key: 'in_progress', i18n: 'board.col.inProgress' },
  { key: 'done', i18n: 'board.col.done' },
  { key: 'cancelled', i18n: 'board.col.cancelled' },
];

const TIME_UNIT_SHORT = { hour: 'h', day: 'd', week: 'w', month: 'mo' };
function unitLabel(unit) {
  return TIME_UNIT_SHORT[unit] || 'd';
}

function deriveColumn(task) {
  if (!task) return 'not_done';
  if (task.status === 'done') return 'done';
  if (task.status === 'cancelled') return 'cancelled';
  const p = Number(task.progress) || 0;
  if (p >= 100) return 'done';
  if (p > 0) return 'in_progress';
  return 'not_done';
}

function patchForColumn(targetCol, task) {
  switch (targetCol) {
    case 'not_done':
      return { status: 'not_done', progress: 0 };
    case 'in_progress': {
      const current = Number(task?.progress) || 0;
      const keep = current > 0 && current < 100;
      return { status: 'not_done', progress: keep ? current : 50 };
    }
    case 'done':
      return { status: 'done', progress: 100 };
    case 'cancelled':
      return { status: 'cancelled' };
    default:
      return null;
  }
}

function KanbanCard({ task, canEdit, onClick, isOverlay = false, timeUnit = 'day', schedule = null }) {
  const { t, locale } = useI18n();
  const id = String(task._id || task.id);
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id,
    disabled: !canEdit,
    data: { type: 'card', task },
  });

  const progress = Number(task.progress) || 0;
  const overdue =
    task.deadline &&
    task.status !== 'done' &&
    task.status !== 'cancelled' &&
    new Date(task.deadline).getTime() < Date.now() &&
    progress < 100;

  const handleClick = (e) => {
    if (isDragging) return;
    if (e.target.closest('.kanban-card-handle')) return;
    onClick?.(task);
  };

  return (
    <div
      ref={setNodeRef}
      className={`kanban-card ${isDragging ? 'is-dragging' : ''} ${isOverlay ? 'is-overlay' : ''} ${overdue ? 'overdue' : ''}`}
      onClick={handleClick}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onClick?.(task);
        }
      }}
    >
      {canEdit ? (
        <span
          className="kanban-card-handle"
          {...attributes}
          {...listeners}
          aria-label="Drag task"
          title="Drag to move"
        >
          <GripVertical size={14} />
        </span>
      ) : null}

      <div className="kanban-card-title">
        {task.title || task.content?.slice(0, 60) || 'Untitled'}
      </div>

      <div className="kanban-card-meta">
        {schedule?.isCritical ? (
          <span className="kanban-chip critical" title={t('chip.criticalFull')}>
            {t('chip.criticalFull')}
          </span>
        ) : schedule && schedule.totalSlack > 0 ? (
          <span className="kanban-chip slack" title={t('chip.slack', { n: schedule.totalSlack, unit: unitLabel(timeUnit) })}>
            {t('chip.slack', { n: schedule.totalSlack, unit: unitLabel(timeUnit) })}
          </span>
        ) : null}
        {task.duration > 0 ? (
          <span className="kanban-chip" title={t('task.duration')}>
            {t('chip.duration', { n: task.duration, unit: unitLabel(timeUnit) })}
          </span>
        ) : null}
        {task.peopleRequired > 1 ? (
          <span className="kanban-chip" title={t('task.peopleRequired')}>
            {t('chip.people', { n: task.peopleRequired })}
          </span>
        ) : null}
        {task.isBlocked ? (
          <span className="kanban-chip blocked" title={t('chip.blocked')}>
            <Lock size={10} /> {t('chip.blocked')}
          </span>
        ) : null}
        {task.subtaskStats?.total > 0 ? (
          <span className="kanban-chip subtask" title={t('task.subtasks')}>
            <GitBranch size={10} /> {t('chip.subtaskCount', { done: task.subtaskStats.done, total: task.subtaskStats.total })}
          </span>
        ) : null}
        {task.deadline ? (
          <span className={overdue ? 'overdue-text' : ''}>
            {new Date(task.deadline).toLocaleDateString(locale)}
          </span>
        ) : null}
      </div>

      {progress > 0 && progress < 100 ? (
        <div className="kanban-progress">
          <div className="kanban-progress-bar">
            <div className="kanban-progress-fill" style={{ width: `${progress}%` }} />
          </div>
          <span className="kanban-progress-text">{progress}%</span>
        </div>
      ) : null}

      {Array.isArray(task.assignees) && task.assignees.length > 0 ? (
        <div className="kanban-assignees">
          {task.assignees.slice(0, 3).map((a) => (
            <span className="assignee-avatar" key={a.id} title={`@${a.username || ''}`}>
              {(a.username || '?')[0].toUpperCase()}
            </span>
          ))}
          {task.assignees.length > 3 ? (
            <span className="assignee-avatar more">+{task.assignees.length - 3}</span>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function KanbanColumn({ column, tasks, canEdit, onCardClick, isOver, timeUnit, scheduleByTaskId }) {
  const { t } = useI18n();
  const { setNodeRef } = useDroppable({
    id: column.key,
    data: { type: 'column', columnKey: column.key },
  });

  return (
    <div
      ref={setNodeRef}
      className={`kanban-column ${isOver ? 'drop-target' : ''}`}
      data-column={column.key}
    >
      <div className="kanban-column-header">
        <span className={`kanban-column-title col-${column.key}`}>{t(column.i18n)}</span>
        <span className="board-count">{tasks.length}</span>
      </div>
      <div className="kanban-column-body">
        {tasks.length === 0 ? (
          <div className="kanban-empty">{canEdit ? t('board.dropHere') : t('board.emptyDash')}</div>
        ) : (
          tasks.map((t) => (
            <KanbanCard
              key={String(t._id || t.id)}
              task={t}
              canEdit={canEdit}
              onClick={onCardClick}
              timeUnit={timeUnit}
              schedule={scheduleByTaskId?.get(String(t._id || t.id)) || null}
            />
          ))
        )}
      </div>
    </div>
  );
}

export default function KanbanBoard({ tasks, canEdit, onTaskMove, onCardClick, timeUnit = 'day', scheduleByTaskId = null }) {
  const [activeTask, setActiveTask] = useState(null);
  const [overColumn, setOverColumn] = useState(null);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor),
  );

  const grouped = useMemo(() => {
    const map = Object.fromEntries(BOARD_COLUMNS.map((c) => [c.key, []]));
    for (const t of tasks || []) {
      const col = deriveColumn(t);
      if (map[col]) map[col].push(t);
    }
    return map;
  }, [tasks]);

  const handleDragStart = (e) => {
    setActiveTask(e.active?.data?.current?.task || null);
  };

  const handleDragOver = (e) => {
    const over = e.over;
    if (!over) {
      setOverColumn(null);
      return;
    }
    const overData = over.data?.current;
    if (overData?.type === 'column') {
      setOverColumn(overData.columnKey);
    } else if (overData?.type === 'card') {
      setOverColumn(deriveColumn(overData.task));
    }
  };

  const handleDragEnd = (e) => {
    const { active, over } = e;
    setActiveTask(null);
    setOverColumn(null);
    if (!over || !active) return;

    const task = active.data?.current?.task;
    if (!task) return;

    const overData = over.data?.current;
    let targetCol = null;
    if (overData?.type === 'column') targetCol = overData.columnKey;
    else if (overData?.type === 'card') targetCol = deriveColumn(overData.task);
    if (!targetCol) return;

    const currentCol = deriveColumn(task);
    if (currentCol === targetCol) return;

    const patch = patchForColumn(targetCol, task);
    if (!patch) return;
    onTaskMove?.(task, patch, targetCol);
  };

  const handleDragCancel = () => {
    setActiveTask(null);
    setOverColumn(null);
  };

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCorners}
      onDragStart={handleDragStart}
      onDragOver={handleDragOver}
      onDragEnd={handleDragEnd}
      onDragCancel={handleDragCancel}
    >
      <div className="kanban-board">
        {BOARD_COLUMNS.map((col) => (
          <KanbanColumn
            key={col.key}
            column={col}
            tasks={grouped[col.key]}
            canEdit={canEdit}
            onCardClick={onCardClick}
            isOver={overColumn === col.key}
            timeUnit={timeUnit}
            scheduleByTaskId={scheduleByTaskId}
          />
        ))}
      </div>
      <DragOverlay>
        {activeTask ? (
          <KanbanCard
            task={activeTask}
            canEdit={false}
            isOverlay
            timeUnit={timeUnit}
            schedule={scheduleByTaskId?.get(String(activeTask._id || activeTask.id)) || null}
          />
        ) : null}
      </DragOverlay>
    </DndContext>
  );
}
