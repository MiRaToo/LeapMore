import { useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import type { TrackSample, Trip } from '../../data/ha/measurements';
import { readSetting } from '../../data/localDatabase';
import { useSetting } from '../../data/preferences';
import { tripSampleMetrics } from '../../data/tripSampleMetrics';
import { value } from '../../ui/components';
import { Icon, type IconName } from '../../ui/Icon';

export type DetailMetric = { label: string; icon: IconName; reading: string; unit?: string };

export function DetailMetrics({ items }: { items: DetailMetric[] }) {
  return <dl className="trip-metrics">{items.map(({ label, icon, reading, unit }) =>
    <div className="tm" key={label}>
      <dt className="metric-label"><Icon name={icon} size={13} />{label}</dt>
      <dd><b className="num">{reading}</b>{unit && <> <small>{unit}</small></>}</dd>
    </div>)}</dl>;
}

export function MoreTripMetrics({ trip, samples, children }: { trip: Trip; samples: TrackSample[]; children: ReactNode }) {
  const [initialRows] = useState(() => readSetting('tripMoreMetricsExpanded', false) ? 2 : 0);
  const [rows, setRows] = useSetting('tripMoreMetricRows', initialRows);
  const id = useId();
  const content = useRef<HTMLDivElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const [heights, setHeights] = useState([0, 0, 0]);
  const [dragHeight, setDragHeight] = useState<number | null>(null);
  const drag = useRef<{ id: number; y: number; height: number }>();
  const moved = useRef(false);
  useLayoutEffect(() => {
    const elements = Array.from(content.current!.children);
    const measure = () => {
      const first = elements[0].getBoundingClientRect().height;
      const total = first + elements[1].getBoundingClientRect().height;
      setHeights(old => old[1] === first && old[2] === total ? old : [0, first, total]);
    };
    const observer = new ResizeObserver(measure);
    elements.forEach(element => observer.observe(element));
    measure();
    return () => observer.disconnect();
  }, []);
  const { highestSpeed, stoppedMs, rangeStart, rangeEnd, achievement } = useMemo(() => tripSampleMetrics(trip, samples), [trip, samples]);
  const groups: DetailMetric[][] = [
    [
      { label: '起始表显续航', icon: 'route', reading: value(rangeStart), unit: 'km' },
      { label: '结束表显续航', icon: 'route', reading: value(rangeEnd), unit: 'km' },
      { label: '续航达成率', icon: 'batterybar', reading: value(achievement, 1), unit: '%' },
    ],
    [
      { label: '最高速度', icon: 'gauge', reading: value(highestSpeed), unit: 'km/h' },
      { label: '0 速时长', icon: 'pause', reading: value(stoppedMs == null ? null : stoppedMs / 60_000, 1), unit: '分钟' },
    ],
  ];
  function endDrag() { drag.current = undefined; setDragHeight(null); }
  return <>
    <div className="trip-metrics-extra" id={id} data-rows={rows} data-dragging={dragHeight !== null || undefined}
      ref={panel} style={{ height: dragHeight ?? heights[rows] }}>
      <div ref={content}>{groups.map((items, index) =>
        <div className="trip-metrics-row" key={index} aria-hidden={index >= rows}><DetailMetrics items={items} /></div>)}</div>
    </div>
    {children}
    <button type="button" className="trip-metrics-handle" aria-controls={id} aria-expanded={rows > 0}
      aria-label={`详细数据，已展开 ${rows} 行，共 2 行。${rows === 2 ? '点击收起' : '点击展开下一行'}`}
      onPointerDown={event => {
        if (!event.isPrimary || event.button !== 0) return;
        moved.current = false;
        drag.current = { id: event.pointerId, y: event.clientY, height: panel.current!.getBoundingClientRect().height };
        event.currentTarget.setPointerCapture(event.pointerId);
      }}
      onPointerMove={event => {
        const start = drag.current;
        if (start?.id !== event.pointerId) return;
        const delta = event.clientY - start.y;
        if (Math.abs(delta) < 4 && !moved.current) return;
        moved.current = true;
        setDragHeight(Math.min(heights[2], Math.max(0, start.height + delta)));
      }}
      onPointerUp={event => {
        const start = drag.current;
        if (start?.id !== event.pointerId) return;
        const delta = event.clientY - start.y;
        if (Math.abs(delta) >= 8) {
          moved.current = true;
          const stop = start.height + delta;
          const nearest = heights.reduce((best, height, i) => Math.abs(height - stop) < Math.abs(heights[best] - stop) ? i : best, 0);
          setRows(nearest === rows && Math.abs(delta) > 18 ? Math.min(2, Math.max(0, rows + Math.sign(delta))) : nearest);
        }
        endDrag();
      }}
      onLostPointerCapture={endDrag} onPointerCancel={endDrag}
      onKeyDown={event => {
        if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
        event.preventDefault();
        setRows(Math.min(2, Math.max(0, rows + (event.key === 'ArrowDown' ? 1 : -1))));
      }}
      onClick={event => { if (!moved.current || event.detail === 0) setRows((rows + 1) % 3); }}>
      <span className="trip-metrics-grip" aria-hidden="true" />
    </button>
  </>;
}
