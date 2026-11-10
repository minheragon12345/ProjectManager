import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { toast } from 'react-toastify';
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  CartesianGrid,
  Legend,
} from 'recharts';
import { Clock, Loader, RefreshCcw } from 'lucide-react';
import { getBudgetSummary } from '../services/projectService';
import { listTimeEntries } from '../services/timeEntryService';
import { getNotes } from '../services/noteService';
import { useI18n } from '../i18n';
import './ProjectDashboard.css';

// Status -> i18n key. Resolved at render via t().
const STATUS_I18N = {
  not_done: 'board.col.toDo',
  in_progress: 'board.col.inProgress',
  done: 'board.col.done',
  cancelled: 'board.col.cancelled',
};

function deriveTaskBucket(t) {
  if (t.status === 'done') return 'done';
  if (t.status === 'cancelled') return 'cancelled';
  const p = Number(t.progress) || 0;
  if (p >= 100) return 'done';
  if (p > 0) return 'in_progress';
  return 'not_done';
}

function startOfWeek(date) {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  const day = d.getDay();
  const diff = (day + 6) % 7; // Monday-based
  d.setDate(d.getDate() - diff);
  return d;
}

function addDays(d, n) {
  const x = new Date(d);
  x.setDate(x.getDate() + n);
  return x;
}

function fmtWeek(d, locale) {
  const fmt = { day: '2-digit', month: 'short' };
  return d.toLocaleDateString(locale, fmt);
}

export default function ProjectDashboard({ projectId, currency = 'USD' }) {
  const { t, locale } = useI18n();
  const [budget, setBudget] = useState(null);
  const [entries, setEntries] = useState([]);
  const [tasks, setTasks] = useState([]);
  const [loading, setLoading] = useState(true);

  const fetchAll = useCallback(async () => {
    if (!projectId) return;
    setLoading(true);
    try {
      const [budgetData, entriesData, tasksData] = await Promise.all([
        getBudgetSummary(projectId).catch((e) => { console.warn(e); return null; }),
        listTimeEntries({ project: projectId, limit: 1000 }),
        getNotes('', 'all', { projectId }),
      ]);
      setBudget(budgetData);
      setEntries(Array.isArray(entriesData?.entries) ? entriesData.entries : []);
      setTasks(Array.isArray(tasksData?.notes) ? tasksData.notes : []);
    } catch (err) {
      toast.error(err.message || t('dash.loadFailed'));
    } finally {
      setLoading(false);
    }
  }, [projectId, t]);

  useEffect(() => { fetchAll(); }, [fetchAll]);

  const tasksByStatus = useMemo(() => {
    const counts = { not_done: 0, in_progress: 0, done: 0, cancelled: 0 };
    for (const t of tasks) {
      const b = deriveTaskBucket(t);
      counts[b] = (counts[b] || 0) + 1;
    }
    return counts;
  }, [tasks]);

  const estimatedHours = useMemo(
    () => tasks.reduce((s, t) => s + (Number(t.estimatedHours) || 0), 0),
    [tasks],
  );
  const actualHours = useMemo(
    () => tasks.reduce((s, t) => s + (Number(t.actualHours) || 0), 0),
    [tasks],
  );

  const burnData = useMemo(() => {
    if (!entries || entries.length === 0) return [];
    const buckets = new Map();
    for (const e of entries) {
      const ws = startOfWeek(e.date);
      const key = ws.toISOString().slice(0, 10);
      const cur = buckets.get(key) || { weekStart: ws, hours: 0, billableHours: 0 };
      cur.hours += Number(e.hours) || 0;
      cur.billableHours += e.billable ? (Number(e.hours) || 0) : 0;
      buckets.set(key, cur);
    }
    // Fill empty weeks between min and (today's week) for nicer chart.
    const sorted = Array.from(buckets.values()).sort((a, b) => a.weekStart - b.weekStart);
    if (sorted.length === 0) return [];
    const first = sorted[0].weekStart;
    const last = startOfWeek(new Date());
    const out = [];
    let cur = first;
    while (cur <= last) {
      const key = cur.toISOString().slice(0, 10);
      const hit = buckets.get(key);
      out.push({
        week: fmtWeek(cur, locale),
        hours: Math.round(((hit?.hours) || 0) * 100) / 100,
        billable: Math.round(((hit?.billableHours) || 0) * 100) / 100,
      });
      cur = addDays(cur, 7);
    }
    return out;
  }, [entries, locale]);

  const usedPercent = budget?.usedPercent ?? null;
  const planned = budget?.planned;
  const actualCost = budget?.actual?.cost ?? 0;
  const remaining = budget?.remaining;

  if (!projectId) return null;

  return (
    <div className="dashboard-panel">
      <div className="dashboard-toolbar">
        <h3>{t('dash.heading')}</h3>
        <button className="btn-secondary" onClick={fetchAll} disabled={loading} title={t('dash.refresh')}>
          {loading ? <Loader size={14} className="spin" /> : <RefreshCcw size={14} />}
          <span>{t('dash.refresh')}</span>
        </button>
      </div>

      {loading && entries.length === 0 ? (
        <div className="dashboard-loading">
          <Loader className="spin" size={24} /> <span>{t('dash.loading')}</span>
        </div>
      ) : (
        <>
          <div className="dashboard-cards">
            <div className="dashboard-card">
              <span className="dashboard-card-label">{t('dash.totalHoursLogged')}</span>
              <strong>{(budget?.actual?.hours ?? actualHours).toFixed(2)}h</strong>
              <span className="dashboard-card-sub">
                {t('dash.billableSuffix', { hours: (budget?.actual?.billableHours || 0).toFixed(2) })}
              </span>
            </div>

            <div className="dashboard-card">
              <span className="dashboard-card-label">{t('dash.budgetUsed')}</span>
              <strong className={usedPercent !== null && usedPercent > 100 ? 'over' : ''}>
                {usedPercent === null ? '—' : `${usedPercent}%`}
              </strong>
              <span className="dashboard-card-sub">
                {planned?.amount
                  ? t('dash.budgetOfPlanned', {
                      actual: actualCost.toLocaleString(),
                      planned: planned.amount.toLocaleString(),
                      currency: planned.currency || currency,
                    })
                  : t('dash.noBudget')}
              </span>
            </div>

            <div className="dashboard-card">
              <span className="dashboard-card-label">{t('dash.estimatedVsActual')}</span>
              <strong>
                {actualHours.toFixed(2)}h <span className="muted">/ {estimatedHours.toFixed(2)}h</span>
              </strong>
              <span className="dashboard-card-sub">
                {estimatedHours > 0
                  ? t('dash.pctOfEstimate', { n: Math.round((actualHours / estimatedHours) * 100) })
                  : t('dash.noEstimates')}
              </span>
            </div>

            <div className="dashboard-card">
              <span className="dashboard-card-label">{t('dash.remaining')}</span>
              <strong className={remaining !== null && remaining !== undefined && remaining < 0 ? 'over' : ''}>
                {remaining === null || remaining === undefined
                  ? '—'
                  : `${remaining.toLocaleString()} ${planned?.currency || currency}`}
              </strong>
              <span className="dashboard-card-sub">
                {t('dash.tasksCount', { n: tasks.length })}
              </span>
            </div>
          </div>

          <div className="dashboard-row">
            <div className="dashboard-section">
              <h4>{t('dash.tasksByStatus')}</h4>
              <div className="status-grid">
                {['not_done', 'in_progress', 'done', 'cancelled'].map((key) => {
                  const total = tasks.length || 1;
                  const count = tasksByStatus[key] || 0;
                  const pct = Math.round((count / total) * 100);
                  return (
                    <div className={`status-row col-${key}`} key={key}>
                      <span className="status-row-label">{t(STATUS_I18N[key])}</span>
                      <div className="status-row-bar">
                        <div className={`status-row-fill col-${key}`} style={{ width: `${pct}%` }} />
                      </div>
                      <span className="status-row-count">{count}</span>
                    </div>
                  );
                })}
              </div>
            </div>

            <div className="dashboard-section">
              <h4><Clock size={14} /> {t('dash.hoursPerWeek')}</h4>
              {burnData.length === 0 ? (
                <div className="dashboard-empty">{t('dash.noTimeLogged')}</div>
              ) : (
                <ResponsiveContainer width="100%" height={220}>
                  <BarChart data={burnData} margin={{ top: 8, right: 8, left: 0, bottom: 8 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="var(--border-primary)" />
                    <XAxis dataKey="week" stroke="var(--text-secondary)" fontSize={12} />
                    <YAxis stroke="var(--text-secondary)" fontSize={12} />
                    <Tooltip
                      contentStyle={{
                        backgroundColor: 'var(--surface-primary)',
                        border: '1px solid var(--border-primary)',
                        borderRadius: 8,
                        fontSize: 12,
                      }}
                      labelStyle={{ color: 'var(--text-primary)' }}
                    />
                    <Legend wrapperStyle={{ fontSize: 12 }} />
                    <Bar dataKey="hours" fill="var(--primary-accent)" name={t('dash.totalHours')} radius={[4, 4, 0, 0]} />
                    <Bar dataKey="billable" fill="#10b981" name={t('dash.billable')} radius={[4, 4, 0, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              )}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
