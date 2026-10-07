import { useT } from '../../i18n';

/**
 * The game's name as a two-tier lockup: the words before the last one small and widely tracked in madder ("POCKET OF",
 * the one rubric of the title page), the last word large in ink ("EMPIRE"). The name itself stays in i18n; screen
 * readers get it whole. The old `logo-lead` / `logo-main` class names stay beside the new ones for scripts that look
 * for them.
 */
export function GameLogo({ className }: { className?: string }) {
  const t = useT();
  const title = t('title');
  const cut = title.lastIndexOf(' ');
  const lead = cut > 0 ? title.slice(0, cut) : '';
  const main = cut > 0 ? title.slice(cut + 1) : title;
  return (
    <h1 className={className ? `logo ${className}` : 'logo'} aria-label={title}>
      {lead && <span className="logo__lead logo-lead" aria-hidden="true">{lead}</span>}
      <span className="logo__main logo-main" aria-hidden="true">{main}</span>
    </h1>
  );
}
