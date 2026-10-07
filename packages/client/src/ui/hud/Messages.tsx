import { CSSProperties, useEffect, useRef } from 'react';
import { useT } from '../../i18n';
import { GameView, HudMessage } from '../../game/view';
import { Icon } from '../icons/Icon';

const hex = (c: number) => '#' + c.toString(16).padStart(6, '0');

function Line({ m }: { m: HudMessage }) {
  return (
    <div className={`msg${m.system ? ' sys' : ''}`}>
      {m.time && <time>{m.time}</time>}
      {m.system && <Icon name="info" />}
      {m.from
        ? <span className="msg__text"><b className="msg__from" style={{ '--team': hex(m.color ?? 0xffffff) } as CSSProperties}><span className="hud-pennant" aria-hidden="true" />{m.from}:</b> {m.text}</span>
        : <span className="msg__text">{m.text}</span>}
    </div>
  );
}

/**
 * The message log above the minimap (system news and chat, each with the match time), and the chat line when it is open:
 * the whole recent log over the input. On touch the open chat docks to the top edge, clear of the on-screen keyboard.
 */
export function Messages({ view, messages, chatOpen }: { view: GameView; messages: HudMessage[]; chatOpen: boolean }) {
  const t = useT();
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => { if (chatOpen) ref.current?.focus(); }, [chatOpen]);
  if (!chatOpen) return messages.length ? <div className="hud-msgs" aria-live="polite">{messages.map((m) => <Line key={m.id} m={m} />)}</div> : null;
  return (
    <div className="hud-chat-input">
      {messages.length > 0 && <div className="hud-msgs is-log">{messages.map((m) => <Line key={m.id} m={m} />)}</div>}
      <div className="hud-chat-row">
        <input ref={ref} className="hud-chat-field" placeholder={t('chat')} aria-label={t('chat')} maxLength={200} enterKeyHint="send"
          onKeyDown={(e) => { if (e.key === 'Enter') view.sendChat(e.currentTarget.value); if (e.key === 'Escape') view.sendChat(''); }} />
        <button className="hud-btn" onClick={() => view.sendChat(ref.current?.value ?? '')}>{t('send')}</button>
      </div>
    </div>
  );
}
