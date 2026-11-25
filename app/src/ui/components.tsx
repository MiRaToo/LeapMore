import { useId, useLayoutEffect, useRef } from 'react';
import type { ReactNode } from 'react';
import { createPortal } from 'react-dom';
import dialogPolyfill from 'dialog-polyfill';
import { Link } from 'react-router-dom';
import { Icon } from './Icon';
import type { IconName } from './Icon';

export const hasLocalCarAssets = __LEAPMORE_LOCAL_ASSETS__;
export const asset = (file: string) => import.meta.env.BASE_URL + 'assets/' + file;
export const value = (num: number | null | undefined, digits = 0) => num == null ? '—' : num.toFixed(digits);
export const clock = (time: number | undefined | null) =>
  time ? new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false }).format(time) : '—';
export const stamp = (time: number | undefined | null) =>
  time ? new Intl.DateTimeFormat('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }).format(time) : '—';

export function AppBar({ title, back, sub, action, className = '' }: { title: ReactNode; back?: string; sub?: string; action?: ReactNode; className?: string }) {
  return <header className={'appbar ' + className}>
    {back && <Link className="iconbtn" to={back} aria-label="返回"><Icon name="back" size={18} /></Link>}
    <div className="grow"><div className="title">{title}</div>{sub && <div className="sub">{sub}</div>}</div>{action}
  </header>;
}
export function Section({ title, children, className = '' }: { title?: ReactNode; children: ReactNode; className?: string }) {
  return <section className={'sec ' + className}>{title && <div className="secH">{title}</div>}{children}</section>;
}
export function Row({ icon, title, sub, right, label, to, onClick, disabled, list }: {
  icon: IconName; title: string; sub?: ReactNode; right?: ReactNode; label?: string; to?: string; onClick?: () => void; disabled?: boolean; list?: boolean;
}) {
  const className = (list ? 'list-row' : 'row') + (to || onClick ? ' tap' : '');
  const inside = <><span className="ic"><Icon name={icon} size={19} /></span><span className="t">{title}{sub && <small>{sub}</small>}</span>
    <span className="v">{right}{(to || (onClick && !disabled)) && <Icon name="chevron" size={14} />}</span></>;
  if (to && !disabled) return <Link className={className} to={to} aria-label={label}>{inside}</Link>;
  if (onClick || disabled) return <button type="button" className={className} aria-label={label} disabled={disabled} onClick={onClick}>{inside}</button>;
  return <div className={className}>{inside}</div>;
}
export function Hint({ children, kind = '', icon = 'info' }: { children: ReactNode; kind?: 'warn' | 'err' | ''; icon?: IconName }) {
  return <div className={'hint ' + kind}><Icon name={icon} size={15} /><div>{children}</div></div>;
}
export function Switch({ checked, action, label, disabled }: { checked: boolean; action: () => void; label: string; disabled?: boolean }) {
  return <button type="button" className={'switch' + (checked ? ' on' : '')} role="switch" aria-checked={checked} aria-label={label} onClick={action} disabled={disabled} />;
}
export function Seg<T extends string | number>({ options, current, choose, label, disabled }: {
  options: readonly (readonly [T, ReactNode])[]; current: T; choose: (key: T) => void; label: string; disabled?: boolean;
}) {
  return <div className="seg" role="group" aria-label={label}>{options.map(([key, caption]) =>
    <button type="button" key={key} disabled={disabled} className={key === current ? 'on' : ''} aria-pressed={key === current} onClick={() => choose(key)}>{caption}</button>
  )}</div>;
}

export function Sheet({ title, sub, children, close, showClose, className = '', decorated = true, dismissOnBackdrop = true, state }: {
  title: string; sub?: string; children: ReactNode; close?: () => void; showClose?: boolean; className?: string;
  decorated?: boolean; dismissOnBackdrop?: boolean; state?: string;
}) {
  const id = useId();
  const dialog = useRef<HTMLDialogElement>(null);
  useLayoutEffect(() => {
    const node = dialog.current!;
    dialogPolyfill.registerDialog(node);
    node.showModal();
    return () => { if (node.open) node.close(); };
  }, []);
  const sheet = <dialog className={'app-dialog scrim' + (className.includes('cmd-sheet') ? ' cmd-scrim' : '')}
    ref={dialog} aria-labelledby={id} onCancel={e => { e.preventDefault(); close?.(); }} onClick={e => { if (dismissOnBackdrop && e.target === e.currentTarget) close?.(); }}>
    <section className={'sheet ' + className} data-step={state}>
      {decorated && <div className="grabber" />}
      {showClose && close ? <header className="sheet-heading"><div>
        <h2 id={id}>{title}</h2>{sub && <div className="sub">{sub}</div>}
      </div><button type="button" className="iconbtn" aria-label="关闭" onClick={close}><Icon name="x" size={20} /></button></header> : <>
        <h2 id={id} className={decorated ? '' : 'sr-only'}>{title}</h2>{sub && <div className="sub">{sub}</div>}
      </>}{children}
    </section>
  </dialog>;
  // A polyfilled modal needs to sit outside the screen's scrolling and stacking contexts.
  return typeof HTMLDialogElement === 'undefined' || typeof HTMLDialogElement.prototype.showModal !== 'function'
    ? createPortal(sheet, document.body) : sheet;
}
export function SheetButtons({ cancel, action, label, cancelLabel = '取消', disabled, danger }: {
  cancel: () => void; action: () => void; label: string; cancelLabel?: string; disabled?: boolean; danger?: boolean;
}) {
  return <div className="confirm-btns"><button className="btn ghost" onClick={cancel}>{cancelLabel}</button><button className={'btn ' + (danger ? 'danger' : 'accent')} onClick={action} disabled={disabled}>{label}</button></div>;
}
