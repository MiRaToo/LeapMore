import { Fragment, useRef } from 'react';
import type { CSSProperties, ReactNode } from 'react';

export function SlidingSelector({ options, optionLabels, selected, change, label, nav, concealed = false }: {
  options: ReactNode[]; optionLabels?: readonly string[]; selected: number; change: (index: number) => void; label: string; nav?: boolean; concealed?: boolean;
}) {
  const pointer = useRef<{ x: number; y: number } | null>(null);
  const suppress = useRef(false);
  const wrap = (index: number) => (index + options.length) % options.length;
  return <div className={(nav ? 'tabbar' : 'record-tabs') + ' sliding-selector' + (concealed ? ' nav-concealed' : '')}
    role={nav ? 'navigation' : 'tablist'} aria-label={label} aria-hidden={concealed || undefined}
    style={{ '--selection-count': options.length } as CSSProperties}
    onPointerDown={event => { pointer.current = { x: event.clientX, y: event.clientY }; suppress.current = false; }}
    onPointerCancel={() => { pointer.current = null; }}
    onPointerUp={event => {
      if (!pointer.current) return;
      const dx = event.clientX - pointer.current.x, dy = event.clientY - pointer.current.y;
      pointer.current = null;
      if (Math.abs(dx) < 36 || Math.abs(dx) < Math.abs(dy)) return;
      suppress.current = true;
      change(Math.max(0, Math.min(options.length - 1, selected + (dx > 0 ? 1 : -1))));
    }}
    onKeyDown={event => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      const index = event.key === 'Home' ? 0 : event.key === 'End' ? options.length - 1 : wrap(selected + (event.key === 'ArrowRight' ? 1 : -1));
      change(index);
      event.currentTarget.querySelectorAll('button')[index]?.focus({ preventScroll: true });
    }}>
    {nav && <span className="tab-indicator" aria-hidden style={{ transform: 'translateX(' + selected * 100 + '%)' }} />}
    {options.map((text, i) => <Fragment key={i}>
      {!nav && i > 0 && <span className="record-tab-divider" aria-hidden="true">｜</span>}
      <button type="button" className={nav ? 'tab' : undefined} role={nav ? undefined : 'tab'}
      id={nav ? undefined : 'record-tab-' + i} aria-controls={nav ? undefined : 'record-panel'}
      aria-label={optionLabels?.[i]}
      aria-current={nav && i === selected ? 'page' : undefined} aria-selected={nav ? undefined : i === selected}
      tabIndex={!concealed && (nav || selected === i) ? 0 : -1} onClick={event => {
        if (!suppress.current || event.detail === 0) change(i);
        suppress.current = false;
      }}>{text}</button></Fragment>)}
  </div>;
}
