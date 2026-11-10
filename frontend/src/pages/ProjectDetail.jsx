import React, { useCallback, useEffect, useMemo, useState, lazy, Suspense } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { toast } from 'react-toastify';
import {
  ArrowLeft,
  LayoutGrid,
  List,
  Settings,
  Loader,
  Archive,
  FolderKanban,
  Plus,
  BarChart3,
  GanttChart,
  ScrollText,
} from 'lucide-react';
import {
  getProject,
  archiveProject,
  getProjectMembers,
} from '../services/projectService';
import { getNotes, updateNote } from '../services/noteService';
import KanbanBoard from '../components/KanbanBoard';
import TaskModal from '../components/project/TaskModal';
import ProjectSettingsTab from '../components/project/ProjectSettingsTab';
import TaskListTab from '../components/project/TaskListTab';
import TimelineTab from '../components/project/TimelineTab';
import ProjectLogTab from '../components/project/ProjectLogTab';
const ProjectDashboard = lazy(() => import('../components/ProjectDashboard'));
import { useTheme } from '../hooks/useTheme';
import { useI18n } from '../i18n';
import LanguageSwitcher from '../components/LanguageSwitcher';
import ThemeButton from '../components/ThemeButton';
import LogoutButton from '../components/LogoutButton';
import { useSchedule } from '../hooks/useSchedule';
import { useTaskEditor } from '../hooks/useTaskEditor';
import './ProjectDetail.css';

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

// Tabs carry an i18n key. Render-time lookup via t('tab.<key>').
const TABS_BASE = [
  { key: 'board', icon: LayoutGrid },
  { key: 'list', icon: List },
  { key: 'timeline', icon: GanttChart },
  { key: 'dashboard', icon: BarChart3 },
  { key: 'settings', icon: Settings },
];

const LOG_TAB = { key: 'log', icon: ScrollText };

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
  // Archived projects are read-only until restored.
  const isArchived = project?.status === 'archived';
  const canEdit = !isArchived && (project?.role === 'owner' || project?.role === 'moderator' || project?.role === 'editor');
  const canManageProject = project?.role === 'owner' || project?.role === 'moderator';
  const canViewLog = project?.role === 'owner' || project?.role === 'moderator';
  const canComment = !isArchived && (project?.role === 'owner' || project?.role === 'moderator' || project?.role === 'editor' || project?.role === 'reviewer');
  // Insert Log tab right before Settings (the last entry of TABS_BASE).
  const TABS = canViewLog
    ? [...TABS_BASE.slice(0, -1), LOG_TAB, TABS_BASE[TABS_BASE.length - 1]]
    : TABS_BASE;

  useEffect(() => {
    if (project && (tab === 'board' || tab === 'timeline')) fetchTasks();
  }, [project, tab, fetchTasks]);

  const taskEditor = useTaskEditor({ id, project, fetchTasks, canComment });
  const { handleOpenCreateTask, handleOpenEditTask, handleDeleteTask } = taskEditor;

  const handleArchive = async () => {
    try {
      await archiveProject(id);
      toast.success(project?.status === 'archived' ? tr('projects.restored') : tr('projects.archived'));
      fetchProject();
    } catch (err) {
      toast.error(err.message || tr('detail.archiveFailed'));
    }
  };

  const handleToggleTaskDone = async (task) => {
    const newStatus = task.status === 'done' ? 'not_done' : 'done';
    if (newStatus === 'done' && task.isBlocked) {
      const blockerCount = (task.dependencies || []).length;
      if (!window.confirm(tr('detail.blockersConfirm', { n: blockerCount }))) {
        return;
      }
    }
    if ((task.subtaskStats?.total || 0) > 0) {
      toast.info(tr('detail.parentStatusInfo'));
      return;
    }
    try {
      await updateNote(task._id || task.id, {
        status: newStatus,
        progress: newStatus === 'done' ? 100 : 0,
      });
      fetchTasks();
    } catch (err) {
      toast.error(err.message || tr('detail.updateFailed'));
    }
  };

  const handleTaskMove = async (task, patch) => {
    const tid = task._id || task.id;
    if (patch.status === 'done' && task.isBlocked) {
      const blockerCount = (task.dependencies || []).length;
      if (!window.confirm(tr('detail.blockersConfirm', { n: blockerCount }))) {
        return;
      }
    }
    const isParentTask = (task.subtaskStats?.total || 0) > 0;
    if (isParentTask && task.status !== 'cancelled' && (patch.status === 'done' || patch.status === 'not_done')) {
      toast.info(tr('detail.parentMoveInfo'));
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
      toast.error(err.message || tr('detail.moveFailed'));
    }
  };

  if (loading || !project) {
    return (
      <div className={`project-detail-container ${theme === 'dark' ? 'dark-theme' : ''}`}>
        <div className="projects-loading">
          <Loader className="spin" size={28} />
          <span>{tr('detail.loading')}</span>
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
              <span className="badge-archived" style={{ marginLeft: 8 }}>{tr('projects.badge.archived')}</span>
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
          <ThemeButton className="icon-btn" pref={themePref} onClick={cycleTheme} />
          {isOwner && !project.isPersonal ? (
            <button className="btn-secondary" onClick={handleArchive}>
              <Archive size={16} />
              <span>{project.status === 'archived' ? tr('common.restore') : tr('common.archive')}</span>
            </button>
          ) : null}
          <LogoutButton className="btn-secondary" size={16} />
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
          <TimelineTab
            id={id}
            project={project}
            tasks={tasks}
            tasksLoading={tasksLoading}
            schedule={schedule}
            scheduleError={scheduleError}
            constrainedMode={constrainedMode}
            setConstrainedMode={setConstrainedMode}
            ganttBarMode={ganttBarMode}
            setGanttBarMode={setGanttBarMode}
            ganttGranularity={ganttGranularity}
            setGanttGranularity={setGanttGranularity}
            handleOpenEditTask={handleOpenEditTask}
          />
        ) : tab === 'list' ? (
          <TaskListTab
            id={id}
            project={project}
            tasks={tasks}
            tasksLoading={tasksLoading}
            fetchTasks={fetchTasks}
            scheduleByTaskId={scheduleByTaskId}
            canEdit={canEdit}
            listSearch={listSearch}
            setListSearch={setListSearch}
            listTrashView={listTrashView}
            setListTrashView={setListTrashView}
            handleOpenCreateTask={handleOpenCreateTask}
            handleOpenEditTask={handleOpenEditTask}
            handleToggleTaskDone={handleToggleTaskDone}
            handleDeleteTask={handleDeleteTask}
          />
        ) : tab === 'log' ? (
          <ProjectLogTab id={id} canViewLog={canViewLog} />
        ) : (
          <ProjectSettingsTab
            id={id}
            project={project}
            user={user}
            form={form}
            setForm={setForm}
            members={members}
            fetchMembers={fetchMembers}
            fetchProject={fetchProject}
            isOwner={isOwner}
            canManageProject={canManageProject}
          />
        )}
      </div>

      <TaskModal
        editor={taskEditor}
        id={id}
        project={project}
        tasks={tasks}
        user={user}
        canEdit={canEdit}
        canComment={canComment}
        fetchTasks={fetchTasks}
      />

    </div>
  );
};

export default ProjectDetail;
