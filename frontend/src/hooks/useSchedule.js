import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { getProjectSchedule } from '../services/projectService';

/**
 * Hook to fetch and cache a project's CPM schedule.
 * Returns { schedule, byTaskId, loading, error, refresh }.
 *
 * schedule shape (from backend):
 *   { projectDuration, timeUnit, criticalPath: [id], tasks: [{ id, ES, LS, totalSlack, freeSlack, isCritical, ... }] }
 *
 * byTaskId is a Map<string, taskScheduleEntry> for quick lookup when decorating cards.
 */
export function useSchedule(projectId, { auto = true, constrained = false } = {}) {
  const [schedule, setSchedule] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  // Only the newest request may write state, so a slow unlimited response
  // can't overwrite a constrained one that was asked for later.
  const latestRequest = useRef(0);

  const refresh = useCallback(async () => {
    if (!projectId) return;
    const request = latestRequest.current + 1;
    latestRequest.current = request;
    setLoading(true);
    setError(null);
    try {
      const data = await getProjectSchedule(projectId, { constrained });
      if (latestRequest.current !== request) return;
      setSchedule(data);
    } catch (err) {
      if (latestRequest.current !== request) return;
      setError(err.message || 'Failed to load schedule');
      setSchedule(null);
    } finally {
      if (latestRequest.current === request) setLoading(false);
    }
  }, [projectId, constrained]);

  useEffect(() => {
    if (auto && projectId) refresh();
  }, [auto, projectId, refresh]);

  const byTaskId = useMemo(() => {
    const m = new Map();
    if (Array.isArray(schedule?.tasks)) {
      for (const t of schedule.tasks) {
        if (t?.id) m.set(String(t.id), t);
      }
    }
    return m;
  }, [schedule]);

  return { schedule, byTaskId, loading, error, refresh };
}

export default useSchedule;
