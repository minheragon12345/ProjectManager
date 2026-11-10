import { useNavigate } from 'react-router-dom';
import { LogOut } from 'lucide-react';
import { logout } from '../services/authService';
import { useI18n } from '../i18n';

export default function LogoutButton({ className = 'btn', size = 18 }) {
  const { t } = useI18n();
  const navigate = useNavigate();
  const handleLogout = () => {
    logout();
    navigate('/login');
  };
  return (
    <button type="button" className={className} onClick={handleLogout} title={t('common.signOut')}>
      <LogOut size={size} />
      <span>{t('common.logout')}</span>
    </button>
  );
}
