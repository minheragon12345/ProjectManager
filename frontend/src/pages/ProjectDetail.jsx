import React, { useCallback, useEffect, useMemo, useState, lazy, Suspense } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { toast } from 'react-toastify';
import {
  ArrowLeft,
  LayoutGrid,
  List,
  Settings,
  Save,
  Loader,
  UserPlus,
  Trash2,
  Archive,
  Moon,
  Sun,
  Monitor,
  FolderKanban,
  Plus,
  X,
  BarChart3,
  GanttChart,
  Lock,
  GitBranch,
  ScrollText,
  MessageSquare,
  Search,
  RefreshCcw,
  LogOut,
} from 'lucide-react';
import {
  getProject,
  updateProject,
  archiveProject,
  deleteProject,
  getProjectMembers,
  addProjectMember,
  updateProjectMemberRole,
  removeProjectMember,
  getBudgetSummary,
  getProjectAuditLog,
} from '../services/projectService';
import {
  getNotes,
  createNote,
  updateNote,
  deleteNote,
  getTrashNotes,
  restoreNote,
  deleteNotePermanent,
  getNoteComments,
  addNoteComment,
  setDependencies,
  createSubtask,
} from '../services/noteService';
import KanbanBoard from '../components/KanbanBoard';
import TimeLogSection from '../components/TimeLogSection';
import TaskRelationsSection from '../components/TaskRelationsSection';
import ErrorBoundary from '../components/ErrorBoundary';
const ProjectDashboard = lazy(() => import('../components/ProjectDashboard'));
const ProjectGantt = lazy(() => import('../components/ProjectGantt'));
const ResourceCurve = lazy(() => import('../components/ResourceCurve'));
import CrashingAnalysis from '../components/CrashingAnalysis';
import { useTheme } from '../hooks/useTheme';
import { useI18n } from '../i18n';
import LanguageSwitcher from '../components/LanguageSwitcher';
import { useSchedule } from '../hooks/useSchedule';
import './ProjectDetail.css';

const TIME_UNIT_SHORT = { hour: 'h', day: 'd', week: 'w', month: 'mo' };
function unitLabel(unit) {
  return TIME_UNIT_SHORT[unit] || 'd';
}

// Convert a Project doc's lost-revenue fields into the row-editor's state.
//   - Empty / null:        single empty linear row
//   - lostRevenueByDuration set: one row per entry, sorted by descending duration
//   - lostRevenuePerUnit set:   single linear row (no duration), rate = perUnit
function hydrateLostRevenueRows(p) {
  if (p?.lostRevenueByDuration && typeof p.lostRevenueByDuration === 'object') {
    const entries = Object.entries(p.lostRevenueByDuration);
    if (entries.length > 0) {
      return entries
        .map(([d, r]) => ({ duration: String(d), revenue: String(r) }))
        .sort((a, b) => Number(b.duration) - Number(a.duration));
    }
  }
  if (p?.lostRevenuePerUnit != null && p.lostRevenuePerUnit !== '') {
    return [{ duration: '', revenue: String(p.lostRevenuePerUnit) }];
  }
  return [{ duration: '', revenue: '' }];
}

// Pack rows into the two backend fields. Returns { lostRevenuePerUnit, lostRevenueByDuration }.
// Rules: exactly 1 row with no duration → linear; 2+ rows → table; mixed → error.
function serializeLostRevenue(rows) {
  const filled = (rows || []).filter((r) => String(r.revenue).trim() !== '');
  if (filled.length === 0) {
    return { lostRevenuePerUnit: null, lostRevenueByDuration: null };
  }
  if (filled.length === 1 && String(filled[0].duration).trim() === '') {
    const rev = Number(filled[0].revenue);
    if (!Number.isFinite(rev) || rev < 0) {
      throw new Error('Lost revenue rate must be a number >= 0');
    }
    return { lostRevenuePerUnit: rev, lostRevenueByDuration: null };
  }
  // Table mode: every row needs a duration.
  const table = {};
  for (const r of filled) {
    const d = Number(r.duration);
    const rev = Number(r.revenue);
    if (!Number.isFinite(d) || d < 0 || String(r.duration).trim() === '') {
      throw new Error('Every lost-revenue row needs a duration when there is more than one');
    }
    if (!Number.isFinite(rev) || rev < 0) {
      throw new Error(`Revenue for duration ${d} must be a number >= 0`);
    }
    table[String(d)] = rev;
  }
  return { lostRevenuePerUnit: null, lostRevenueByDuration: table };
}

// Tabs carry an i18n key. Render-time lookup via t('tab.<key>').
const TABS_BASE = [
  { key: 'board', icon: LayoutGrid },
  { key: 'list', icon: List },
  { key: 'timeline', icon: GanttChart },
  { key: 'dashboard', icon: BarChart3 },
  { key: 'settings', icon: Settings },
];

const LOG_TAB = { key: 'log', icon: ScrollText };

const MEMBER_ROLE_OPTIONS = [
  { value: 'moderator', label: 'Moderator (edit + view log)' },
  { value: 'editor', label: 'Editor (edit)' },
  { value: 'reviewer', label: 'Reviewer (comment only)' },
  { value: 'viewer', label: 'Viewer (read-only)' },
];


const ProjectDetail = () => {
  const { id } = useParams();
  const navigate = useNavigate();
  // Aliased to `tr` because this file uses the identifier `t` for task variables
  // inside .map / .find arrow bodies (e.g. `tasks.map((t) => ...)`). Keeping the
  // i18n function on its own name avoids accidental shadowing inside callbacks.
  const { t: tr } = useI18n();

  const [project, setProject] = useState(null);
  const [loading, setLoading] = useState(true);
  const { pref: themePref, resolved: theme, cycle: cycleTheme } = useTheme();
  const [tab, setTab] = useState('board');

  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState({
    name: '',
    description: '',
    startDate: '',
    endDate: '',
    budgetAmount: 0,
    budgetCurrency: 'USD',
    budgetType: 'hourly',
    timeUnit: 'day',
    maxHeadcount: '',
    // Lost revenue is edited as a list of rows. One row with empty duration =
    // linear (revenue / unit). 2+ rows = lookup table keyed by duration.
    lostRevenueRows: [{ duration: '', revenue: '' }],
  });

  const [members, setMembers] = useState([]);
  const [memberEmail, setMemberEmail] = useState('');
  const [memberRole, setMemberRole] = useState('editor');
  const [memberSaving, setMemberSaving] = useState(false);
  const [pendingMemberId, setPendingMemberId] = useState(null);
  const [leaving, setLeaving] = useState(false);
  const [budgetSummary, setBudgetSummary] = useState(null);
  const [budgetLoading, setBudgetLoading] = useState(false);

  const [tasks, setTasks] = useState([]);
  const [tasksLoading, setTasksLoading] = useState(false);
  const [constrainedMode, setConstrainedMode] = useState(false);
  const {
    byTaskId: scheduleByTaskId,
    schedule,
    refresh: refreshSchedule,
    error: scheduleError,
  } = useSchedule(id, { constrained: constrainedMode });
  const [ganttBarMode, setGanttBarMode] = useState('Earliest'); // 'Earliest' | 'Latest'
  const [ganttGranularity, setGanttGranularity] = useState('Day');
  const [listSearch, setListSearch] = useState('');
  const [listTrashView, setListTrashView] = useState(false);
  const [trashTasks, setTrashTasks] = useState([]);
  const [trashLoading, setTrashLoading] = useState(false);
  const [showTaskModal, setShowTaskModal] = useState(false);
  const [editingTaskId, setEditingTaskId] = useState(null);
  const [editingTaskRef, setEditingTaskRef] = useState(null);
  const [editMode, setEditMode] = useState(false);
  const [editingTaskParent, setEditingTaskParent] = useState(null);
  const [editingSubtaskStats, setEditingSubtaskStats] = useState({ total: 0, done: 0 });
  const [taskForm, setTaskForm] = useState({
    title: '',
    content: '',
    priority: 0,
    deadline: '',
    progress: 0,
    category: 'Other',
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

  const [logItems, setLogItems] = useState([]);
  const [logLoading, setLogLoading] = useState(false);

  const [commentList, setCommentList] = useState([]);
  const [commentText, setCommentText] = useState('');
  const [commentsLoading, setCommentsLoading] = useState(false);

  const user = useMemo(() => {
    try {
      const s = localStorage.getItem('user');
      return s ? JSON.parse(s) : null;
    } catch {
      return null;
    }
  }, []);

  const fetchProject = useCallback(async () => {
    setLoading(true);
    try {
      const data = await getProject(id);
      const p = data?.project;
      if (!p) throw new Error('Project not found');
      setProject(p);
      setForm({
        name: p.name || '',
        description: p.description || '',
        startDate: p.startDate ? new Date(p.startDate).toISOString().slice(0, 10) : '',
        endDate: p.endDate ? new Date(p.endDate).toISOString().slice(0, 10) : '',
        budgetAmount: p.budget?.amount ?? 0,
        budgetCurrency: p.budget?.currency || 'USD',
        budgetType: p.budget?.type || 'hourly',
        timeUnit: p.timeUnit || 'day',
        maxHeadcount: p.maxHeadcount ?? '',
        lostRevenueRows: hydrateLostRevenueRows(p),
      });
    } catch (err) {
      toast.error(err.message || 'Failed to load project');
      navigate('/projects');
    } finally {
      setLoading(false);
    }
  }, [id, navigate]);

  const fetchMembers = useCallback(async () => {
    try {
      const data = await getProjectMembers(id);
      setMembers(Array.isArray(data?.members) ? data.members : []);
    } catch (err) {
      toast.error(err.message || 'Failed to load members');
    }
  }, [id]);

  const fetchBudgetSummary = useCallback(async () => {
    setBudgetLoading(true);
    try {
      const data = await getBudgetSummary(id);
      setBudgetSummary(data);
    } catch (err) {
      // non-fatal: log only
      console.warn('budget summary failed:', err.message);
    } finally {
      setBudgetLoading(false);
    }
  }, [id]);

  const fetchLog = useCallback(async () => {
    setLogLoading(true);
    try {
      const data = await getProjectAuditLog(id, { limit: 200 });
      setLogItems(Array.isArray(data?.items) ? data.items : []);
    } catch (err) {
      toast.error(err.message || 'Failed to load log');
    } finally {
      setLogLoading(false);
    }
  }, [id]);

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
      toast.success('Restored');
      fetchTrash();
    } catch (err) {
      toast.error(err.message || 'Failed to restore');
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

  const fetchTasks = useCallback(async () => {
    setTasksLoading(true);
    try {
      const data = await getNotes('', 'all', { projectId: id });
      setTasks(Array.isArray(data?.notes) ? data.notes : []);
      refreshSchedule();
    } catch (err) {
      toast.error(err.message || 'Failed to load tasks');
    } finally {
      setTasksLoading(false);
    }
  }, [id, refreshSchedule]);

  useEffect(() => {
    const token = localStorage.getItem('token');
    if (!token) {
      navigate('/login');
      return;
    }
    fetchProject();
  }, [fetchProject, navigate]);

  const isOwner = project?.role === 'owner';
  const canEdit = project?.role === 'owner' || project?.role === 'moderator' || project?.role === 'editor';
  const canManageProject = project?.role === 'owner' || project?.role === 'moderator';
  const canViewLog = project?.role === 'owner' || project?.role === 'moderator';
  const canComment = project?.role === 'owner' || project?.role === 'moderator' || project?.role === 'editor' || project?.role === 'reviewer';
  // Insert Log tab right before Settings (the last entry of TABS_BASE).
  const TABS = canViewLog
    ? [...TABS_BASE.slice(0, -1), LOG_TAB, TABS_BASE[TABS_BASE.length - 1]]
    : TABS_BASE;

  useEffect(() => {
    if (project && tab === 'settings') {
      fetchMembers();
      fetchBudgetSummary();
    }
    if (project && (tab === 'board' || tab === 'list' || tab === 'timeline')) fetchTasks();
    if (project && tab === 'list' && listTrashView) fetchTrash();
    if (project && tab === 'log' && canViewLog) fetchLog();
  }, [project, tab, listTrashView, fetchMembers, fetchBudgetSummary, fetchTasks, fetchTrash, fetchLog, canViewLog]);

  const roleStats = useMemo(() => {
    const editors = members.filter((m) => m.role === 'editor').length;
    const viewers = members.filter((m) => m.role === 'viewer').length;
    return { editors, viewers, total: 1 + editors + viewers };
  }, [members]);

  const myMembership = useMemo(() => {
    const myId = user?.id;
    if (!myId) return null;
    return members.find((m) => m.user?.id === myId) || null;
  }, [members, user]);

  const formatMemberDate = (value) => {
    if (!value) return '—';
    const d = new Date(value);
    if (Number.isNaN(d.getTime())) return '—';
    return d.toLocaleDateString('vi-VN');
  };

  const initialOf = (name) => (name ? String(name).trim()[0]?.toUpperCase() || '?' : '?');

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

  const handleSaveSettings = async (e) => {
    e.preventDefault();
    if (!form.name.trim()) {
      toast.error('Project name cannot be empty');
      return;
    }
    setSaving(true);
    try {
      const headcountRaw = String(form.maxHeadcount).trim();
      let lostRevenuePayload;
      try {
        lostRevenuePayload = serializeLostRevenue(form.lostRevenueRows);
      } catch (err) {
        toast.error(err.message);
        setSaving(false);
        return;
      }
      await updateProject(id, {
        name: form.name.trim(),
        description: form.description.trim(),
        startDate: form.startDate || null,
        endDate: form.endDate || null,
        budget: {
          amount: Number(form.budgetAmount) || 0,
          currency: form.budgetCurrency || 'USD',
          type: form.budgetType || 'hourly',
        },
        timeUnit: form.timeUnit || 'day',
        maxHeadcount: headcountRaw === '' ? null : Number(headcountRaw),
        ...lostRevenuePayload,
      });
      toast.success('Changes saved');
      fetchProject();
    } catch (err) {
      toast.error(err.message || 'Failed to save');
    } finally {
      setSaving(false);
    }
  };

  const handleArchive = async () => {
    try {
      await archiveProject(id);
      toast.success(project?.status === 'archived' ? 'Restored' : 'Archived');
      fetchProject();
    } catch (err) {
      toast.error(err.message || 'Error');
    }
  };

  const handleDelete = async () => {
    if (!window.confirm(tr('settings.deleteProjectConfirm', { name: project?.name || '' }))) return;
    try {
      await deleteProject(id);
      toast.success(tr('projects.deleted'));
      navigate('/projects');
    } catch (err) {
      toast.error(err.message || tr('projects.deleted'));
    }
  };

  const handleAddMember = async (e) => {
    e.preventDefault();
    if (!memberEmail.trim()) {
      toast.error('Email cannot be empty');
      return;
    }
    setMemberSaving(true);
    try {
      await addProjectMember(id, { email: memberEmail.trim(), role: memberRole });
      toast.success('Member added');
      setMemberEmail('');
      fetchMembers();
    } catch (err) {
      toast.error(err.message || 'Failed to add member');
    } finally {
      setMemberSaving(false);
    }
  };

  const handleChangeMemberRole = async (memberUserId, role) => {
    setPendingMemberId(memberUserId);
    try {
      await updateProjectMemberRole(id, memberUserId, role);
      toast.success('Role updated');
      fetchMembers();
    } catch (err) {
      toast.error(err.message || 'Error');
    } finally {
      setPendingMemberId(null);
    }
  };

  const handleRemoveMember = async (memberUserId) => {
    if (!window.confirm('Remove this member from the project?')) return;
    setPendingMemberId(memberUserId);
    try {
      await removeProjectMember(id, memberUserId);
      toast.success('Member removed');
      fetchMembers();
    } catch (err) {
      toast.error(err.message || 'Error');
    } finally {
      setPendingMemberId(null);
    }
  };

  const handleLeaveProject = async () => {
    const myId = user?.id;
    if (!myId) {
      toast.error('Cannot identify current user.');
      return;
    }
    if (!window.confirm(tr('settings.leaveConfirm', { name: project?.name || '' }))) return;
    setLeaving(true);
    try {
      await removeProjectMember(id, myId);
      toast.success(tr('settings.leaveProject'));
      navigate('/projects');
    } catch (err) {
      toast.error(err.message || 'Failed to leave project');
    } finally {
      setLeaving(false);
    }
  };

  const resetTaskForm = () => {
    setTaskForm({
      title: '',
      content: '',
      priority: 0,
      deadline: '',
      progress: 0,
      category: 'Other',
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
      priority: typeof task.priority === 'number' ? task.priority : 0,
      deadline: toDateInputValue(task.deadline),
      progress: typeof task.progress === 'number' ? task.progress : 0,
      category: task.category || 'Other',
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
      toast.error('Content cannot be empty');
      return;
    }
    const isAutoProgress = (editingSubtaskStats?.total || 0) > 0;
    const progress = Math.max(0, Math.min(100, Number(taskForm.progress) || 0));
    const payload = {
      title: taskForm.title.trim(),
      content,
      project: id,
      priority: Number(taskForm.priority) || 0,
      deadline: taskForm.deadline || null,
      category: taskForm.category || 'Other',
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
        toast.success('Task saved');
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
          toast.warn(`Task created, but ${followUpErrors.length} follow-up(s) failed. Open task to retry.`);
          followUpErrors.forEach((m) => console.warn(m));
        } else {
          toast.success('Task created');
        }
        setShowTaskModal(false);
        resetTaskForm();
        await fetchTasks();
      }
    } catch (err) {
      toast.error(err.message || 'Failed to save task');
    } finally {
      setTaskSaving(false);
    }
  };

  const handleToggleTaskDone = async (task) => {
    const newStatus = task.status === 'done' ? 'not_done' : 'done';
    if (newStatus === 'done' && task.isBlocked) {
      const blockerCount = (task.dependencies || []).length;
      if (!window.confirm(`This task has ${blockerCount} unfinished blocker${blockerCount === 1 ? '' : 's'}. Mark done anyway?`)) {
        return;
      }
    }
    if ((task.subtaskStats?.total || 0) > 0) {
      toast.info('A parent task\'s status follows its subtasks. Update the subtasks instead.');
      return;
    }
    try {
      await updateNote(task._id || task.id, {
        status: newStatus,
        progress: newStatus === 'done' ? 100 : 0,
      });
      fetchTasks();
    } catch (err) {
      toast.error(err.message || 'Could not update');
    }
  };

  const handleTaskMove = async (task, patch) => {
    const tid = task._id || task.id;
    if (patch.status === 'done' && task.isBlocked) {
      const blockerCount = (task.dependencies || []).length;
      if (!window.confirm(`This task has ${blockerCount} unfinished blocker${blockerCount === 1 ? '' : 's'}. Mark done anyway?`)) {
        return;
      }
    }
    const isParentTask = (task.subtaskStats?.total || 0) > 0;
    if (isParentTask && task.status !== 'cancelled' && (patch.status === 'done' || patch.status === 'not_done')) {
      toast.info('A parent task\'s status follows its subtasks. Move the subtasks instead.');
      return;
    }
    // Reopening a cancelled parent: send only the status, its progress comes from the subtasks.
    const body = isParentTask && patch.status !== 'cancelled' ? { status: 'not_done' } : patch;
    const previous = tasks;
    setTasks((prev) =>
      prev.map((t) => ((t._id || t.id) === tid ? { ...t, ...body } : t)),
    );
    try {
      await updateNote(tid, body);
      fetchTasks();
    } catch (err) {
      setTasks(previous);
      toast.error(err.message || 'Could not move task');
    }
  };

  const handleDeleteTask = async (task) => {
    if (task.access !== 'owner') {
      toast.info('Only the task owner can move it to trash.');
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
      toast.success('Comment posted');
    } catch (err) {
      toast.error(err.message || 'Failed');
    } finally {
      setCommentsLoading(false);
    }
  };

  const handleCloseTaskModal = () => {
    if (taskSaving) return;
    setShowTaskModal(false);
    resetTaskForm();
  };

  const toggleTheme = cycleTheme;

  if (loading || !project) {
    return (
      <div className={`project-detail-container ${theme === 'dark' ? 'dark-theme' : ''}`}>
        <div className="projects-loading">
          <Loader className="spin" size={28} />
          <span>Loading project…</span>
        </div>
      </div>
    );
  }

  return (
    <div className={`project-detail-container ${theme === 'dark' ? 'dark-theme' : ''}`}>
      <div className="project-detail-header">
        <button className="btn-secondary" onClick={() => navigate('/projects')}>
          <ArrowLeft size={16} />
          <span>{tr('common.back')}</span>
        </button>

        <div className="project-title-block">
          <h2>
            <FolderKanban size={22} style={{ verticalAlign: 'middle', marginRight: 8 }} />
            {project.name}
            {project.status === 'archived' ? (
              <span className="badge-archived" style={{ marginLeft: 8 }}>Archived</span>
            ) : null}
          </h2>
          <div className="project-sub">
            <span className={`project-role role-${project.role}`}>{project.role}</span>
            <span className="project-sub-dot">•</span>
            <span>
              {tr('header.owner')} <strong>{project.owner?.username || project.owner?.email || '—'}</strong>
            </span>
            <span className="project-sub-dot">•</span>
            <span>{tr('header.members')} {members?.length || project.members?.length || 0}</span>
          </div>
        </div>

        <div className="action-buttons">
          <LanguageSwitcher />
          <button className="icon-btn" onClick={toggleTheme} title={`Theme: ${themePref}`}>
            {themePref === 'light' ? (
              <Sun size={18} />
            ) : themePref === 'dark' ? (
              <Moon size={18} />
            ) : (
              <Monitor size={18} />
            )}
          </button>
          {isOwner && !project.isPersonal ? (
            <button className="btn-secondary" onClick={handleArchive}>
              <Archive size={16} />
              <span>{project.status === 'archived' ? tr('common.restore') : tr('common.archive')}</span>
            </button>
          ) : null}
          <button
            className="btn-secondary"
            onClick={() => {
              localStorage.removeItem('token');
              localStorage.removeItem('user');
              window.dispatchEvent(new Event('authChange'));
              navigate('/login');
            }}
            title="Sign out"
          >
            <LogOut size={16} />
            <span>{tr('common.logout')}</span>
          </button>
        </div>
      </div>

      <div className="project-tabs">
        {TABS.map(({ key, icon: Icon }) => (
          <button
            key={key}
            className={`tab ${tab === key ? 'active' : ''}`}
            onClick={() => setTab(key)}
          >
            <Icon size={16} />
            <span>{tr('tab.' + key)}</span>
          </button>
        ))}
      </div>

      <div className="project-tab-content">
        {tab === 'board' ? (
          <div className="board-preview">
            <div className="board-preview-header">
              <p className="board-preview-note">{tr('board.hint')}</p>
              {canEdit ? (
                <button className="btn-primary" onClick={handleOpenCreateTask}>
                  <Plus size={16} />
                  <span>{tr('board.newTask')}</span>
                </button>
              ) : null}
            </div>
            {tasksLoading ? (
              <div className="projects-loading"><Loader className="spin" size={24} /> <span>{tr('common.loading')}</span></div>
            ) : (
              <KanbanBoard
                tasks={tasks}
                canEdit={canEdit}
                onTaskMove={handleTaskMove}
                onCardClick={handleOpenEditTask}
                timeUnit={project?.timeUnit || 'day'}
                scheduleByTaskId={scheduleByTaskId}
              />
            )}
          </div>
        ) : tab === 'dashboard' ? (
          <Suspense fallback={<div className="projects-loading"><Loader className="spin" size={24} /> <span>{tr('dash.loading')}</span></div>}>
            <ProjectDashboard projectId={id} currency={form.budgetCurrency || 'USD'} />
          </Suspense>
        ) : tab === 'timeline' ? (
          <div className="timeline-panel">
            <div className="gantt-toolbar">
              <div className="toggle-group" role="group" aria-label="Bar position">
                <button
                  type="button"
                  className={ganttBarMode === 'Earliest' ? 'active' : ''}
                  onClick={() => setGanttBarMode('Earliest')}
                >
                  {tr('gantt.earliestStart')}
                </button>
                <button
                  type="button"
                  className={ganttBarMode === 'Latest' ? 'active' : ''}
                  onClick={() => setGanttBarMode('Latest')}
                >
                  {tr('gantt.latestStart')}
                </button>
              </div>
              <div className="toggle-group" role="group" aria-label="View granularity">
                {[['Day', 'gantt.day'], ['Week', 'gantt.week'], ['Month', 'gantt.month']].map(([m, key]) => (
                  <button
                    key={m}
                    type="button"
                    className={ganttGranularity === m ? 'active' : ''}
                    onClick={() => setGanttGranularity(m)}
                  >
                    {tr(key)}
                  </button>
                ))}
              </div>
              <div
                className="toggle-group"
                role="group"
                aria-label="Resource mode"
                title={project?.maxHeadcount == null ? tr('gantt.enableConstrainedHint') : ''}
              >
                <button
                  type="button"
                  className={!constrainedMode ? 'active' : ''}
                  onClick={() => setConstrainedMode(false)}
                >
                  {tr('gantt.unlimited')}
                </button>
                <button
                  type="button"
                  className={constrainedMode ? 'active' : ''}
                  onClick={() => setConstrainedMode(true)}
                  disabled={project?.maxHeadcount == null}
                >
                  {project?.maxHeadcount != null
                    ? tr('gantt.constrainedCap', { cap: project.maxHeadcount })
                    : tr('gantt.constrained')}
                </button>
              </div>
              <div className="gantt-header-info">
                {schedule ? (
                  <>
                    <span>
                      {tr('gantt.duration')} <strong>{schedule.projectDuration}{unitLabel(schedule.timeUnit || 'day')}</strong>
                    </span>
                    <span>
                      {tr('gantt.critical')} <strong>{tr('gantt.criticalTasks', { n: schedule.criticalPath?.length || 0 })}</strong>
                    </span>
                  </>
                ) : null}
              </div>
            </div>
            {constrainedMode && schedule && schedule.mode === 'constrained' && schedule.delay > 0 ? (
              <div className="gantt-banner">
                {tr('gantt.delayBanner', {
                  cap: schedule.maxHeadcount,
                  delay: schedule.delay,
                  unit: unitLabel(schedule.timeUnit || 'day'),
                  was: schedule.unconstrainedDuration,
                  now: schedule.projectDuration,
                })}
              </div>
            ) : null}
            {constrainedMode && scheduleError ? (
              <div className="gantt-banner error">
                {tr('gantt.constrainedFailed', { msg: scheduleError })}
              </div>
            ) : null}
            {tasksLoading || !schedule ? (
              <div className="projects-loading"><Loader className="spin" size={24} /> <span>{tr('common.loading')}</span></div>
            ) : (schedule?.tasks?.length || 0) === 0 ? (
              <div className="gantt-empty">
                {tr('gantt.empty')}
              </div>
            ) : (
              <ErrorBoundary label="Gantt failed to render">
                <Suspense fallback={<div className="projects-loading"><Loader className="spin" size={24} /> <span>{tr('common.loading')}</span></div>}>
                  <ProjectGantt
                    schedule={schedule}
                    projectStart={project?.startDate || new Date()}
                    viewMode={ganttBarMode}
                    ganttViewMode={ganttGranularity}
                    onTaskClick={(taskId) => {
                      const t = tasks.find((x) => String(x._id || x.id) === String(taskId));
                      if (t) handleOpenEditTask(t);
                    }}
                  />
                </Suspense>
              </ErrorBoundary>
            )}
            {schedule && (schedule.tasks?.length || 0) > 0 ? (
              <ErrorBoundary label="Resource curve failed to render">
                <Suspense fallback={null}>
                  <ResourceCurve
                    projectId={id}
                    refreshKey={`${schedule.projectDuration}|${tasks.length}`}
                  />
                </Suspense>
              </ErrorBoundary>
            ) : null}

            {(() => {
              const hasLinear = project?.lostRevenuePerUnit != null;
              const hasTable = project?.lostRevenueByDuration
                && Object.keys(project.lostRevenueByDuration).length > 0;
              const ready = hasLinear || hasTable;
              if (!ready) return null;
              return (
                <div className="timeline-crashing">
                  <h3>{tr('opt.heading')}</h3>
                  <ErrorBoundary label="Crashing analysis failed to render">
                    <CrashingAnalysis projectId={id} project={project} refreshKey={tasks.length} />
                  </ErrorBoundary>
                </div>
              );
            })()}
          </div>
        ) : tab === 'list' ? (
          (() => {
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
                        aria-label="Mark as done"
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
                              {tr('list.deadlinePrefix', { date: new Date(t.deadline).toLocaleDateString('vi-VN') })}
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
                              title="Restore"
                              onClick={() => handleRestoreTask(t)}
                            >
                              <RefreshCcw size={16} />
                            </button>
                            <button
                              type="button"
                              className="icon-btn danger"
                              title="Delete permanently"
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
                              title="Open"
                              onClick={() => handleOpenEditTask(t)}
                            >
                              <MessageSquare size={16} />
                            </button>
                            {t.access === 'owner' ? (
                              <button
                                type="button"
                                className="icon-btn danger"
                                title="Move to trash"
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
          })()
        ) : tab === 'log' ? (
          <div className="audit-log-panel">
            <div className="audit-log-header">
              <h3>{tr('log.heading')} {logItems.length ? `(${logItems.length})` : ''}</h3>
              {logLoading ? <Loader size={14} className="spin" /> : null}
            </div>
            {!canViewLog ? (
              <div className="tab-placeholder"><p>{tr('log.noAccess')}</p></div>
            ) : logLoading && logItems.length === 0 ? (
              <div className="projects-loading"><Loader className="spin" size={24} /> <span>{tr('common.loading')}</span></div>
            ) : logItems.length === 0 ? (
              <div className="tab-placeholder"><ScrollText size={36} /><p>{tr('log.empty')}</p></div>
            ) : (
              <div className="audit-log-list">
                {logItems.map((l) => (
                  <div className="audit-log-row" key={l.id}>
                    <span className="audit-log-time">
                      {l.createdAt ? new Date(l.createdAt).toLocaleString('vi-VN') : '—'}
                    </span>
                    <span className="audit-log-actor">
                      {l.actor?.username || l.actor?.email || tr('log.unknownActor')}
                    </span>
                    <span className="audit-log-action">{l.action}</span>
                    <span className="audit-log-target">
                      {l.targetType}{l.targetId ? `:${String(l.targetId).slice(-6)}` : ''}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>
        ) : (
          <div className="settings-panel">
            <form className="settings-form" onSubmit={handleSaveSettings}>
              <h3>{tr('settings.projectInfo')}</h3>
              <label>
                <span>{tr('settings.projectName')}</span>
                <input type="text" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} disabled={!canManageProject} maxLength={120} />
              </label>
              <label>
                <span>{tr('settings.description')}</span>
                <textarea value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} disabled={!canManageProject} rows={3} maxLength={2000} />
              </label>

              <div className="form-row">
                <label>
                  <span>{tr('settings.startDate')}</span>
                  <input type="date" value={form.startDate} onChange={(e) => setForm({ ...form, startDate: e.target.value })} disabled={!canManageProject} />
                </label>
                <label>
                  <span>{tr('settings.endDate')}</span>
                  <input type="date" value={form.endDate} onChange={(e) => setForm({ ...form, endDate: e.target.value })} disabled={!canManageProject} />
                </label>
              </div>

              <div className="form-row">
                <label>
                  <span>{tr('settings.budget')}</span>
                  <input type="number" min="0" step="0.01" value={form.budgetAmount} onChange={(e) => setForm({ ...form, budgetAmount: e.target.value })} disabled={!canManageProject} />
                </label>
                <label>
                  <span>{tr('settings.currency')}</span>
                  <input type="text" maxLength={8} value={form.budgetCurrency} onChange={(e) => setForm({ ...form, budgetCurrency: e.target.value.toUpperCase() })} disabled={!canManageProject} />
                </label>
                <label>
                  <span>{tr('settings.budgetType')}</span>
                  <select value={form.budgetType} onChange={(e) => setForm({ ...form, budgetType: e.target.value })} disabled={!canManageProject}>
                    <option value="hourly">{tr('settings.budgetType.hourly')}</option>
                    <option value="fixed">{tr('settings.budgetType.fixed')}</option>
                  </select>
                </label>
              </div>

              <div className="form-row">
                <label>
                  <span>{tr('settings.timeUnit')}</span>
                  <select value={form.timeUnit} onChange={(e) => setForm({ ...form, timeUnit: e.target.value })} disabled={!canManageProject}>
                    <option value="hour">{tr('settings.timeUnit.hour')}</option>
                    <option value="day">{tr('settings.timeUnit.day')}</option>
                    <option value="week">{tr('settings.timeUnit.week')}</option>
                    <option value="month">{tr('settings.timeUnit.month')}</option>
                  </select>
                </label>
                <label>
                  <span>{tr('settings.maxHeadcount')}</span>
                  <input
                    type="number"
                    min="1"
                    step="1"
                    placeholder={tr('common.unset')}
                    value={form.maxHeadcount}
                    onChange={(e) => setForm({ ...form, maxHeadcount: e.target.value })}
                    disabled={!canManageProject}
                  />
                </label>
              </div>

              <fieldset className="lost-rev-editor" disabled={!canManageProject}>
                <legend>
                  {tr('settings.lostRevenue')}
                  <span className="lost-rev-mode-pill">
                    {form.lostRevenueRows.length <= 1
                      && String(form.lostRevenueRows[0]?.duration || '').trim() === ''
                        ? tr('settings.lostRevMode.linear')
                        : tr('settings.lostRevMode.table')}
                  </span>
                </legend>
                <div className="lost-rev-row-list">
                  {form.lostRevenueRows.length > 1 ? (
                    <div className="lost-rev-row lost-rev-head">
                      <span>{tr('settings.lostRev.duration', { unit: unitLabel(form.timeUnit || 'day') })}</span>
                      <span>{tr('settings.lostRev.revenue')}</span>
                      <span />
                    </div>
                  ) : null}
                  {form.lostRevenueRows.map((row, i) => {
                    const isSingle = form.lostRevenueRows.length === 1;
                    return (
                      <div className="lost-rev-row" key={i}>
                        {isSingle && String(row.duration || '').trim() === '' ? (
                          <span className="lost-rev-rate-label">{tr('settings.lostRev.perUnit')}</span>
                        ) : (
                          <input
                            type="number"
                            min="0"
                            step="0.5"
                            className="custom-input"
                            placeholder="duration"
                            value={row.duration}
                            onChange={(e) => {
                              const next = form.lostRevenueRows.slice();
                              next[i] = { ...next[i], duration: e.target.value };
                              setForm({ ...form, lostRevenueRows: next });
                            }}
                          />
                        )}
                        <input
                          type="number"
                          min="0"
                          step="0.01"
                          className="custom-input"
                          placeholder="revenue"
                          value={row.revenue}
                          onChange={(e) => {
                            const next = form.lostRevenueRows.slice();
                            next[i] = { ...next[i], revenue: e.target.value };
                            setForm({ ...form, lostRevenueRows: next });
                          }}
                        />
                        {form.lostRevenueRows.length > 1 ? (
                          <button
                            type="button"
                            className="icon-btn danger"
                            title="Remove row"
                            onClick={() => {
                              const next = form.lostRevenueRows.filter((_, j) => j !== i);
                              setForm({
                                ...form,
                                lostRevenueRows: next.length ? next : [{ duration: '', revenue: '' }],
                              });
                            }}
                          >
                            <X size={14} />
                          </button>
                        ) : (
                          <span />
                        )}
                      </div>
                    );
                  })}
                </div>
                <div className="lost-rev-actions">
                  <button
                    type="button"
                    className="btn-secondary"
                    onClick={() => {
                      // Promote linear → table on first add: copy the existing rate to a sane
                      // duration row, then queue an empty second row for the user to fill.
                      const rows = form.lostRevenueRows;
                      const wasLinear = rows.length === 1
                        && String(rows[0].duration || '').trim() === '';
                      if (wasLinear) {
                        setForm({
                          ...form,
                          lostRevenueRows: [
                            { duration: '', revenue: rows[0].revenue || '' },
                            { duration: '', revenue: '' },
                          ],
                        });
                      } else {
                        setForm({
                          ...form,
                          lostRevenueRows: [...rows, { duration: '', revenue: '' }],
                        });
                      }
                    }}
                  >
                    <Plus size={14} /> {tr('settings.lostRev.addRow')}
                  </button>
                  <small className="muted">
                    {tr('settings.lostRev.hint')}
                  </small>
                </div>
              </fieldset>

              {canManageProject ? (
                <div className="settings-actions">
                  <button type="submit" className="btn-primary" disabled={saving}>
                    {saving ? <Loader size={16} className="spin" /> : <Save size={16} />}
                    <span>{saving ? tr('common.saving') : tr('settings.saveChanges')}</span>
                  </button>
                </div>
              ) : null}
            </form>

            <div className="budget-summary-card">
              <div className="budget-summary-header">
                <h3>{tr('settings.budgetSummary')}</h3>
                {budgetLoading ? <Loader size={14} className="spin" /> : null}
              </div>

              {budgetSummary ? (
                <>
                  <div className="budget-stats">
                    <div className="budget-stat">
                      <span className="budget-stat-label">{tr('settings.budgetPlanned')}</span>
                      <strong>
                        {(budgetSummary.planned?.amount || 0).toLocaleString()} {budgetSummary.planned?.currency || 'USD'}
                      </strong>
                      <span className="budget-stat-sub">{budgetSummary.planned?.type || 'hourly'}</span>
                    </div>
                    <div className="budget-stat">
                      <span className="budget-stat-label">{tr('settings.budgetActual')}</span>
                      <strong>
                        {(budgetSummary.actual?.cost || 0).toLocaleString()} {budgetSummary.planned?.currency || 'USD'}
                      </strong>
                      <span className="budget-stat-sub">
                        {tr('reports.billableSuffix', { hours: (budgetSummary.actual?.billableCost || 0).toLocaleString() })}
                      </span>
                    </div>
                    <div className="budget-stat">
                      <span className="budget-stat-label">{tr('settings.hoursLogged')}</span>
                      <strong>{(budgetSummary.actual?.hours || 0).toFixed(2)}h</strong>
                      <span className="budget-stat-sub">
                        {tr('reports.billableSuffix', { hours: (budgetSummary.actual?.billableHours || 0).toFixed(2) })}
                      </span>
                    </div>
                    <div className="budget-stat">
                      <span className="budget-stat-label">{tr('settings.budgetRemaining')}</span>
                      <strong className={budgetSummary.remaining !== null && budgetSummary.remaining < 0 ? 'budget-over' : ''}>
                        {budgetSummary.remaining === null
                          ? '—'
                          : `${budgetSummary.remaining.toLocaleString()} ${budgetSummary.planned?.currency || 'USD'}`}
                      </strong>
                      <span className="budget-stat-sub">
                        {budgetSummary.usedPercent === null ? tr('common.unset') : `${budgetSummary.usedPercent}% ${tr('settings.budgetUsedPct')}`}
                      </span>
                    </div>
                  </div>

                  {budgetSummary.usedPercent !== null ? (
                    <div className="budget-progress">
                      <div
                        className={`budget-progress-fill ${budgetSummary.usedPercent > 100 ? 'over' : ''}`}
                        style={{ width: `${Math.min(100, Math.max(0, budgetSummary.usedPercent))}%` }}
                      />
                    </div>
                  ) : null}

                  {budgetSummary.currencyWarning ? (
                    <div className="budget-warning">
                      Some contributors have a different billing currency. Costs assume the project currency.
                    </div>
                  ) : null}

                  {budgetSummary.byUser?.length ? (
                    <div className="budget-by-user">
                      <h4>Cost by user</h4>
                      <table className="budget-user-table">
                        <thead>
                          <tr>
                            <th>User</th>
                            <th>Hours</th>
                            <th>Rate</th>
                            <th>Cost</th>
                          </tr>
                        </thead>
                        <tbody>
                          {budgetSummary.byUser.map((row) => (
                            <tr key={row.user?.id}>
                              <td>
                                <strong>{row.user?.username || row.user?.email || '—'}</strong>
                              </td>
                              <td>
                                {row.hours.toFixed(2)}h
                                <span className="muted-inline"> ({row.billableHours.toFixed(2)} billable)</span>
                              </td>
                              <td>
                                {row.billingRate.toFixed(2)} {row.billingCurrency}/h
                              </td>
                              <td>
                                <strong>{row.cost.toLocaleString()} {budgetSummary.planned?.currency || 'USD'}</strong>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  ) : (
                    <div className="budget-empty">No time logged on this project yet.</div>
                  )}
                </>
              ) : (
                <div className="budget-empty">
                  {budgetLoading ? 'Loading…' : 'No data yet.'}
                </div>
              )}
            </div>

            <div className="members-section">
              <div className="members-header">
                <h3>{tr('settings.membersHeading', { n: roleStats.total })}</h3>
                <div className="members-stats">
                  <span className="role-stat role-owner">{tr('settings.roleStats.owner')}</span>
                  <span className="role-stat role-editor">{tr('settings.roleStats.editors', { n: roleStats.editors })}</span>
                  <span className="role-stat role-viewer">{tr('settings.roleStats.viewers', { n: roleStats.viewers })}</span>
                </div>
              </div>

              {canManageProject ? (() => {
                const opts = isOwner ? MEMBER_ROLE_OPTIONS : MEMBER_ROLE_OPTIONS.filter((o) => o.value !== 'moderator');
                return (
                  <form className="member-add-form" onSubmit={handleAddMember}>
                    <input
                      type="email"
                      placeholder="member@example.com"
                      value={memberEmail}
                      onChange={(e) => setMemberEmail(e.target.value)}
                    />
                    <select value={memberRole} onChange={(e) => setMemberRole(e.target.value)}>
                      {opts.map((o) => (<option key={o.value} value={o.value}>{tr('settings.memberRole.' + o.value)}</option>))}
                    </select>
                    <button type="submit" className="btn-primary" disabled={memberSaving}>
                      {memberSaving ? <Loader size={16} className="spin" /> : <UserPlus size={16} />}
                      <span>{tr('common.add')}</span>
                    </button>
                  </form>
                );
              })() : null}

              <div className="members-list">
                <div className="member-row owner-row">
                  <span className="member-avatar role-owner-avatar" aria-hidden>
                    {initialOf(project.owner?.username || project.owner?.email)}
                  </span>
                  <div className="member-info">
                    <strong>{project.owner?.username || '—'}</strong>
                    <span className="member-email">{project.owner?.email || ''}</span>
                  </div>
                  <span className="member-meta">{tr('settings.memberCreator')}</span>
                  <span className="project-role role-owner">owner</span>
                </div>

                {members.map((m) => {
                  const memberId = m.user?.id;
                  const isMe = memberId && user?.id === memberId;
                  const pending = pendingMemberId === memberId;
                  return (
                    <div className={`member-row ${pending ? 'is-pending' : ''}`} key={memberId}>
                      <span className={`member-avatar role-${m.role}-avatar`} aria-hidden>
                        {initialOf(m.user?.username || m.user?.email)}
                      </span>
                      <div className="member-info">
                        <strong>
                          {m.user?.username || '—'}
                          {isMe ? <span className="me-tag">{tr('settings.youTag')}</span> : null}
                        </strong>
                        <span className="member-email">{m.user?.email || ''}</span>
                      </div>
                      <span className="member-meta">{tr('settings.memberAdded', { date: formatMemberDate(m.addedAt) })}</span>
                      {(() => {
                        const subordinate = m.role === 'editor' || m.role === 'reviewer' || m.role === 'viewer';
                        const canManageThis = isOwner || (canManageProject && subordinate);
                        if (!canManageThis) {
                          return <span className={`project-role role-${m.role}`}>{m.role}</span>;
                        }
                        const opts = isOwner ? MEMBER_ROLE_OPTIONS : MEMBER_ROLE_OPTIONS.filter((o) => o.value !== 'moderator');
                        return (
                          <div className="member-actions">
                            <select
                              value={m.role}
                              onChange={(e) => handleChangeMemberRole(memberId, e.target.value)}
                              disabled={pending}
                            >
                              {opts.map((o) => (<option key={o.value} value={o.value}>{tr('settings.memberRole.' + o.value)}</option>))}
                            </select>
                            <button
                              className="icon-btn danger"
                              title={tr('settings.removeMember')}
                              onClick={() => handleRemoveMember(memberId)}
                              disabled={pending}
                            >
                              {pending ? <Loader size={14} className="spin" /> : <Trash2 size={16} />}
                            </button>
                          </div>
                        );
                      })()}
                    </div>
                  );
                })}

                {members.length === 0 ? (
                  <div className="member-empty">{tr('settings.noMembers')}</div>
                ) : null}
              </div>

              {!isOwner && myMembership && !project.isPersonal ? (
                <div className="leave-row">
                  <button
                    type="button"
                    className="btn-danger"
                    onClick={handleLeaveProject}
                    disabled={leaving}
                  >
                    {leaving ? <Loader size={16} className="spin" /> : <Trash2 size={16} />}
                    <span>{leaving ? tr('settings.leaveProcessing') : tr('settings.leaveProject')}</span>
                  </button>
                </div>
              ) : null}
            </div>

            {(() => {
              const hasLinear = project.lostRevenuePerUnit != null;
              const hasTable = project.lostRevenueByDuration
                && Object.keys(project.lostRevenueByDuration).length > 0;
              const ready = hasLinear || hasTable;
              return (
                <div className="advanced-tools">
                  <h3>{tr('advanced.title')}</h3>
                  <p>{tr('advanced.crashIntro')}</p>
                  <button
                    type="button"
                    className="btn-secondary"
                    onClick={() => navigate(`/projects/${id}/optimize`)}
                    disabled={!ready}
                    title={ready ? '' : tr('advanced.enableHint')}
                  >
                    {tr('advanced.showOptimization')}
                  </button>
                </div>
              );
            })()}

            {isOwner && !project.isPersonal ? (
              <div className="danger-zone">
                <h3>{tr('settings.dangerZone')}</h3>
                <p>{tr('settings.dangerZoneNote')}</p>
                <button className="btn-danger" onClick={handleDelete}>
                  <Trash2 size={16} />
                  <span>{tr('settings.deleteProject')}</span>
                </button>
              </div>
            ) : null}
          </div>
        )}
      </div>

      {showTaskModal ? (() => {
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
                        title="Edit"
                        onClick={() => setEditMode(true)}
                      >
                        <Save size={16} />
                        <span>Edit</span>
                      </button>
                    ) : null}
                    {editingTaskRef.access === 'owner' ? (
                      <button
                        type="button"
                        className="icon-btn danger"
                        title="Move to trash"
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
                <button className="btn-close" onClick={handleCloseTaskModal} title="Close">
                  <X size={24} />
                </button>
              </div>
            </div>

            <div className="form-group">
              <label>Title</label>
              <input
                type="text"
                className="custom-input title-input"
                placeholder="Title…"
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
                    Progress: {Math.max(0, Math.min(100, Number(taskForm.progress) || 0))}%
                    {(editingSubtaskStats?.total || 0) > 0 ? (
                      <span className="progress-locked-hint" title="Auto-computed from subtasks"> (auto)</span>
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
                  <label>Status</label>
                  <select
                    className="custom-select"
                    value={taskForm.cancelled ? 'cancelled' : 'active'}
                    onChange={(e) =>
                      setTaskForm({ ...taskForm, cancelled: e.target.value === 'cancelled' })
                    }
                  >
                    <option value="active">In progress</option>
                    <option value="cancelled">Cancelled</option>
                  </select>
                </div>
              </div>

              <div className="form-row">
                <div className="form-group half">
                  <label>Assignees</label>
                  <div className="assignee-picker">
                    {assigneeOptions.length === 0 ? (
                      <span className="muted">No project members.</span>
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
                            <span>{o.label}{o.role === 'owner' ? ' (owner)' : ''}</span>
                          </label>
                        );
                      })
                    )}
                  </div>
                </div>
                <div className="form-group half">
                  <label>Deadline</label>
                  <input
                    type="date"
                    className="custom-input"
                    value={taskForm.deadline}
                    onChange={(e) => setTaskForm({ ...taskForm, deadline: e.target.value })}
                  />
                </div>
              </div>

              <div className="form-group">
                <label>Content</label>
                <textarea
                  className="custom-input"
                  placeholder="Content…"
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
                    Cancel
                  </button>
                )}
                {taskReadOnly ? null : (
                  <button type="submit" className="btn-save" disabled={taskSaving}>
                    {taskSaving ? <Loader size={16} className="spin" /> : null}
                    <span>{taskSaving ? 'Saving…' : editingTaskId ? 'Save' : 'Create'}</span>
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
                          {b.title || '(untitled)'}
                          <button
                            type="button"
                            className="pending-chip-x"
                            onClick={() => setPendingBlockers((prev) => prev.filter((x) => x.id !== b.id))}
                            aria-label="Remove blocker"
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
                          return <div className="muted small">No match.</div>;
                        }
                        return matches.map((t) => (
                          <button
                            key={String(t._id || t.id)}
                            type="button"
                            className="picker-row"
                            onClick={() => {
                              setPendingBlockers((prev) => [
                                ...prev,
                                { id: String(t._id || t.id), title: t.title || t.content?.slice(0, 60) || '(untitled)' },
                              ]);
                              setBlockerQuery('');
                            }}
                          >
                            <span>{t.title || t.content?.slice(0, 60) || '(untitled)'}</span>
                            {t.status === 'done' ? <span className="muted small">done</span> : null}
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
                            <strong>{s.title || '(no title)'}</strong>
                            {s.content ? <span className="muted small"> — {s.content}</span> : null}
                          </div>
                          <button
                            type="button"
                            className="pending-chip-x"
                            onClick={() => setPendingSubtasks((prev) => prev.filter((_, j) => j !== i))}
                            aria-label="Remove subtask"
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
                <h4><MessageSquare size={14} /> Comments {commentList.length ? `(${commentList.length})` : ''}</h4>
                <div className="comment-list">
                  {commentsLoading && commentList.length === 0 ? (
                    <div className="muted">Loading…</div>
                  ) : commentList.length === 0 ? (
                    <div className="muted">No comments yet.</div>
                  ) : (
                    commentList.map((c, idx) => (
                      <div key={c._id || idx} className="comment-item">
                        <div className="comment-meta">
                          <span className="comment-author">{c.user?.username || c.user?.email || 'Unknown'}</span>
                          <span className="comment-date">
                            {c.createdAt ? new Date(c.createdAt).toLocaleString('vi-VN') : ''}
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
                      placeholder="Write a comment…"
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
                      Send
                    </button>
                  </div>
                ) : (
                  <div className="muted">Your role does not allow commenting.</div>
                )}
              </section>
            ) : null}
          </div>
        </div>
        );
      })() : null}

    </div>
  );
};

export default ProjectDetail;
