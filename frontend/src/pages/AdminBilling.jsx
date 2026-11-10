import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { toast } from 'react-toastify';
import { ArrowLeft, BadgeDollarSign, Loader, Save, Search } from 'lucide-react';
import { getUsers, updateBillingRate } from '../services/adminService';
import { useTheme } from '../hooks/useTheme';
import { useI18n } from '../i18n';
import LanguageSwitcher from '../components/LanguageSwitcher';
import ThemeButton from '../components/ThemeButton';
import LogoutButton from '../components/LogoutButton';
import './AdminBilling.css';

function getCurrentUser() {
  try {
    return JSON.parse(localStorage.getItem('user') || 'null');
  } catch {
    return null;
  }
}

function getRowValues(user, draft) {
  return {
    billingRate: draft?.billingRate ?? String(user.billingRate ?? 0),
    billingCurrency: draft?.billingCurrency ?? (user.billingCurrency || 'USD'),
  };
}

function isValidRow(values) {
  const rate = Number(values.billingRate);
  const currency = values.billingCurrency.trim();
  return values.billingRate.trim() !== '' && Number.isFinite(rate) && rate >= 0 && currency.length > 0 && currency.length <= 8;
}

export default function AdminBilling() {
  const navigate = useNavigate();
  const { t } = useI18n();
  const { pref: themePref, resolved: theme, cycle: cycleTheme } = useTheme();
  const [isAdmin] = useState(() => getCurrentUser()?.role === 'admin');
  const [users, setUsers] = useState([]);
  const [drafts, setDrafts] = useState({});
  const [loading, setLoading] = useState(true);
  const [savingId, setSavingId] = useState(null);
  const [search, setSearch] = useState('');
  const [query, setQuery] = useState('');

  // Search once typing pauses instead of on every keystroke.
  useEffect(() => {
    const timer = setTimeout(() => {
      const next = search.trim();
      if (next === query) return;
      setLoading(true);
      setQuery(next);
    }, 300);
    return () => clearTimeout(timer);
  }, [search, query]);

  useEffect(() => {
    if (!isAdmin) return undefined;
    let isStale = false;
    getUsers(query)
      .then((data) => {
        if (!isStale) setUsers(Array.isArray(data?.users) ? data.users : []);
      })
      .catch((err) => toast.error(err.message))
      .finally(() => {
        if (!isStale) setLoading(false);
      });
    return () => {
      isStale = true;
    };
  }, [isAdmin, query]);

  const handleChange = (user, field, value) => {
    setDrafts((current) => ({ ...current, [user._id]: { ...getRowValues(user, current[user._id]), [field]: value } }));
  };

  const handleSave = async (user) => {
    const values = getRowValues(user, drafts[user._id]);
    setSavingId(user._id);
    try {
      const data = await updateBillingRate(user._id, {
        billingRate: Number(values.billingRate),
        billingCurrency: values.billingCurrency.trim().toUpperCase(),
      });
      setUsers((current) => current.map((item) => (item._id === user._id ? data.user : item)));
      setDrafts((current) => {
        const next = { ...current };
        delete next[user._id];
        return next;
      });
      toast.success(t('billing.saved', { name: user.username }));
    } catch (err) {
      toast.error(err.message);
    } finally {
      setSavingId(null);
    }
  };

  const goBack = () => (window.history.length > 1 ? navigate(-1) : navigate('/projects'));

  return (
    <div className={`billing-container ${theme}-theme`}>
      <div className="billing-header">
        <div className="billing-title">
          <BadgeDollarSign size={22} />
          <div>
            <h2>{t('billing.heading')}</h2>
            <p>{t('billing.sub')}</p>
          </div>
        </div>
        <div className="billing-actions">
          <LanguageSwitcher />
          <ThemeButton pref={themePref} onClick={cycleTheme} />
          <button type="button" className="btn" onClick={goBack}>
            <ArrowLeft size={18} />
            <span>{t('common.back')}</span>
          </button>
          <LogoutButton />
        </div>
      </div>

      {!isAdmin ? (
        <div className="billing-empty-state">{t('billing.adminOnly')}</div>
      ) : (
        <>
          <div className="billing-search">
            <Search size={16} />
            <input
              type="text"
              value={search}
              placeholder={t('billing.search')}
              onChange={(e) => setSearch(e.target.value)}
            />
            {loading ? <Loader size={16} className="spin" /> : null}
          </div>

          <div className="billing-table-wrap">
            <table className="billing-table">
              <thead>
                <tr>
                  <th>{t('billing.col.user')}</th>
                  <th>{t('billing.col.role')}</th>
                  <th>{t('billing.col.rate')}</th>
                  <th>{t('billing.col.currency')}</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {users.length === 0 && !loading ? (
                  <tr>
                    <td colSpan={5} className="billing-empty">{t('billing.empty')}</td>
                  </tr>
                ) : null}
                {users.map((user) => {
                  const values = getRowValues(user, drafts[user._id]);
                  const isChanged = !!drafts[user._id];
                  const isSaving = savingId === user._id;
                  return (
                    <tr key={user._id}>
                      <td>
                        <strong>{user.username}</strong>
                        <div className="billing-email">{user.email}</div>
                      </td>
                      <td>
                        <span className={`billing-role role-${user.role}`}>{user.role}</span>
                      </td>
                      <td>
                        <input
                          type="number"
                          min="0"
                          max="100000"
                          step="0.5"
                          className="billing-input"
                          value={values.billingRate}
                          onChange={(e) => handleChange(user, 'billingRate', e.target.value)}
                        />
                      </td>
                      <td>
                        <input
                          type="text"
                          maxLength={8}
                          className="billing-input billing-currency"
                          value={values.billingCurrency}
                          onChange={(e) => handleChange(user, 'billingCurrency', e.target.value.toUpperCase())}
                        />
                      </td>
                      <td>
                        <button
                          type="button"
                          className="btn btn-save-rate"
                          disabled={!isChanged || !isValidRow(values) || isSaving}
                          onClick={() => handleSave(user)}
                        >
                          {isSaving ? <Loader size={16} className="spin" /> : <Save size={16} />}
                          <span>{t('common.save')}</span>
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}
