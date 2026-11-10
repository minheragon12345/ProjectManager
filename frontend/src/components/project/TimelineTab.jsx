import { lazy, Suspense } from 'react';
import { Loader } from 'lucide-react';
import ErrorBoundary from '../ErrorBoundary';
import CrashingAnalysis from '../CrashingAnalysis';
import { useI18n } from '../../i18n';
import { unitLabel } from '../../utils/timeUnit';

const ProjectGantt = lazy(() => import('../ProjectGantt'));
const ResourceCurve = lazy(() => import('../ResourceCurve'));

export default function TimelineTab({
  id,
  project,
  tasks,
  tasksLoading,
  schedule,
  scheduleError,
  constrainedMode,
  setConstrainedMode,
  ganttBarMode,
  setGanttBarMode,
  ganttGranularity,
  setGanttGranularity,
  handleOpenEditTask,
}) {
  const { t: tr } = useI18n();
  return (
    <div className="timeline-panel">
      <div className="gantt-toolbar">
        <div className="toggle-group" role="group" aria-label={tr('gantt.barPosition')}>
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
        <div className="toggle-group" role="group" aria-label={tr('gantt.granularity')}>
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
          aria-label={tr('gantt.resourceMode')}
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
                {tr('gantt.critical')} <strong>{tr('gantt.criticalTasks', { n: (schedule.tasks || []).filter((task) => task.isCritical).length })}</strong>
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
              projectStart={project?.startDate || null}
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
              constrained={constrainedMode}
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
  );
}
