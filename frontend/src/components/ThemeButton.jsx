import { Moon, Sun, Monitor } from 'lucide-react';

// The page owns the theme state because it also themes its own container.
export default function ThemeButton({ pref, onClick, className = 'btn', size = 18 }) {
  const Icon = pref === 'light' ? Sun : pref === 'dark' ? Moon : Monitor;
  return (
    <button type="button" className={className} onClick={onClick} title={`Theme: ${pref}`}>
      <Icon size={size} />
    </button>
  );
}
