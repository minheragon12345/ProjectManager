import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { toast } from 'react-toastify';
import { Save, Loader, UserPlus, Trash2, Plus, X } from 'lucide-react';
import {
  updateProject,
  deleteProject,
  addProjectMember,
  updateProjectMemberRole,
  removeProjectMember,
  getBudgetSummary,
} from '../../services/projectService';
import { useI18n } from '../../i18n';
import { unitLabel } from '../../utils/timeUnit';

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

const MEMBER_ROLE_OPTIONS = [
  { value: 'moderator', label: 'Moderator (edit + view log)' },
  { value: 'editor', label: 'Editor (edit)' },
  { value: 'reviewer', label: 'Reviewer (comment only)' },
  { value: 'viewer', label: 'Viewer (read-only)' },
];

export default function ProjectSettingsTab({
  id,
  project,
  user,
  form,
  setForm,
  members,
  fetchMembers,
  fetchProject,
  isOwner,
  canManageProject,
}) {
  const navigate = useNavigate();
  const { t: tr, locale } = useI18n();
  const [saving, setSaving] = useState(false);
  const [memberEmail, setMemberEmail] = useState('');
  const [memberRole, setMemberRole] = useState('editor');
  const [memberSaving, setMemberSaving] = useState(false);
  const [pendingMemberId, setPendingMemberId] = useState(null);
  const [leaving, setLeaving] = useState(false);
  const [budgetSummary, setBudgetSummary] = useState(null);
  const [budgetLoading, setBudgetLoading] = useState(false);

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

  useEffect(() => {
    fetchMembers();
    fetchBudgetSummary();
  }, [fetchMembers, fetchBudgetSummary]);

  const roleStats = useMemo(() => {
    const getCount = (role) => members.filter((m) => m.role === role).length;
    const others = members.filter((m) => m.role !== 'owner').length;
    return {
      moderators: getCount('moderator'),
      editors: getCount('editor'),
      reviewers: getCount('reviewer'),
      viewers: getCount('viewer'),
      total: 1 + others,
    };
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
    return d.toLocaleDateString(locale);
  };

  const initialOf = (name) => (name ? String(name).trim()[0]?.toUpperCase() || '?' : '?');

  const handleSaveSettings = async (e) => {
    e.preventDefault();
    if (!form.name.trim()) {
      toast.error(tr('settings.nameRequired'));
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
      toast.success(tr('settings.saved'));
      fetchProject();
    } catch (err) {
      toast.error(err.message || tr('settings.saveFailed'));
    } finally {
      setSaving(false);
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
      toast.error(tr('settings.emailRequired'));
      return;
    }
    setMemberSaving(true);
    try {
      await addProjectMember(id, { email: memberEmail.trim(), role: memberRole });
      toast.success(tr('settings.memberAddedToast'));
      setMemberEmail('');
      fetchMembers();
    } catch (err) {
      toast.error(err.message || tr('settings.addMemberFailed'));
    } finally {
      setMemberSaving(false);
    }
  };

  const handleChangeMemberRole = async (memberUserId, role) => {
    setPendingMemberId(memberUserId);
    try {
      await updateProjectMemberRole(id, memberUserId, role);
      toast.success(tr('settings.roleUpdated'));
      fetchMembers();
    } catch (err) {
      toast.error(err.message || tr('settings.memberActionFailed'));
    } finally {
      setPendingMemberId(null);
    }
  };

  const handleRemoveMember = async (memberUserId) => {
    if (!window.confirm(tr('settings.removeMemberConfirm'))) return;
    setPendingMemberId(memberUserId);
    try {
      await removeProjectMember(id, memberUserId);
      toast.success(tr('settings.memberRemoved'));
      fetchMembers();
    } catch (err) {
      toast.error(err.message || tr('settings.memberActionFailed'));
    } finally {
      setPendingMemberId(null);
    }
  };

  const handleLeaveProject = async () => {
    const myId = user?.id;
    if (!myId) {
      toast.error(tr('settings.noCurrentUser'));
      return;
    }
    if (!window.confirm(tr('settings.leaveConfirm', { name: project?.name || '' }))) return;
    setLeaving(true);
    try {
      await removeProjectMember(id, myId);
      toast.success(tr('settings.leaveProject'));
      navigate('/projects');
    } catch (err) {
      toast.error(err.message || tr('settings.leaveFailed'));
    } finally {
      setLeaving(false);
    }
  };

  return (
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
                      placeholder={tr('settings.lostRev.durationPlaceholder')}
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
                    placeholder={tr('settings.lostRev.revenuePlaceholder')}
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
                      title={tr('settings.removeRow')}
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
                  {tr('reports.billableCostSuffix', { amount: (budgetSummary.actual?.billableCost || 0).toLocaleString(), currency: budgetSummary.planned?.currency || 'USD' })}
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
                {tr('settings.currencyWarning')}
              </div>
            ) : null}

            {budgetSummary.byUser?.length ? (
              <div className="budget-by-user">
                <h4>{tr('settings.costByUser')}</h4>
                <table className="budget-user-table">
                  <thead>
                    <tr>
                      <th>{tr('settings.col.user')}</th>
                      <th>{tr('settings.col.hours')}</th>
                      <th>{tr('settings.col.rate')}</th>
                      <th>{tr('settings.col.cost')}</th>
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
                          <span className="muted-inline"> {tr('settings.billableHours', { hours: row.billableHours.toFixed(2) })}</span>
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
              <div className="budget-empty">{tr('settings.noTimeLogged')}</div>
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
            {roleStats.moderators ? <span className="role-stat role-moderator">{tr('settings.roleStats.moderators', { n: roleStats.moderators })}</span> : null}
            <span className="role-stat role-editor">{tr('settings.roleStats.editors', { n: roleStats.editors })}</span>
            {roleStats.reviewers ? <span className="role-stat role-reviewer">{tr('settings.roleStats.reviewers', { n: roleStats.reviewers })}</span> : null}
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
  );
}
