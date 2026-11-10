import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { toast } from 'react-toastify';
import {
  Plus,
  Search,
  Loader,
  Clock,
  FileText,
  Archive,
  Trash2,
  FolderKanban,
  Users,
  X,
  BadgeDollarSign,
} from 'lucide-react';
import {
  getProjects,
  createProject,
  archiveProject,
  deleteProject,
} from '../services/projectService';
import { useTheme } from '../hooks/useTheme';
import { useI18n } from '../i18n';
import LanguageSwitcher from '../components/LanguageSwitcher';
import ThemeButton from '../components/ThemeButton';
import LogoutButton from '../components/LogoutButton';
import './Projects.css';

const SCOPE_OPTIONS = [
  { value: 'all', i18n: 'projects.scope.all' },
  { value: 'mine', i18n: 'projects.scope.mine' },
  { value: 'shared', i18n: 'projects.scope.shared' },
];

const STATUS_OPTIONS = [
  { value: 'active', i18n: 'projects.status.active' },
  { value: 'archived', i18n: 'projects.status.archived' },
];

const BUDGET_TYPES = [
  { value: 'hourly', i18n: 'settings.budgetType.hourly' },
  { value: 'fixed', i18n: 'settings.budgetType.fixed' },
];

const INITIAL_FORM = {
  name: '',
  description: '',
  startDate: '',
  endDate: '',
  budgetAmount: 0,
  budgetCurrency: 'USD',
  budgetType: 'hourly',
};

const Projects = () => {
  const navigate = useNavigate();
  const { t } = useI18n();

  const [projects, setProjects] = useState([]);
  const [loading, setLoading] = useState(true);
  const { pref: themePref, resolved: theme, cycle: cycleTheme } = useTheme();

  const [search, setSearch] = useState('');
  const [query, setQuery] = useState('');
  const [scope, setScope] = useState('all');
  const [statusFilter, setStatusFilter] = useState('active');

  const [showModal, setShowModal] = useState(false);
  const [form, setForm] = useState(INITIAL_FORM);
  const [saving, setSaving] = useState(false);

  const user = useMemo(() => {
    try {
      const s = localStorage.getItem('user');
      return s ? JSON.parse(s) : null;
    } catch {
      return null;
    }
  }, []);

  const fetchProjects = useCallback(async () => {
    setLoading(true);
    try {
      const data = await getProjects({ search: query, scope, status: statusFilter });
      setProjects(Array.isArray(data?.projects) ? data.projects : []);
    } catch (err) {
      toast.error(err.message || t('projects.loadFailed'));
    } finally {
      setLoading(false);
    }
  }, [query, scope, statusFilter]);

  // Search once typing pauses instead of on every keystroke.
  useEffect(() => {
    const timer = setTimeout(() => setQuery(search.trim()), 300);
    return () => clearTimeout(timer);
  }, [search]);

  useEffect(() => {
    const token = localStorage.getItem('token');
    if (!token) {
      navigate('/login');
      return;
    }
    fetchProjects();
  }, [fetchProjects, navigate]);

  const handleOpenCreate = () => {
    setForm(INITIAL_FORM);
    setShowModal(true);
  };

  const handleCloseModal = () => {
    if (saving) return;
    setShowModal(false);
  };

  const handleCreate = async (e) => {
    e.preventDefault();
    if (!form.name.trim()) {
      toast.error(t('projects.nameRequired'));
      return;
    }
    setSaving(true);
    try {
      await createProject({
        name: form.name.trim(),
        description: form.description.trim(),
        startDate: form.startDate || null,
        endDate: form.endDate || null,
        budget: {
          amount: Number(form.budgetAmount) || 0,
          currency: form.budgetCurrency || 'USD',
          type: form.budgetType || 'hourly',
        },
      });
      toast.success(t('projects.created'));
      setShowModal(false);
      fetchProjects();
    } catch (err) {
      toast.error(err.message || t('projects.createFailed'));
    } finally {
      setSaving(false);
    }
  };

  const handleArchive = async (project) => {
    try {
      await archiveProject(project.id);
      toast.success(project.status === 'archived' ? t('projects.restored') : t('projects.archived'));
      fetchProjects();
    } catch (err) {
      toast.error(err.message || t('projects.archiveFailed'));
    }
  };

  const handleDelete = async (project) => {
    if (!window.confirm(t('projects.deleteConfirm', { name: project.name }))) return;
    try {
      await deleteProject(project.id);
      toast.success(t('projects.deleted'));
      fetchProjects();
    } catch (err) {
      toast.error(err.message || t('projects.deleteFailed'));
    }
  };

  return (
    <div className={`projects-container ${theme === 'dark' ? 'dark-theme' : ''}`}>
      <div className="projects-action-bar">
        <div className="header-top-row">
          <h2>
            <FolderKanban size={22} style={{ verticalAlign: 'middle', marginRight: 8 }} />
            {t('projects.heading')}
          </h2>
          <div className="user-greeting" style={{ display: 'inline-flex', alignItems: 'center', gap: 12 }}>
            <LanguageSwitcher />
            <span>{t('nav.greeting', { name: user?.username || t('nav.guest') })}</span>
          </div>
        </div>

        <div className="header-bottom-row">
          <div className="search-box">
            <Search size={18} />
            <input
              type="text"
              placeholder={t('projects.searchPlaceholder')}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && setQuery(search.trim())}
            />
          </div>

          <button
            className="btn-admin nav-btn"
            onClick={() => navigate('/my-time')}
            title={t('projects.myTime')}
          >
            <Clock size={20} /> {t('projects.myTime')}
          </button>

          <button
            className="btn-admin nav-btn"
            onClick={() => navigate('/reports')}
            title={t('projects.reports')}
          >
            <FileText size={20} /> {t('projects.reports')}
          </button>

          {user?.role === 'admin' ? (
            <button
              className="btn-admin nav-btn"
              onClick={() => navigate('/admin/billing')}
              title={t('projects.billing')}
            >
              <BadgeDollarSign size={20} /> {t('projects.billing')}
            </button>
          ) : null}

          <div className="filter-group">
            <select value={scope} onChange={(e) => setScope(e.target.value)}>
              {SCOPE_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {t(o.i18n)}
                </option>
              ))}
            </select>

            <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}>
              {STATUS_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {t(o.i18n)}
                </option>
              ))}
            </select>
          </div>

          <div className="action-buttons">
            <ThemeButton className="btn-secondary" pref={themePref} onClick={cycleTheme} />
            <button className="btn-primary" onClick={handleOpenCreate}>
              <Plus size={18} />
              <span>{t('projects.newProject')}</span>
            </button>
            <LogoutButton className="btn-secondary" />
          </div>
        </div>
      </div>

      {loading ? (
        <div className="projects-loading">
          <Loader className="spin" size={28} />
          <span>{t('projects.loading')}</span>
        </div>
      ) : projects.length === 0 ? (
        <div className="projects-empty">
          <FolderKanban size={40} />
          <p>{t('projects.empty')}</p>
        </div>
      ) : (
        <div className="projects-grid">
          {projects.map((p) => (
            <div
              key={p.id}
              className={`project-card ${p.status === 'archived' ? 'archived' : ''}`}
              onClick={() => navigate(`/projects/${p.id}`)}
              role="button"
              tabIndex={0}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  navigate(`/projects/${p.id}`);
                }
              }}
            >
              <div className="project-card-header">
                <h3 className="project-name" title={p.name}>
                  {p.name}
                </h3>
                <span className={`project-role role-${p.role}`}>{p.role}</span>
              </div>

              {p.description ? <p className="project-description">{p.description}</p> : null}

              <div className="project-meta">
                <span title="Members">
                  <Users size={14} /> {p.memberCount}
                </span>
                {p.budget?.amount > 0 ? (
                  <span title="Budget">
                    {p.budget.currency} {Number(p.budget.amount).toLocaleString()}
                  </span>
                ) : null}
                {p.isPersonal ? <span className="badge-personal">{t('projects.badge.personal')}</span> : null}
                {p.status === 'archived' ? <span className="badge-archived">{t('projects.badge.archived')}</span> : null}
              </div>

              {p.role === 'owner' && !p.isPersonal ? (
                <div className="project-card-actions" onClick={(e) => e.stopPropagation()}>
                  <button
                    className="icon-btn"
                    title={p.status === 'archived' ? t('common.restore') : t('common.archive')}
                    onClick={() => handleArchive(p)}
                  >
                    <Archive size={16} />
                  </button>
                  <button
                    className="icon-btn danger"
                    title={t('common.delete')}
                    onClick={() => handleDelete(p)}
                  >
                    <Trash2 size={16} />
                  </button>
                </div>
              ) : null}
            </div>
          ))}
        </div>
      )}

      {showModal ? (
        <div className="modal-backdrop" onClick={handleCloseModal}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h3>{t('projects.modal.title')}</h3>
              <button className="icon-btn" onClick={handleCloseModal} title={t('common.close')}>
                <X size={18} />
              </button>
            </div>
            <form onSubmit={handleCreate} className="modal-form">
              <label>
                <span>{t('projects.modal.name')}</span>
                <input
                  type="text"
                  value={form.name}
                  onChange={(e) => setForm({ ...form, name: e.target.value })}
                  placeholder={t('projects.modal.namePlaceholder')}
                  maxLength={120}
                  autoFocus
                />
              </label>

              <label>
                <span>{t('projects.modal.description')}</span>
                <textarea
                  value={form.description}
                  onChange={(e) => setForm({ ...form, description: e.target.value })}
                  placeholder={t('projects.modal.descPlaceholder')}
                  rows={3}
                  maxLength={2000}
                />
              </label>

              <div className="form-row">
                <label>
                  <span>{t('settings.startDate')}</span>
                  <input
                    type="date"
                    value={form.startDate}
                    onChange={(e) => setForm({ ...form, startDate: e.target.value })}
                  />
                </label>
                <label>
                  <span>{t('settings.endDate')}</span>
                  <input
                    type="date"
                    value={form.endDate}
                    onChange={(e) => setForm({ ...form, endDate: e.target.value })}
                  />
                </label>
              </div>

              <div className="form-row">
                <label>
                  <span>{t('settings.budget')}</span>
                  <input
                    type="number"
                    min="0"
                    step="0.01"
                    value={form.budgetAmount}
                    onChange={(e) => setForm({ ...form, budgetAmount: e.target.value })}
                  />
                </label>
                <label>
                  <span>{t('settings.currency')}</span>
                  <input
                    type="text"
                    maxLength={8}
                    value={form.budgetCurrency}
                    onChange={(e) =>
                      setForm({ ...form, budgetCurrency: e.target.value.toUpperCase() })
                    }
                  />
                </label>
                <label>
                  <span>{t('settings.budgetType')}</span>
                  <select
                    value={form.budgetType}
                    onChange={(e) => setForm({ ...form, budgetType: e.target.value })}
                  >
                    {BUDGET_TYPES.map((o) => (
                      <option key={o.value} value={o.value}>
                        {t(o.i18n)}
                      </option>
                    ))}
                  </select>
                </label>
              </div>

              <div className="modal-actions">
                <button
                  type="button"
                  className="btn-secondary"
                  onClick={handleCloseModal}
                  disabled={saving}
                >
                  {t('common.cancel')}
                </button>
                <button type="submit" className="btn-primary" disabled={saving}>
                  {saving ? <Loader size={16} className="spin" /> : <Plus size={16} />}
                  <span>{saving ? t('common.creating') : t('projects.modal.create')}</span>
                </button>
              </div>
            </form>
          </div>
        </div>
      ) : null}
    </div>
  );
};

export default Projects;
