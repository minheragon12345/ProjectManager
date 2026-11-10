import { useCallback, useEffect, useState } from 'react';
import { toast } from 'react-toastify';
import { Loader, ScrollText } from 'lucide-react';
import { getProjectAuditLog } from '../../services/projectService';
import { useI18n } from '../../i18n';

export default function ProjectLogTab({ id, canViewLog }) {
  const { t: tr, locale } = useI18n();
  const [logItems, setLogItems] = useState([]);
  const [logLoading, setLogLoading] = useState(false);

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

  useEffect(() => {
    if (canViewLog) fetchLog();
  }, [canViewLog, fetchLog]);

  return (
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
                {l.createdAt ? new Date(l.createdAt).toLocaleString(locale) : '—'}
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
  );
}
