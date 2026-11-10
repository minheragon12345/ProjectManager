import { useCallback, useMemo, useState } from 'react';
import { toast } from 'react-toastify';
import {
  createNote,
  updateNote,
  deleteNote,
  getNoteComments,
  addNoteComment,
  setDependencies,
  createSubtask,
} from '../services/noteService';
import { useI18n } from '../i18n';

export function useTaskEditor({ id, project, fetchTasks, canComment }) {
  const { t: tr } = useI18n();
  const [showTaskModal, setShowTaskModal] = useState(false);
  const [editingTaskId, setEditingTaskId] = useState(null);
  const [editingTaskRef, setEditingTaskRef] = useState(null);
  const [editMode, setEditMode] = useState(false);
  const [editingTaskParent, setEditingTaskParent] = useState(null);
  const [editingSubtaskStats, setEditingSubtaskStats] = useState({ total: 0, done: 0 });
  const [taskForm, setTaskForm] = useState({
    title: '',
    content: '',
    deadline: '',
    progress: 0,
    cancelled: false,
    assignees: [],
    estimatedHours: 0,
    duration: 0,
    peopleRequired: 1,
    minDuration: '',
    marginalCost: '',
  });
  const [taskSaving, setTaskSaving] = useState(false);

  // Pre-save relations: only used while creating a new task (editingTaskId === null).
  // pendingBlockers: array of task summary objects {id, title}.
  // pendingSubtasks: array of {title, content} draft objects.
  const [pendingBlockers, setPendingBlockers] = useState([]);
  const [pendingSubtasks, setPendingSubtasks] = useState([]);
  const [blockerQuery, setBlockerQuery] = useState('');
  const [newSubtaskDraft, setNewSubtaskDraft] = useState({ title: '', content: '' });

  const [commentList, setCommentList] = useState([]);
  const [commentText, setCommentText] = useState('');
  const [commentsLoading, setCommentsLoading] = useState(false);

  const assigneeOptions = useMemo(() => {
    if (!project) return [];
    const out = [];
    if (project.owner?.id) {
      out.push({ id: project.owner.id, label: project.owner.username || project.owner.email || 'Owner', role: 'owner' });
    }
    for (const m of project.members || []) {
      const u = m.user;
      if (!u?.id) continue;
      if (project.owner?.id && u.id === project.owner.id) continue;
      out.push({ id: u.id, label: u.username || u.email || 'Member', role: m.role });
    }
    return out;
  }, [project]);

  const resetTaskForm = () => {
    setTaskForm({
      title: '',
      content: '',
      deadline: '',
      progress: 0,
      cancelled: false,
      assignees: [],
      estimatedHours: 0,
      duration: 0,
      peopleRequired: 1,
      minDuration: '',
      marginalCost: '',
    });
    setCommentList([]);
    setCommentText('');
    setEditingTaskId(null);
    setEditingTaskRef(null);
    setEditingTaskParent(null);
    setEditingSubtaskStats({ total: 0, done: 0 });
    setEditMode(false);
    setPendingBlockers([]);
    setPendingSubtasks([]);
    setBlockerQuery('');
    setNewSubtaskDraft({ title: '', content: '' });
  };

  const handleOpenCreateTask = () => {
    resetTaskForm();
    setEditMode(true);
    setShowTaskModal(true);
  };

  const toDateInputValue = (value) => {
    if (!value) return '';
    const d = new Date(value);
    if (Number.isNaN(d.getTime())) return '';
    return d.toISOString().slice(0, 10);
  };

  const handleOpenEditTask = (task) => {
    if (!task) return;
    setEditingTaskId(task._id || task.id);
    setEditingTaskRef(task);
    setEditingTaskParent(task.parentTask || null);
    setEditingSubtaskStats(task.subtaskStats || { total: 0, done: 0 });
    setEditMode(false);
    setTaskForm({
      title: task.title || '',
      content: task.content || '',
      deadline: toDateInputValue(task.deadline),
      progress: typeof task.progress === 'number' ? task.progress : 0,
      cancelled: task.status === 'cancelled',
      // Drop people who left the project; the picker can't show them, and the
      // backend rejects assignees who aren't members.
      assignees: Array.isArray(task.assignees)
        ? task.assignees
            .map((a) => String(a?.id || a?._id || a))
            .filter((assigneeId) => assigneeOptions.some((option) => option.id === assigneeId))
        : [],
      estimatedHours: typeof task.estimatedHours === 'number' ? task.estimatedHours : 0,
      duration: typeof task.duration === 'number' ? task.duration : 0,
      peopleRequired: typeof task.peopleRequired === 'number' ? task.peopleRequired : 1,
      minDuration: typeof task.minDuration === 'number' ? task.minDuration : '',
      marginalCost: typeof task.marginalCost === 'number' ? task.marginalCost : '',
    });
    fetchTaskComments(task._id || task.id);
    setShowTaskModal(true);
  };

  const handleSaveTask = async (e) => {
    e.preventDefault();
    const content = (taskForm.content || '').trim();
    if (!content) {
      toast.error(tr('task.contentRequired'));
      return;
    }
    const isAutoProgress = (editingSubtaskStats?.total || 0) > 0;
    const progress = Math.max(0, Math.min(100, Number(taskForm.progress) || 0));
    const payload = {
      title: taskForm.title.trim(),
      content,
      project: id,
      deadline: taskForm.deadline || null,
      assignees: Array.isArray(taskForm.assignees) ? taskForm.assignees : [],
      estimatedHours: Math.max(0, Number(taskForm.estimatedHours) || 0),
      duration: Math.max(0, Number(taskForm.duration) || 0),
      peopleRequired: Math.max(1, Math.floor(Number(taskForm.peopleRequired) || 1)),
      minDuration: String(taskForm.minDuration).trim() === '' ? null : Math.max(0, Number(taskForm.minDuration) || 0),
      marginalCost: String(taskForm.marginalCost).trim() === '' ? null : Math.max(0, Number(taskForm.marginalCost) || 0),
    };
    if (isAutoProgress) {
      if (taskForm.cancelled) payload.status = 'cancelled';
      else if (editingTaskRef?.status === 'cancelled') payload.status = 'not_done';
    } else {
      payload.progress = progress;
      payload.status = taskForm.cancelled ? 'cancelled' : progress >= 100 ? 'done' : 'not_done';
    }
    setTaskSaving(true);
    try {
      if (editingTaskId) {
        const resp = await updateNote(editingTaskId, payload);
        toast.success(tr('task.saved'));
        await fetchTasks();
        if (resp?.note) {
          handleOpenEditTask(resp.note);
        } else {
          setEditMode(false);
        }
      } else {
        const createResp = await createNote(payload);
        const newTask = createResp?.note;
        const newId = newTask?._id || newTask?.id;

        // After the task exists, fire-and-collect dependency + subtask follow-ups.
        // Failures here don't undo the create (the task is real), but we report
        // them so the user can retry from the edit modal.
        const followUpErrors = [];
        if (newId) {
          if (pendingBlockers.length) {
            try {
              await setDependencies(newId, pendingBlockers.map((b) => b.id));
            } catch (err) {
              followUpErrors.push(`dependencies: ${err.message}`);
            }
          }
          for (const draft of pendingSubtasks) {
            try {
              await createSubtask(newId, {
                title: draft.title,
                content: draft.content,
                project: id,
              });
            } catch (err) {
              followUpErrors.push(`subtask "${draft.title || draft.content?.slice(0, 30)}": ${err.message}`);
            }
          }
        }

        if (followUpErrors.length) {
          toast.warn(tr('task.followUpFailed', { n: followUpErrors.length }));
          followUpErrors.forEach((m) => console.warn(m));
        } else {
          toast.success(tr('task.created'));
        }
        setShowTaskModal(false);
        resetTaskForm();
        await fetchTasks();
      }
    } catch (err) {
      toast.error(err.message || tr('task.saveFailed'));
    } finally {
      setTaskSaving(false);
    }
  };

  const handleDeleteTask = async (task) => {
    if (task.access !== 'owner') {
      toast.info(tr('task.trashOwnerOnly'));
      return;
    }
    if (!window.confirm(tr('settings.moveToTrashConfirm'))) return;
    try {
      await deleteNote(task._id || task.id);
      toast.success(tr('common.delete'));
      fetchTasks();
    } catch (err) {
      toast.error(err.message || tr('mytime.deleteFailed'));
    }
  };

  const fetchTaskComments = useCallback(async (taskId) => {
    if (!taskId) return;
    try {
      setCommentsLoading(true);
      const res = await getNoteComments(taskId);
      setCommentList(res?.comments || []);
    } catch (err) {
      toast.error(err.message || 'Failed to load comments');
    } finally {
      setCommentsLoading(false);
    }
  }, []);

  const handleSendComment = async () => {
    if (!editingTaskId || !canComment) return;
    if (!commentText.trim()) return;
    try {
      setCommentsLoading(true);
      await addNoteComment(editingTaskId, commentText.trim());
      setCommentText('');
      await fetchTaskComments(editingTaskId);
      toast.success(tr('task.commentPosted'));
    } catch (err) {
      toast.error(err.message || tr('task.commentFailed'));
    } finally {
      setCommentsLoading(false);
    }
  };

  const handleCloseTaskModal = () => {
    if (taskSaving) return;
    setShowTaskModal(false);
    resetTaskForm();
  };

  return {
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
    handleOpenCreateTask,
    handleOpenEditTask,
    handleSaveTask,
    handleDeleteTask,
    handleSendComment,
    handleCloseTaskModal,
  };
}

export default useTaskEditor;
