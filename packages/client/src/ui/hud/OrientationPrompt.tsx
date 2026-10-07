import { useEffect, useState } from 'react';
import { useT } from '../../i18n';
import { usePortrait } from '../../touch';
import { Icon } from '../icons/Icon';

/**
 * Portrait is playable but cramped; say so once, on a small night sheet with the turning-phone sign, and get out of the
 * way: a tap anywhere plays on in portrait, and the card comes back only after a turn to landscape and back.
 */
export function OrientationPrompt() {
  const t = useT();
  const portrait = usePortrait();
  const [dismissed, setDismissed] = useState(false);
  useEffect(() => { if (!portrait) setDismissed(false); }, [portrait]);
  if (!portrait || dismissed) return null;
  return (
    <div className="orient-prompt scrim" role="dialog" aria-modal="true" aria-labelledby="orient-title" onClick={() => setDismissed(true)}>
      <div className="orient-card sheet sheet--framed">
        <div className="orient-icon" aria-hidden="true"><Icon name="rotate-device" /></div>
        <h3 id="orient-title" className="orient-title">{t('rotateDevice')}</h3>
        <p className="orient-hint">{t('rotateDeviceHint')}</p>
      </div>
    </div>
  );
}
