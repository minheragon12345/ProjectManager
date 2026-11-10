import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { toast } from 'react-toastify';
import {
  ArrowLeft,
  Download,
  FileText,
  Loader,
  RefreshCcw,
} from 'lucide-react';
import { getProjects, getBudgetSummary } from '../services/projectService';
import { listTimeEntries } from '../services/timeEntryService';
import { useTheme } from '../hooks/useTheme';
import { useI18n } from '../i18n';
import LanguageSwitcher from '../components/LanguageSwitcher';
import ThemeButton from '../components/ThemeButton';
import LogoutButton from '../components/LogoutButton';
import { getLocalDateString } from '../utils/date';
import './Reports.css';

function startOfMonth(d = new Date()) {
  const x = new Date(d);
  x.setDate(1);
  x.setHours(0, 0, 0, 0);
  return x;
}

function downloadCsv(filename, rows) {
  if (!rows || rows.length === 0) {
    toast.info('Nothing to export'); // toast is outside React tree; keep static
    return;
  }
  const headers = Object.keys(rows[0]);
  const escape = (v) => {
    if (v === null || v === undefined) return '';
    const s = String(v);
    if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
    return s;
  };
  const lines = [
    headers.join(','),
    ...rows.map((r) => headers.map((h) => escape(r[h])).join(',')),
  ];
  const blob = new Blob(['\ufeff' + lines.join('\n')], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

const Reports = () => {
  const navigate = useNavigate();
  const { t } = useI18n();
  const { pref: themePref, resolved: theme, cycle: cycleTheme } = useTheme();

  const [projects, setProjects] = useState([]);
  const [projectId, setProjectId] = useState('');
  const [from, setFrom] = useState(() => getLocalDateString(startOfMonth()));
  const [to, setTo] = useState(() => getLocalDateString(new Date()));

  const [entries, setEntries] = useState([]);
  const [budget, setBudget] = useState(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    const token = localStorage.getItem('token');
    if (!token) {
      navigate('/login');
      return;
    }
    (async () => {
      try {
        const data = await getProjects({ scope: 'all', status: 'active' });
        const list = Array.isArray(data?.projects) ? data.projects : [];
        setProjects(list);
        if (list.length > 0 && !projectId) setProjectId(list[0].id);
      } catch (err) {
        toast.error(err.message || 'Could not load projects');
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [navigate]);

  const fetchData = useCallback(async () => {
    if (!projectId) return;
    setLoading(true);
    try {
      const params = { project: projectId, limit: 10000 };
      if (from) params.from = from;
      if (to) params.to = to + 'T23:59:59.999Z';
      // Billing rates come from the budget summary: the project payload has no rates,
      // and the summary also covers contributors who have left the project.
      const [entriesData, budgetData] = await Promise.all([
        listTimeEntries(params),
        getBudgetSummary(projectId),
      ]);
      setEntries(Array.isArray(entriesData?.entries) ? entriesData.entries : []);
      setBudget(budgetData || null);
    } catch (err) {
      toast.error(err.message || 'Could not load report data');
    } finally {
      setLoading(false);
    }
  }, [projectId, from, to]);

  useEffect(() => {
    if (projectId) fetchData();
  }, [fetchData, projectId]);

  const rateMap = useMemo(() => {
    const map = new Map();
    for (const row of budget?.byUser || []) {
      if (!row.user?.id) continue;
      map.set(row.user.id, {
        rate: Number(row.billingRate) || 0,
        currency: row.billingCurrency || 'USD',
      });
    }
    return map;
  }, [budget]);

  const projectCurrency = budget?.planned?.currency || 'USD';

  const hoursByUser = useMemo(() => {
    const map = new Map();
    for (const e of entries) {
      const uid = e.user?.id || 'unknown';
      const cur = map.get(uid) || {
        userId: uid,
        username: e.user?.username || '—',
        email: e.user?.email || '',
        hours: 0,
        billable: 0,
        entries: 0,
      };
      cur.hours += Number(e.hours) || 0;
      if (e.billable) cur.billable += Number(e.hours) || 0;
      cur.entries += 1;
      map.set(uid, cur);
    }
    return Array.from(map.values()).sort((a, b) => b.hours - a.hours);
  }, [entries]);

  const hoursByTask = useMemo(() => {
    const map = new Map();
    for (const e of entries) {
      const tid = e.task?.id || 'unknown';
      const cur = map.get(tid) || {
        taskId: tid,
        title: e.task?.title || e.task?.content?.slice(0, 60) || '—',
        hours: 0,
        billable: 0,
        entries: 0,
      };
      cur.hours += Number(e.hours) || 0;
      if (e.billable) cur.billable += Number(e.hours) || 0;
      cur.entries += 1;
      map.set(tid, cur);
    }
    return Array.from(map.values()).sort((a, b) => b.hours - a.hours);
  }, [entries]);

  const costByUser = useMemo(() => {
    return hoursByUser.map((u) => {
      const rateInfo = rateMap.get(u.userId);
      const rate = rateInfo?.rate || 0;
      const currency = rateInfo?.currency || 'USD';
      const cost = u.hours * rate;
      const billableCost = u.billable * rate;
      return { ...u, rate, currency, cost, billableCost };
    });
  }, [hoursByUser, rateMap]);

  const totals = useMemo(() => {
    const totalHours = hoursByUser.reduce((s, u) => s + u.hours, 0);
    const totalBillable = hoursByUser.reduce((s, u) => s + u.billable, 0);
    const totalCost = costByUser.reduce((s, u) => s + u.cost, 0);
    const billableCost = costByUser.reduce((s, u) => s + u.billableCost, 0);
    return {
      totalHours,
      totalBillable,
      totalCost,
      billableCost,
    };
  }, [hoursByUser, costByUser]);

  const handleExportHoursByUser = () => {
    downloadCsv(`hours-by-user_${projectId}_${from}_${to}.csv`,
      hoursByUser.map((u) => ({
        username: u.username,
        email: u.email,
        hours: u.hours.toFixed(2),
        billableHours: u.billable.toFixed(2),
        entries: u.entries,
      })));
  };

  const handleExportHoursByTask = () => {
    downloadCsv(`hours-by-task_${projectId}_${from}_${to}.csv`,
      hoursByTask.map((t) => ({
        taskId: t.taskId,
        title: t.title,
        hours: t.hours.toFixed(2),
        billableHours: t.billable.toFixed(2),
        entries: t.entries,
      })));
  };

  const handleExportCostByUser = () => {
    downloadCsv(`cost-by-user_${projectId}_${from}_${to}.csv`,
      costByUser.map((u) => ({
        username: u.username,
        email: u.email,
        hours: u.hours.toFixed(2),
        billableHours: u.billable.toFixed(2),
        rate: u.rate.toFixed(2),
        currency: u.currency,
        cost: u.cost.toFixed(2),
        billableCost: u.billableCost.toFixed(2),
      })));
  };

  return (
    <div className={`reports-container ${theme}-theme`}>
      <div className="reports-header">
        <div className="reports-title">
          <FileText size={22} />
          <div>
            <h2>{t('reports.heading')}</h2>
            <p>{t('reports.sub')}</p>
          </div>
        </div>

        <div className="reports-actions">
          <LanguageSwitcher />
          <ThemeButton pref={themePref} onClick={cycleTheme} />
          <button
            className="btn"
            onClick={() => (window.history.length > 1 ? navigate(-1) : navigate('/'))}
          >
            <ArrowLeft size={18} /> {t('common.back')}
          </button>
          <LogoutButton />
        </div>
      </div>

      <div className="reports-filters">
        <label>
          <span>{t('reports.filter.project')}</span>
          <select value={projectId} onChange={(e) => setProjectId(e.target.value)}>
            {projects.length === 0 ? <option value="">{t('reports.noProjectsOption')}</option> : null}
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}{p.isPersonal ? ` (${t('projects.badge.personal')})` : ''}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span>{t('reports.filter.from')}</span>
          <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
        </label>
        <label>
          <span>{t('reports.filter.to')}</span>
          <input type="date" value={to} onChange={(e) => setTo(e.target.value)} />
        </label>
        <button className="btn" onClick={fetchData} disabled={loading || !projectId}>
          {loading ? <Loader size={14} className="spin" /> : <RefreshCcw size={14} />}
          <span>{loading ? t('common.loading') : t('common.refresh')}</span>
        </button>
      </div>

      {projects.length === 0 ? (
        <div className="reports-empty-state">
          <FileText size={40} />
          <p>{t('reports.empty')}</p>
        </div>
      ) : null}

      <div className="reports-totals">
        <div className="reports-total-card">
          <span className="reports-total-label">{t('reports.totalHours')}</span>
          <strong>{totals.totalHours.toFixed(2)}h</strong>
          <span className="reports-total-sub">{t('reports.billableSuffix', { hours: totals.totalBillable.toFixed(2) })}</span>
        </div>
        <div className="reports-total-card">
          <span className="reports-total-label">{t('reports.totalCost')}</span>
          <strong>
            {totals.totalCost.toLocaleString(undefined, { maximumFractionDigits: 2 })} {projectCurrency}
          </strong>
          <span className="reports-total-sub">
            {t('reports.billableCostSuffix', {
              amount: totals.billableCost.toLocaleString(undefined, { maximumFractionDigits: 2 }),
              currency: projectCurrency,
            })}
          </span>
        </div>
        <div className="reports-total-card">
          <span className="reports-total-label">{t('reports.entries')}</span>
          <strong>{entries.length}</strong>
          <span className="reports-total-sub">
            {t('reports.userTask', { users: hoursByUser.length, tasks: hoursByTask.length })}
          </span>
        </div>
      </div>

      <div className="reports-section">
        <div className="reports-section-header">
          <h3>{t('reports.section.hoursByUser')}</h3>
          <button className="btn" onClick={handleExportHoursByUser} disabled={hoursByUser.length === 0}>
            <Download size={14} /> {t('common.export')}
          </button>
        </div>
        <div className="reports-table-wrap">
          <table className="reports-table">
            <thead>
              <tr>
                <th>{t('reports.col.user')}</th>
                <th>{t('reports.col.hours')}</th>
                <th>{t('reports.col.billable')}</th>
                <th>{t('reports.col.entries')}</th>
              </tr>
            </thead>
            <tbody>
              {hoursByUser.length === 0 ? (
                <tr><td colSpan={4} className="reports-empty">{t('common.noData')}</td></tr>
              ) : (
                hoursByUser.map((u) => (
                  <tr key={u.userId}>
                    <td>
                      <strong>{u.username}</strong>
                      <div className="muted-inline">{u.email}</div>
                    </td>
                    <td>{u.hours.toFixed(2)}h</td>
                    <td>{u.billable.toFixed(2)}h</td>
                    <td>{u.entries}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      <div className="reports-section">
        <div className="reports-section-header">
          <h3>{t('reports.section.hoursByTask')}</h3>
          <button className="btn" onClick={handleExportHoursByTask} disabled={hoursByTask.length === 0}>
            <Download size={14} /> {t('common.export')}
          </button>
        </div>
        <div className="reports-table-wrap">
          <table className="reports-table">
            <thead>
              <tr>
                <th>{t('reports.col.task')}</th>
                <th>{t('reports.col.hours')}</th>
                <th>{t('reports.col.billable')}</th>
                <th>{t('reports.col.entries')}</th>
              </tr>
            </thead>
            <tbody>
              {hoursByTask.length === 0 ? (
                <tr><td colSpan={4} className="reports-empty">{t('common.noData')}</td></tr>
              ) : (
                hoursByTask.map((tk) => (
                  <tr key={tk.taskId}>
                    <td className="reports-task-cell">
                      <strong>{tk.title || t('common.noTitle')}</strong>
                      <div className="muted-inline">{tk.taskId}</div>
                    </td>
                    <td>{tk.hours.toFixed(2)}h</td>
                    <td>{tk.billable.toFixed(2)}h</td>
                    <td>{tk.entries}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      <div className="reports-section">
        <div className="reports-section-header">
          <h3>{t('reports.section.costByUser')}</h3>
          <button className="btn" onClick={handleExportCostByUser} disabled={costByUser.length === 0}>
            <Download size={14} /> {t('common.export')}
          </button>
        </div>
        <div className="reports-table-wrap">
          <table className="reports-table">
            <thead>
              <tr>
                <th>{t('reports.col.user')}</th>
                <th>{t('reports.col.hours')}</th>
                <th>{t('reports.col.rate')}</th>
                <th>{t('reports.col.cost')}</th>
                <th>{t('reports.col.billableCost')}</th>
              </tr>
            </thead>
            <tbody>
              {costByUser.length === 0 ? (
                <tr><td colSpan={5} className="reports-empty">{t('common.noData')}</td></tr>
              ) : (
                costByUser.map((u) => (
                  <tr key={u.userId}>
                    <td>
                      <strong>{u.username}</strong>
                      <div className="muted-inline">{u.email}</div>
                    </td>
                    <td>{u.hours.toFixed(2)}h</td>
                    <td>{u.rate.toFixed(2)} {u.currency}/h</td>
                    <td>
                      <strong>
                        {u.cost.toLocaleString(undefined, { maximumFractionDigits: 2 })} {projectCurrency}
                      </strong>
                    </td>
                    <td>
                      {u.billableCost.toLocaleString(undefined, { maximumFractionDigits: 2 })} {projectCurrency}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
};

export default Reports;
