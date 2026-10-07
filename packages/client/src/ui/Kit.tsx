import { CSSProperties, ReactNode, useEffect, useState } from 'react';
import { PLAYER_COLORS } from '@pocket-of-empire/sim';
import { Icon, IconId } from './icons/Icon';
import { ICONS } from './icons/icons.generated';
import '../styles/kit.css';

/**
 * `?kit` on the dev server: the «Ночной атлас» design system on one dark sheet — palette, type, every component in
 * every state, the icon set, and the old class names drawn by the compatibility layer. It is the visual reference for
 * the screen tracks (class names and markup: SP/design/COMPONENTS.md). Not part of the game: App renders it only in dev.
 */

const hex = (c: number) => '#' + c.toString(16).padStart(6, '0');
const vars = (v: Record<string, string | number>) => v as CSSProperties;

function Section({ no, title, meta, children }: { no: string; title: string; meta?: string; children: ReactNode }) {
  return (
    <section className="sheet sheet--framed kit-section">
      <div className="legend-head">
        <span className="legend-head__no">{no}</span>
        <h2 className="legend-head__name">{title}</h2>
        {meta && <span className="legend-head__meta">{meta}</span>}
      </div>
      {children}
    </section>
  );
}

function Spec({ label, code, children }: { label: string; code?: string; children: ReactNode }) {
  return (
    <div className="kit-spec">
      <div className="kit-spec__label">
        <span>{label}</span>
        {code && <code>{code}</code>}
      </div>
      <div className="kit-spec__body">{children}</div>
    </div>
  );
}

const SWATCHES: { group: string; items: [string, string][] }[] = [
  { group: 'Лист (ночной пергамент)', items: [['--table', 'стол за листами'], ['--paper', 'лист'], ['--paper-hi', 'приподнятое'], ['--paper-hover', 'наведение'], ['--paper-lo', 'углублённое'], ['--paper-deep', 'нажатое'], ['--paper-edge', 'рамка (латунь)']] },
  { group: 'Чернила', items: [['--ink', 'текст'], ['--ink-2', 'второй'], ['--ink-3', 'подписи, мин.'], ['--rule', 'волосяная'], ['--rule-2', 'твёрдая линия']] },
  { group: 'Сланец (HUD)', items: [['--slate-solid', 'панель'], ['--slate-hi', 'кнопка'], ['--slate-hover', 'наведение'], ['--on-slate', 'текст'], ['--on-slate-2', 'второй'], ['--on-slate-3', 'подписи']] },
  { group: 'Акценты', items: [['--madder', 'печать'], ['--madder-line', 'опасность, линия'], ['--madder-ink', 'ошибка, текст'], ['--verdigris', 'выбрано'], ['--verdigris-ink', 'выбрано, текст, фокус'], ['--brass', 'булавки'], ['--gold', 'золото (ресурс)'], ['--ochre', 'внимание']] },
  { group: 'Здоровье и метка', items: [['--hp-ok', 'HP норма'], ['--hp-low', 'HP мало'], ['--hp-crit', 'HP критично'], ['--tag', 'клавиша (единств. светлое)']] },
];

const TIERS: { key: string; name: string; col: string; icon: IconId }[] = [
  { key: 'unranked', name: 'Без ранга', col: '#9a917f', icon: 'tier-unranked' },
  { key: 'bronze', name: 'Хутор', col: '#c08552', icon: 'tier-bronze' },
  { key: 'silver', name: 'Деревня', col: '#cfd3d8', icon: 'tier-silver' },
  { key: 'gold', name: 'Город', col: '#e8c76a', icon: 'tier-gold' },
  { key: 'platinum', name: 'Крепость', col: '#8fd8d2', icon: 'tier-platinum' },
  { key: 'diamond', name: 'Столица', col: '#8fb8ff', icon: 'tier-diamond' },
  { key: 'master', name: 'Королевство', col: '#d08ce8', icon: 'tier-master' },
  { key: 'grandmaster', name: 'Империя', col: '#ff9f6a', icon: 'tier-grandmaster' },
];

const iconIds = () => Object.keys(ICONS).sort() as IconId[];
const has = (id: string): id is IconId => id in ICONS;
const ic = (id: string, fallback: IconId = 'info'): IconId => (has(id) ? id : fallback);

export default function Kit() {
  const [speed, setSpeed] = useState(1);
  const [tab, setTab] = useState(0);
  const [team, setTeam] = useState(2);
  const [lang, setLang] = useState<'en' | 'ru'>('ru');
  const [vol, setVol] = useState(0.4);
  const [scroll, setScroll] = useState(60);
  const [edge, setEdge] = useState(true);
  const [shadows, setShadows] = useState(true);
  const [row, setRow] = useState(1);
  useEffect(() => {
    document.documentElement.classList.add('kit-page');
    document.title = 'Night atlas kit — Pocket of Empire';
    return () => document.documentElement.classList.remove('kit-page');
  }, []);

  const ids = iconIds();
  const states = ['обычное', 'наведение', 'нажатие', 'недоступно', 'фокус'];
  const stateCls = ['', 'is-hover', 'is-active', '', 'is-focus'];
  const btnRow = (cls: string, label: ReactNode, aria?: string) => states.map((s, i) => (
    <button key={s} className={`btn ${cls} ${stateCls[i]}`} disabled={i === 3} aria-label={aria}>{label}</button>
  ));

  return (
    <main className="kit">
      <header className="kit-head">
        <div>
          <p className="kit-head__lead">Pocket of Empire · дизайн-система</p>
          <h1 className="h1">Ночной атлас</h1>
          <p className="lede">Генерал за походным столом ночью: меню и диалоги — тёмные листы карты, светлые железо-галловые чернила,
            латунная рамка. Одна мадерная печать на экран — приказ, который отдаёшь. Ярь-медянка — то, что выбрано.</p>
        </div>
        <div className="kit-head__seal"><span className="seal seal--lg" aria-hidden="true" /></div>
      </header>

      <Section no="I" title="Палитра" meta="styles/tokens.css">
        <div className="kit-swatches">
          {SWATCHES.map((g) => (
            <div key={g.group} className="kit-swatch-group">
              <h3 className="kit-sub">{g.group}</h3>
              <div className="kit-swatch-row">
                {g.items.map(([v, note]) => (
                  <div key={v} className="kit-swatch">
                    <i style={vars({ background: `var(${v})` })} />
                    <code>{v}</code>
                    <span>{note}</span>
                  </div>
                ))}
              </div>
            </div>
          ))}
          <div className="kit-swatch-group">
            <h3 className="kit-sub">Цвета команд (только флаги и флажки игроков)</h3>
            <div className="kit-teams">
              {PLAYER_COLORS.slice(0, 12).map((c, i) => <span key={i} className="pennant" style={vars({ '--team': hex(c) })}><Icon name="flag" />{i + 1}</span>)}
            </div>
          </div>
        </div>
      </Section>

      <Section no="II" title="Шрифты" meta="Brygada 1918 · Ysabeau Office">
        <div className="kit-type">
          <div className="kit-logo">
            <span className="kit-logo__lead">Pocket of</span>
            <span className="kit-logo__main">Empire</span>
            <span className="kit-logo__scale"><i /><i /><i /><i /><i /></span>
            <span className="kit-logo__cap">масштаб карманный</span>
          </div>
          <div className="kit-type__scale">
            <Spec label="h1 · 34" code=".h1"><span className="h1">Против ИИ</span></Spec>
            <Spec label="h2 · 24" code=".h2 / .dialog__title"><span className="h2">Моменты матча</span></Spec>
            <Spec label="h3 · 18" code=".h3 / .legend-head__name"><span className="h3">Игроки</span></Spec>
            <Spec label="текст · 15" code="body"><span>Строит, чинит и добывает золото. Свободный рабочий сам находит работу.</span></Spec>
            <Spec label="вводка · 16 курсив" code=".lede"><span className="lede">Duel Valley — terra incognita</span></Spec>
            <Spec label="подписи · 13" code=".meta"><span className="meta">64×64 · 2 игрока · 4:09 · вчера, 18:31</span></Spec>
            <Spec label="микро · 11" code=".micro"><span className="micro">ИГРОКОВ 4 · КАРТА 96</span></Spec>
            <Spec label="числа" code=".num (lining tabular)"><span className="num kit-big-num">332 · 4/10 · 1 000 · 1 840</span></Spec>
            <Spec label="эпохи" code=".roman (serif)"><span className="roman kit-big-num">I · II</span></Spec>
            <Spec label="HUD" code="--t-hud-res / -name / -label"><span className="kit-hud-type"><b>332</b><span>Рабочий</span><small>Казарма</small></span></Spec>
          </div>
        </div>
      </Section>

      <Section no="III" title="Кнопки" meta="одна печать на экран · опасное — со штриховкой и подтверждением">
        <div className="kit-matrix">
          <div className="kit-matrix__head"><span />{states.map((s) => <span key={s}>{s}</span>)}</div>
          <div className="kit-matrix__row"><span className="kit-matrix__label">Печать<code>.btn--seal</code></span>{btnRow('btn--seal', 'Старт')}</div>
          <div className="kit-matrix__row"><span className="kit-matrix__label">Печать малая<code>.btn--seal.btn--compact</code></span>{btnRow('btn--seal btn--compact', 'Смотреть')}</div>
          <div className="kit-matrix__row"><span className="kit-matrix__label">Обычная<code>.btn--secondary</code></span>{btnRow('btn--secondary', 'Выйти в меню')}</div>
          <div className="kit-matrix__row"><span className="kit-matrix__label">Тихая<code>.btn--quiet</code></span>{btnRow('btn--quiet', <><Icon name="save" />Сохранить реплей</>)}</div>
          <div className="kit-matrix__row"><span className="kit-matrix__label">Опасная<code>.btn--danger</code></span>{btnRow('btn--danger', <><Icon name="flag" />Сдаться</>)}</div>
          <div className="kit-matrix__row"><span className="kit-matrix__label">Значок<code>.btn--secondary.btn--icon</code></span>{btnRow('btn--secondary btn--icon', <Icon name="fullscreen" />, 'Во весь экран')}</div>
          <div className="kit-matrix__row"><span className="kit-matrix__label">Малая<code>.btn--secondary.btn--small</code></span>{btnRow('btn--secondary btn--small', <><Icon name="play" />Смотреть</>)}</div>
        </div>
        <div className="kit-row kit-gap-top">
          <Spec label="Во всю ширину" code=".btn--seal.btn--block"><div className="kit-w320"><button className="btn btn--seal btn--block">Против ИИ</button></div></Spec>
          <Spec label="Пара под печатью" code=".btn--secondary"><div className="kit-pair"><button className="btn btn--secondary"><Icon name="ranked" />Рейтинг</button><button className="btn btn--secondary"><Icon name="multiplayer" />Мультиплеер</button></div></Spec>
          <Spec label="Оттиск" code=".seal / .seal--lg"><span className="seal" aria-hidden="true" /><span className="seal seal--lg" aria-hidden="true" /></Spec>
        </div>
      </Section>

      <Section no="IV" title="Выбор и ввод" meta="масштабная линейка · закладки · поля · флажки · линейка">
        <div className="kit-cols">
          <div>
            <Spec label="Масштабная линейка (скорость)" code=".scalebar > button[role=radio][aria-checked]">
              <div className="scalebar" role="radiogroup" aria-label="Скорость">
                {[1, 2, 3, 5].map((v) => <button key={v} role="radio" aria-checked={speed === v} onClick={() => setSpeed(v)}>{v}×</button>)}
              </div>
            </Spec>
            <Spec label="Номер команды · наведение · фокус · недоступно" code=".is-hover / .is-focus / :disabled">
              <div className="scalebar" role="radiogroup" aria-label="Команда">
                {[1, 2, 3, 4].map((v) => <button key={v} role="radio" aria-checked={team === v} onClick={() => setTeam(v)} className={v === 3 ? 'is-hover' : v === 4 ? 'is-focus' : ''}>{v}</button>)}
                <button role="radio" aria-checked={false} disabled>5</button>
              </div>
            </Spec>
            <Spec label="Малая (язык), без делений" code=".scalebar.scalebar--sm">
              <div className="scalebar scalebar--sm" role="radiogroup" aria-label="Язык">
                <button role="radio" aria-checked={lang === 'en'} onClick={() => setLang('en')}>EN</button>
                <button role="radio" aria-checked={lang === 'ru'} onClick={() => setLang('ru')}>RU</button>
              </div>
            </Spec>
            <Spec label="Слова равного веса" code=".scalebar.scalebar--words">
              <div className="scalebar scalebar--words" role="radiogroup" aria-label="Карты">
                <button role="radio" aria-checked>Официальные</button><button role="radio" aria-checked={false}>Мои карты</button>
              </div>
            </Spec>
            <Spec label="Закладки (страницы)" code=".tabs > .tab[role=tab][aria-selected]">
              <div className="tabs" role="tablist">
                {['Итоги', 'Графики', 'Реплеи'].map((x, i) => <button key={x} className={`tab${i === 2 ? ' is-hover' : ''}`} role="tab" aria-selected={tab === i} onClick={() => setTab(i)}>{i === 1 && <Icon name="chart" />}{x}</button>)}
              </div>
            </Spec>
          </div>
          <div>
            <Spec label="Поле" code=".field > label + input.text">
              <label className="field"><span className="field__label">Ваше имя</span><input className="text" defaultValue="Grigory" /></label>
            </Spec>
            <Spec label="Фокус · подсказка" code=".is-focus · .field__hint">
              <label className="field"><span className="field__label">Код комнаты</span><input className="text is-focus" placeholder="например, K7Q2" /><span className="field__hint">5 букв из приглашения</span></label>
            </Spec>
            <Spec label="Ошибка" code="[aria-invalid=true] + .field__error">
              <label className="field"><span className="field__label">Почта</span><input className="text" aria-invalid="true" defaultValue="grigory@" /><span className="field__error">Это не похоже на адрес почты.</span></label>
            </Spec>
            <Spec label="Недоступно" code=":disabled">
              <label className="field"><span className="field__label">Ник (нужен сервер)</span><input className="text" disabled defaultValue="Grigory" /></label>
            </Spec>
            <Spec label="Список" code="select.select (родной)">
              <label className="field"><span className="field__label">Сложность</span><select className="select" defaultValue="1"><option value="0">Лёгкий</option><option value="1">Средний</option><option value="2">Тяжёлый</option></select></label>
            </Spec>
            <Spec label="Текст" code="textarea.text">
              <textarea className="text" defaultValue="Сообщение в чат комнаты" />
            </Spec>
          </div>
          <div>
            <Spec label="Флажок" code="label.check > input[type=checkbox]">
              <div className="kit-stack">
                <label className="check"><input type="checkbox" checked={shadows} onChange={(e) => setShadows(e.target.checked)} />Тени</label>
                <label className="check"><input type="checkbox" defaultChecked={false} />Режим для дальтоников</label>
                <label className="check"><input type="checkbox" disabled />Недоступно</label>
                <label className="check"><input type="checkbox" disabled defaultChecked />Недоступно, включено</label>
              </div>
            </Spec>
            <Spec label="Переключатель: латунная булавка" code="input.toggle[type=checkbox][role=switch]">
              <div className="kit-stack">
                <label className="toggle-row"><input type="checkbox" className="toggle" role="switch" checked={edge} onChange={(e) => setEdge(e.target.checked)} />Скролл у краёв</label>
                <label className="toggle-row"><input type="checkbox" className="toggle" role="switch" defaultChecked={false} />Панорама правой кнопкой</label>
                <label className="toggle-row"><input type="checkbox" className="toggle" role="switch" disabled />Недоступно</label>
              </div>
            </Spec>
            <Spec label="Линейка: значение справа" code=".ruler-row > input.ruler[type=range] + .ruler__value">
              <div className="kit-stack">
                <div className="ruler-row"><input type="range" className="ruler" min={0} max={1} step={0.05} value={vol} onChange={(e) => setVol(Number(e.target.value))} style={vars({ '--v': vol })} aria-label="Громкость" /><output className="ruler__value">{Math.round(vol * 100)}%</output></div>
                <div className="ruler-row"><input type="range" className="ruler" min={15} max={90} value={scroll} onChange={(e) => setScroll(Number(e.target.value))} style={vars({ '--v': (scroll - 15) / 75 })} aria-label="Скорость прокрутки" /><output className="ruler__value">{scroll}</output></div>
                <div className="ruler-row"><input type="range" className="ruler" disabled defaultValue={50} aria-label="Недоступно" /><output className="ruler__value">—</output></div>
              </div>
            </Spec>
          </div>
        </div>
      </Section>

      <Section no="V" title="Листы и диалог" meta=".sheet · .sheet--framed · .slip · .well · .scrim > .dialog">
        <div className="kit-cols">
          <div className="kit-stack">
            <Spec label="Лист" code=".sheet"><div className="sheet kit-demo-box">Тёмный пергамент с зерном.</div></Spec>
            <Spec label="Лист в рамке (экран, диалог)" code=".sheet.sheet--framed"><div className="sheet sheet--framed kit-demo-box">Двойная рамка карты: 2 px латунь · 3 px · 1 px чернила.</div></Spec>
            <Spec label="Плотный лист" code=".sheet.sheet--ruled"><div className="sheet sheet--ruled kit-demo-box">Одна волосяная линия для тесных экранов.</div></Spec>
            <Spec label="Листок" code=".slip"><div className="slip kit-demo-box">Маленькая карточка: поповер, подсказка.</div></Spec>
            <Spec label="Углубление" code=".well"><div className="well kit-demo-box"><span className="meta">Гость42: привет</span><br /><span className="meta">Grigory: го 2×2</span></div></Spec>
          </div>
          <div className="kit-scrim-demo">
            <div className="scrim">
              <div className="dialog sheet sheet--framed" role="dialog" aria-modal="true" aria-labelledby="kit-dlg">
                <div className="dialog__head">
                  <div><h2 className="dialog__title" id="kit-dlg">Пауза</h2><p className="dialog__sub">4:09 · Duel Valley</p></div>
                  <button className="btn btn--quiet btn--icon dialog__close" aria-label="Закрыть"><Icon name="close" /></button>
                </div>
                <div className="dialog__body">
                  <div className="ledger ledger--dense">
                    <button className="ledger__row"><Icon name="save" /><span className="ledger__name">Сохранить реплей</span><span className="ledger__dots" /><span className="ledger__value">2,4 МБ</span></button>
                    <button className="ledger__row"><Icon name="settings" /><span className="ledger__name">Настройки</span><span className="ledger__dots" /><span className="ledger__value">звук, клавиши</span></button>
                  </div>
                </div>
                <div className="dialog__foot">
                  <button className="btn btn--danger btn--compact"><Icon name="flag" />Сдаться…</button>
                  <span className="spacer" />
                  <button className="btn btn--quiet btn--compact">Выйти в меню</button>
                  <button className="btn btn--seal">Продолжить</button>
                </div>
              </div>
            </div>
          </div>
        </div>
      </Section>

      <Section no="VI" title="Списки" meta=".ledger · .row-item · .table">
        <div className="kit-cols">
          <Spec label="Оглавление: строки с точечной выноской" code=".ledger > .ledger__row">
            <div className="ledger">
              <button className="ledger__row"><Icon name="map-editor" /><span className="ledger__name">Редактор карт</span><span className="ledger__dots" /><span className="ledger__value">2 карты</span></button>
              <button className="ledger__row is-hover"><Icon name="replays" /><span className="ledger__name">Реплеи</span><span className="ledger__dots" /><span className="ledger__value">7 записей</span></button>
              <button className="ledger__row"><Icon name="settings" /><span className="ledger__name">Настройки</span><span className="ledger__dots" /><span className="ledger__value">звук, клавиши</span></button>
              <button className="ledger__row"><Icon name="about" /><span className="ledger__name">Об игре</span><span className="ledger__dots" /><span className="ledger__value">версия 0.9</span></button>
            </div>
          </Spec>
          <Spec label="Настройки: значение — контрол, конфликт мадерой" code=".ledger__row (div) · .is-conflict">
            <div className="ledger ledger--dense">
              <div className="ledger__row"><span className="ledger__name">Язык</span><span className="ledger__dots" /><span className="ledger__value"><select className="select" defaultValue="ru"><option value="en">English</option><option value="ru">Русский</option></select></span></div>
              <div className="ledger__row"><span className="ledger__name">Скролл у краёв</span><span className="ledger__dots" /><span className="ledger__value"><input type="checkbox" className="toggle" role="switch" defaultChecked aria-label="Скролл у краёв" /></span></div>
              <div className="ledger__row"><span className="ledger__name">Атака с движением</span><span className="ledger__dots" /><span className="ledger__value"><kbd className="keycap">A</kbd></span></div>
              <div className="ledger__row is-conflict"><span className="ledger__name">Патруль</span><span className="ledger__dots" /><span className="ledger__value">как у «Атаки» <kbd className="keycap">A</kbd></span></div>
            </div>
          </Spec>
          <Spec label="Строка списка: наведение, выбранная" code=".row-item · .is-selected / [aria-selected]">
            <div>
              {['Duel Valley · Grigory против Бот 2', 'Crossroads · четыре стороны', 'Twin Rivers · рейтинг'].map((x, i) => (
                <div key={x} className={`row-item${i === 2 ? ' is-hover' : ''}`} aria-selected={row === i} onClick={() => setRow(i)}>
                  <Icon name="replay" />
                  <div className="row-item__main"><div className="row-item__title">{x}</div><div className="row-item__meta">сегодня, 14:2{i} · {i ? 'победа' : 'поражение'}</div></div>
                  {i === 1 ? <button className="btn btn--seal btn--compact">Смотреть</button> : <button className="btn btn--quiet btn--icon" aria-label="Удалить"><Icon name="trash" /></button>}
                </div>
              ))}
            </div>
          </Spec>
        </div>
        <Spec label="Таблица цифр" code="table.table · tr.is-me">
          <table className="table">
            <thead><tr><th>Игрок</th><th>Армия</th><th>Убито</th><th>Потеряно</th><th>Золото</th><th>Построек</th></tr></thead>
            <tbody>
              <tr className="is-me"><td><span className="pennant" style={vars({ '--team': hex(PLAYER_COLORS[0]) })}><Icon name="flag" />Grigory</span></td><td>24</td><td className="best">31</td><td>18</td><td>2 840</td><td>9</td></tr>
              <tr><td><span className="pennant" style={vars({ '--team': hex(PLAYER_COLORS[1]) })}><Icon name="flag" />Бот 2</span></td><td>19</td><td>18</td><td>31</td><td className="best">3 120</td><td className="dim">7</td></tr>
              <tr><td><span className="pennant is-out" style={vars({ '--team': hex(PLAYER_COLORS[2]) })}><Icon name="flag" />Бот 3</span></td><td>0</td><td>4</td><td>22</td><td>1 040</td><td className="dim">0</td></tr>
            </tbody>
          </table>
        </Spec>
      </Section>

      <Section no="VII" title="Знаки" meta="значки · ранги · флажки · клавиши · подсказка · уведомления · ход">
        <div className="kit-cols">
          <div className="kit-stack">
            <Spec label="Значок" code=".badge (+ --ok / --warn / --danger / --solid)">
              <div className="kit-row"><span className="badge">хост</span><span className="badge badge--ok"><Icon name="check" />готов</span><span className="badge badge--warn">старая версия</span><span className="badge badge--danger"><Icon name="lock" />закрыто</span><span className="badge badge--solid">K7Q2X</span></div>
            </Spec>
            <Spec label="Ранги: знаки поселений" code=".tier[style=--tier-col] > .tier__sign + .tier__name">
              <div className="kit-row kit-wrap">
                {TIERS.map((x, i) => <span key={x.key} className={`tier${i === 0 ? ' tier--none' : ''}`} style={vars({ '--tier-col': x.col })}><span className="tier__sign"><Icon name={ic(x.icon)} /></span><span className="tier__name">{x.name}</span></span>)}
              </div>
              <div className="kit-row kit-gap-top"><span className="tier tier--lg" style={vars({ '--tier-col': TIERS[4].col })}><span className="tier__sign"><Icon name={ic(TIERS[4].icon)} /></span><span className="tier__name">Крепость · 1 612</span></span></div>
            </Spec>
            <Spec label="Флажок игрока" code=".pennant[style=--team] > Icon flag">
              <div className="kit-row kit-wrap">
                <span className="pennant" style={vars({ '--team': hex(PLAYER_COLORS[0]) })}><Icon name="flag" />Grigory</span>
                <span className="pennant" style={vars({ '--team': hex(PLAYER_COLORS[1]) })}><Icon name="flag" />Бот 2 <span className="pennant__sub">средний</span></span>
                <span className="pennant is-out" style={vars({ '--team': hex(PLAYER_COLORS[3]) })}><Icon name="flag" />Ольга</span>
              </div>
            </Spec>
            <Spec label="Клавиша — единственное светлое" code="kbd.keycap"><div className="kit-row"><kbd className="keycap">A</kbd><kbd className="keycap">F10</kbd><kbd className="keycap">Esc</kbd><kbd className="keycap">Shift</kbd></div></Spec>
            <Spec label="Ход (пунктирный маршрут)" code=".progress > div[style=width]">
              <div className="progress" role="progressbar" aria-valuenow={64}><div style={{ width: '64%' }} /></div>
            </Spec>
            <Spec label="Шкала" code=".bar > div · .bar.xp"><div className="kit-w320"><div className="bar"><div style={{ width: '58%' }} /></div><div className="bar xp"><div style={{ width: '30%' }} /></div></div></Spec>
            <Spec label="Здоровье, деления по 10%" code=".hpbar(.low/.crit) > div">
              <div className="kit-w320 kit-stack">
                <div className="hpbar"><div style={{ width: '92%' }} /></div>
                <div className="hpbar low"><div style={{ width: '48%' }} /></div>
                <div className="hpbar crit"><div style={{ width: '17%' }} /></div>
              </div>
            </Spec>
            <Spec label="Ожидание: стрелка компаса" code=".spinner (.spinner--lg)"><div className="kit-row"><span className="spinner" /><span className="spinner spinner--lg" /><span className="meta">Ищем соперника… 0:14</span></div></Spec>
          </div>
          <div className="kit-stack">
            <Spec label="Подсказка приказа" code=".tip">
              <div className="tip" role="tooltip">
                <div className="tip__head"><span className="tip__name">Конница</span><kbd className="keycap">V</kbd></div>
                <div className="tip__cost"><span className="tip__gold"><Icon name="gold" />140</span><span><Icon name="timer" />28 с</span><span><Icon name="population" />2</span></div>
                <ul className="tip__req"><li><Icon name="check" />Казарма</li><li className="no"><Icon name="cross" />Нужна вторая эпоха</li></ul>
                <dl className="tip__stats"><dt>HP</dt><dd>160</dd><dt>Броня</dt><dd>тяжёлая</dd><dt>Урон</dt><dd>14 рубящий</dd><dt>Скорость</dt><dd>4,2</dd></dl>
                <p className="tip__desc">Быстрая и крепкая. Лучшая против лучников и катапульт в чистом поле.</p>
              </div>
            </Spec>
            <Spec label="Уведомления" code=".toast (+ --ok / --danger / --static)">
              <div className="kit-stack">
                <div className="toast toast--ok toast--static" role="status"><Icon name="check" />Реплей сохранён</div>
                <div className="toast toast--danger toast--static" role="alert"><Icon name="error" />Не хватает золота — <b>нужно ещё 68</b></div>
                <div className="toast toast--static" role="status"><Icon name="link" />Ссылка скопирована</div>
              </div>
            </Spec>
          </div>
        </div>
      </Section>

      <Section no="VIII" title="Условные знаки" meta={`ui/icons · ${ids.length} знаков · 16 / 20 / 28 px, currentColor`}>
        <div className="kit-icons">
          {ids.map((id) => (
            <div key={id} className="kit-icon">
              <span className="kit-icon__sizes"><Icon name={id} className="icon--16" /><Icon name={id} className="icon--20" /><Icon name={id} className="icon--28" /></span>
              <code>{id}</code>
            </div>
          ))}
        </div>
      </Section>

      <Section no="IX" title="Старая разметка (слой совместимости)" meta="как сейчас выглядят старые классы; экраны переходят на .btn и др.">
        <div className="kit-cols">
          <Spec label="button, .primary, .danger, .gold, .plain, .small-btn" code="components/button.css">
            <div className="kit-row kit-wrap">
              <button>Заполнить</button><button className="primary">Старт</button><button className="danger">Удалить</button>
              <button className="gold">Войти</button><button className="plain">Отмена</button><button className="small-btn">Мал.</button>
              <button disabled>Недоступно</button><button className="active">Выбрано</button>
            </div>
          </Spec>
          <Spec label=".seg (gold = выбрано) · .speeds > .speed-btn.primary" code="components/segmented.css">
            <div className="kit-stack">
              <div className="seg"><button className="gold">Официальные</button><button className="plain">Мои карты</button></div>
              <div className="row speeds">{[1, 2, 3, 5].map((v) => <button key={v} className={`speed-btn ${v === 2 ? 'primary' : ''}`}>{v}×</button>)}<span className="small muted">Всё быстрее во столько раз</span></div>
            </div>
          </Spec>
          <Spec label=".card.narrow h2/h3, .list > .list-item, input, select" code="components/surface.css, list.css">
            <div className="card narrow kit-card-demo">
              <h2>Мультиплеер</h2>
              <h3>Комнаты</h3>
              <div className="list">
                <div className="list-item"><span className="grow">Комната Grigory · 2/4</span><span className="badge">K7Q2X</span><button className="primary">Войти</button></div>
                <div className="list-item me"><span className="grow">Вы · 1 412</span></div>
              </div>
              <div className="row" style={{ marginTop: 12 }}><input className="grow" placeholder="Код комнаты" /><select defaultValue="b"><option value="a">Открыт</option><option value="b">Бот</option></select></div>
            </div>
          </Spec>
        </div>
      </Section>
    </main>
  );
}
