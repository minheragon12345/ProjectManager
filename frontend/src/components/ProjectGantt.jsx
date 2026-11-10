import { useEffect, useMemo, useRef } from 'react';
import Gantt from 'frappe-gantt';
// frappe-gantt's package.json exports only `.` — the dist CSS isn't a separately
// exported subpath, so we ship a vendored copy alongside this component.
import './frappe-gantt.css';
import './ProjectGantt.css';

const MS_PER_DAY = 24 * 60 * 60 * 1000;

const UNIT_TO_MS = {
  hour: 60 * 60 * 1000,
  day: MS_PER_DAY,
  week: 7 * MS_PER_DAY,
  month: 30 * MS_PER_DAY, // approximation, fine for visual layout
};

function unitMs(unit) {
  return UNIT_TO_MS[unit] || MS_PER_DAY;
}

function addUnits(date, n, unit) {
  return new Date(date.getTime() + n * unitMs(unit));
}

function formatYMD(date) {
  // YYYY-MM-DD in local time
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/**
 * Wraps frappe-gantt around the schedule produced by useSchedule.
 *
 * Props:
 *   schedule: { projectDuration, timeUnit, tasks: [{ ES, LS, duration, isCritical }] } (from /schedule endpoint)
 *   projectStart: Date | string (origin for ES=0); defaults to today
 *   viewMode: 'Earliest' | 'Latest' — which start to anchor bars on
 *   ganttViewMode: frappe-gantt view_mode string (Day/Week/Month/Year/Quarter Day/Half Day)
 *   onTaskClick: (taskId) => void
 */
export default function ProjectGantt({
  schedule,
  projectStart,
  viewMode = 'Earliest',
  ganttViewMode = 'Day',
  onTaskClick,
}) {
  const containerRef = useRef(null);
  const ganttRef = useRef(null);
  // Parents pass a new click handler on every render; keeping it in a ref stops
  // that from destroying and rebuilding the whole chart each time.
  const clickRef = useRef(onTaskClick);
  useEffect(() => {
    clickRef.current = onTaskClick;
  }, [onTaskClick]);

  const origin = useMemo(() => {
    if (!projectStart) return new Date(new Date().setHours(0, 0, 0, 0));
    const d = new Date(projectStart);
    if (Number.isNaN(d.getTime())) return new Date(new Date().setHours(0, 0, 0, 0));
    d.setHours(0, 0, 0, 0);
    return d;
  }, [projectStart]);

  const ganttTasks = useMemo(() => {
    if (!schedule || !Array.isArray(schedule.tasks) || schedule.tasks.length === 0) {
      return [];
    }
    const unit = schedule.timeUnit || 'day';
    const useLatest = viewMode === 'Latest';

    return schedule.tasks.map((t) => {
      const startOffset = useLatest ? t.LS : t.ES;
      const dur = Number(t.duration) || 0;
      const endOffset = startOffset + dur;
      const startDate = addUnits(origin, startOffset, unit);
      // frappe-gantt treats `end` as the inclusive last day of the bar, so point it
      // at the last moment the task runs. Subtracting a whole day instead put
      // hour-unit tasks shorter than 24h before their own start.
      const endDate = new Date(Math.max(startDate.getTime(), addUnits(origin, endOffset, unit).getTime() - 1));

      return {
        id: String(t.id),
        name: t.title || '(untitled)',
        start: formatYMD(startDate),
        end: formatYMD(endDate),
        progress: 0,
        dependencies: (t.dependencies || []).map(String).join(','),
        custom_class: t.isCritical ? 'gantt-critical' : '',
      };
    });
  }, [schedule, origin, viewMode]);

  useEffect(() => {
    if (!containerRef.current) return;
    // Wipe any prior render — frappe-gantt mutates the container's innerHTML.
    containerRef.current.innerHTML = '';

    if (ganttTasks.length === 0) {
      ganttRef.current = null;
      return;
    }

    try {
      ganttRef.current = new Gantt(containerRef.current, ganttTasks, {
        view_mode: ganttViewMode,
        bar_height: 22,
        padding: 28,        // row spacing — wider rows = cleaner arrow routing
        arrow_curve: 10,    // smoother bends than default 5
        on_click: (task) => clickRef.current?.(task.id),
      });

      // frappe-gantt's `.gantt-container` is sized via inline
      // `height: var(--gv-grid-height)` which only covers the grid rows, not
      // header + horizontal scrollbar — vertical scroll appears. Read the
      // SVG's intrinsic height (set via SVG `height` attr by the lib) and
      // resize the container to match. ResizeObserver keeps it in sync on
      // view-mode changes that re-render the SVG.
      const root = containerRef.current;
      const syncHeight = () => {
        const gc = root.querySelector('.gantt-container');
        const svg = root.querySelector('svg.gantt');
        if (!gc || !svg) return;
        const attrH = parseFloat(svg.getAttribute('height'));
        const rectH = svg.getBoundingClientRect().height;
        const h = Math.max(Number.isFinite(attrH) ? attrH : 0, rectH);
        if (h > 0) gc.style.height = `${Math.ceil(h) + 32}px`;
      };
      requestAnimationFrame(syncHeight);

      const svgEl = root.querySelector('svg.gantt');
      if (svgEl && typeof ResizeObserver !== 'undefined') {
        const ro = new ResizeObserver(syncHeight);
        ro.observe(svgEl);
        ganttRef.current.__ro = ro;
      }
    } catch (err) {
      console.error('frappe-gantt init failed:', err);
      ganttRef.current = null;
    }

    return () => {
      if (ganttRef.current?.__ro) ganttRef.current.__ro.disconnect();
      if (containerRef.current) containerRef.current.innerHTML = '';
      ganttRef.current = null;
    };
  }, [ganttTasks, ganttViewMode]);

  return <div ref={containerRef} className="project-gantt-container" />;
}
