import { useRef } from 'react';
import type { MouseEvent, PointerEvent } from 'react';

export function useRecordSwipe(tab: number, select: (tab: number) => void) {
  const start = useRef<{ id: number; x: number; y: number } | null>(null);
  const suppress = useRef(false);
  return {
    onPointerDown(event: PointerEvent<HTMLDivElement>) {
      suppress.current = false;
      start.current = event.isPrimary && event.button === 0 && !(event.target as Element).closest('button:not(.record-fold-toggle),input,select,dialog,.amap-view,.sample-timeline') ?
        { id: event.pointerId, x: event.clientX, y: event.clientY } : null;
    },
    onPointerMove(event: PointerEvent<HTMLDivElement>) {
      const p = start.current;
      if (!p || event.pointerId !== p.id) return;
      const dy = Math.abs(event.clientY - p.y);
      if (dy > 12 && dy > Math.abs(event.clientX - p.x)) start.current = null;
    },
    onPointerCancel() { start.current = null; },
    onPointerUp(event: PointerEvent<HTMLDivElement>) {
      const p = start.current;
      start.current = null;
      if (!p || event.pointerId !== p.id || document.querySelector('dialog[open]')) return;
      const dx = event.clientX - p.x;
      if (Math.abs(dx) < 48 || Math.abs(dx) < Math.abs(event.clientY - p.y) * 1.5) return;
      suppress.current = true;
      const next = dx < 0 ? 1 : 0;
      if (tab !== next) select(next);
    },
    onClickCapture(event: MouseEvent<HTMLDivElement>) {
      if (suppress.current && event.detail) { event.preventDefault(); event.stopPropagation(); }
      suppress.current = false;
    },
  };
}
