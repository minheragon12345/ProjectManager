import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { toast } from 'react-toastify';
import { Clock, Loader, Plus, Trash2 } from 'lucide-react';
import {
  createTimeEntry,
  deleteTimeEntry,
  listTimeEntries,
} from '../services/timeEntryService';
import { getLocalDateString } from '../utils/date';
import { useI18n } from '../i18n';
import './TimeLogSection.css';

function formatDate(value, locale) {
  if (!value) return '—';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleDateString(locale, { timeZone: 'UTC' });
}

function getInitialForm() {
  return {
    hours: '0.5',
    date: getLocalDateString(),
    description: '',
    billable: true,
  };
}

export default function TimeLogSection({ taskId, canWrite, currentUserId, onChange }) {
  const { t, locale } = useI18n();
  const [entries, setEntries] = useState([]);
  const [loading, setLoading] = useState(false);
  const [form, setForm] = useState(getInitialForm);
  const [saving, setSaving] = useState(false);
  const [pendingId, setPendingId] = useState(null);

  const totalHours = useMemo(
    () => entries.reduce((sum, e) => sum + (Number(e.hours) || 0), 0),
    [entries],
  );

  const fetchEntries = useCallback(async () => {
    if (!taskId) return;
    setLoading(true);
    try {
      const data = await listTimeEntries({ task: taskId, limit: 50 });
      setEntries(Array.isArray(data?.entries) ? data.entries : []);
    } catch (err) {
      toast.error(err.message || t('timelog.loadFailed'));
    } finally {
      setLoading(false);
    }
  }, [taskId, t]);

  useEffect(() => {
    fetchEntries();
  }, [fetchEntries]);

  const handleSubmit = async (e) => {
    e?.preventDefault?.();
    e?.stopPropagation?.();
    if (!taskId) return;
    const hours = Number(form.hours);
    if (!Number.isFinite(hours) || hours <= 0) {
      toast.error(t('timelog.hoursInvalid'));
      return;
    }
    setSaving(true);
    try {
      await createTimeEntry({
        task: taskId,
        hours,
        date: form.date || getLocalDateString(),
        description: form.description.trim(),
        billable: !!form.billable,
      });
      toast.success(t('timelog.logged'));
      setForm({ ...getInitialForm(), billable: form.billable });
      await fetchEntries();
      onChange?.();
    } catch (err) {
      toast.error(err.message || t('timelog.logFailed'));
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (entry) => {
    const id = entry.id;
    if (!id) return;
    if (!window.confirm(t('timelog.deleteConfirm', { hours: entry.hours }))) return;
    setPendingId(id);
    try {
      await deleteTimeEntry(id);
      toast.success(t('timelog.deleted'));
      await fetchEntries();
      onChange?.();
    } catch (err) {
      toast.error(err.message || t('timelog.deleteFailed'));
    } finally {
      setPendingId(null);
    }
  };

  if (!taskId) return null;

  return (
    <div className="time-log-section">
      <div className="time-log-header">
        <h4>
          <Clock size={16} /> {t('timelog.title')}
          <span className="time-log-total">{t('timelog.total', { hours: totalHours.toFixed(2) })}</span>
        </h4>
      </div>

      {canWrite ? (
        <div className="time-log-form">
          <input
            type="number"
            min="0.25"
            max="24"
            step="0.25"
            value={form.hours}
            onChange={(e) => setForm({ ...form, hours: e.target.value })}
            placeholder={t('timelog.hoursPlaceholder')}
            className="time-log-hours"
            required
          />
          <input
            type="date"
            value={form.date}
            onChange={(e) => setForm({ ...form, date: e.target.value })}
            className="time-log-date"
          />
          <input
            type="text"
            value={form.description}
            onChange={(e) => setForm({ ...form, description: e.target.value })}
            placeholder={t('timelog.descPlaceholder')}
            className="time-log-desc"
            maxLength={1000}
          />
          <label className="time-log-billable" title={t('timelog.billable')}>
            <input
              type="checkbox"
              checked={!!form.billable}
              onChange={(e) => setForm({ ...form, billable: e.target.checked })}
            />
            <span>{t('timelog.billable')}</span>
          </label>
          <button
            type="button"
            className="btn-save time-log-submit"
            disabled={saving}
            onClick={handleSubmit}
          >
            {saving ? <Loader size={14} className="spin" /> : <Plus size={14} />}
            <span>{saving ? t('timelog.submitting') : t('timelog.submit')}</span>
          </button>
        </div>
      ) : null}

      <div className="time-log-list">
        {loading ? (
          <div className="time-log-empty"><Loader size={16} className="spin" /> {t('common.loading')}</div>
        ) : entries.length === 0 ? (
          <div className="time-log-empty">{t('timelog.empty')}</div>
        ) : (
          entries.map((e) => {
            const ownEntry = currentUserId && e.user?.id === currentUserId;
            const pending = pendingId === e.id;
            return (
              <div className={`time-log-entry ${pending ? 'is-pending' : ''}`} key={e.id}>
                <div className="time-log-entry-main">
                  <span className="time-log-entry-hours">{Number(e.hours).toFixed(2)}h</span>
                  <span className="time-log-entry-date">{formatDate(e.date, locale)}</span>
                  {e.billable ? (
                    <span className="time-log-chip billable">{t('timelog.billable')}</span>
                  ) : (
                    <span className="time-log-chip">{t('timelog.nonBillable')}</span>
                  )}
                  {e.description ? (
                    <span className="time-log-entry-desc" title={e.description}>{e.description}</span>
                  ) : null}
                  <span className="time-log-entry-user" title={e.user?.email || ''}>
                    {e.user?.username ? `@${e.user.username}` : ''}
                  </span>
                </div>
                {ownEntry ? (
                  <button
                    type="button"
                    className="icon-btn danger time-log-delete"
                    onClick={() => handleDelete(e)}
                    disabled={pending}
                    title={t('timelog.delete')}
                  >
                    {pending ? <Loader size={14} className="spin" /> : <Trash2 size={14} />}
                  </button>
                ) : null}
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
