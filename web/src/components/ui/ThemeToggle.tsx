import { Moon, Sun } from 'lucide-react';
import { t } from '../../i18n';
import { useTheme } from '../../lib/theme';
import { IconButton } from './IconButton';

export function ThemeToggle() {
  const [theme, setTheme] = useTheme();
  const dark = theme === 'dark';
  return (
    <IconButton
      icon={dark ? Sun : Moon}
      label={dark ? t('theme.toLight') : t('theme.toDark')}
      onClick={() => setTheme(dark ? 'light' : 'dark')}
    />
  );
}
