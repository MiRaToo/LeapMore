import { useId, useMemo } from 'react';
import { usePlotScrub } from './usePlotScrub';
import { kmBetween } from '../../data/ha/measurements';
import type { Charge, MetricSample, TrackSample, Trip } from '../../data/ha/measurements';
import { clock, value } from '../../ui/components';
import { tripSampleGap } from '../../data/tripSampleMetrics';

const timeWithSeconds = new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
const plot = { width: 340, left: 36, right: 331, top: 7, bottom: 61 };
const divisions = 4;

function axisStep(peak: number) {
  const interval = peak / divisions;
  const base = 10 ** Math.floor(Math.log10(interval));
  return base * ([1, 2, 2.5, 5, 10].find(step => step * base >= interval) ?? 10);
}

export function tripTimeline(trip: Trip | undefined, readings?: TrackSample[]) {
  if (!trip) return [];
  const byTime = new Map<number, TrackSample>();
  if (!readings?.length) {
    trip.route.forEach(position => byTime.set(position.at, { at: position.at, value: null, position }));
    trip.speeds.forEach(({ at, value }) => byTime.set(at, { ...byTime.get(at), at, value }));
  }
  const addSoc = (at: number, soc: number | null) => byTime.set(at, { value: null, ...byTime.get(at), at, soc });
  if (trip.socStart != null) addSoc(trip.startedAt, trip.socStart);
  if (trip.endedAt !== null && trip.socEnd != null) addSoc(trip.endedAt, trip.socEnd);
  trip.socSamples?.forEach(({ at, value }) => addSoc(at, value));
  readings?.forEach(sample => {
    const local = byTime.get(sample.at);
    byTime.set(sample.at, { ...sample, value: sample.value ?? local?.value ?? null,
      position: sample.position ?? local?.position, soc: sample.soc ?? local?.soc });
  });
  let previous: TrackSample['position'];
  let distanceKm = 0;
  return [...byTime.values()].sort((a, b) => a.at - b.at).map(sample => {
    const point = sample.position;
    if (!point || point.coordinate === 'unknown') { previous = undefined; return sample; }
    if (!point.gapBefore && previous && previous.coordinate === point.coordinate && point.at - previous.at <= tripSampleGap) {
      const step = kmBetween(previous, point);
      if (step <= 2) distanceKm += step;
    }
    previous = point;
    return { ...sample, distanceKm };
  });
}

export function chargeTimeline(charge: Charge | undefined): MetricSample[] {
  if (!charge) return [];
  const timed = charge.powerTimeline?.length ? charge.powerTimeline : charge.powers;
  const byTime = new Map<number, MetricSample>(timed.map(sample => [sample.at, sample]));
  function addSoc(at: number, soc: number | null | undefined) {
    if (soc === undefined) return;
    const sample = byTime.get(at);
    if (sample?.soc != null) return;
    byTime.set(at, { at, value: null, ...sample, soc });
  }
  for (const sample of charge.socSamples ?? []) addSoc(sample.at, sample.value);
  if (charge.socStart != null) addSoc(charge.startedAt, charge.socStart);
  if (charge.socEnd != null && charge.endedAt != null) addSoc(charge.endedAt, charge.socEnd);
  return [...byTime.values()].sort((a, b) => a.at - b.at);
}

function closest(samples: { at: number }[], at: number) {
  let low = 0, high = samples.length - 1;
  while (low < high) {
    const mid = Math.floor((low + high) / 2);
    if (samples[mid].at < at) low = mid + 1;
    else high = mid;
  }
  return low > 0 && at - samples[low - 1].at <= samples[low].at - at ? low - 1 : low;
}

// A separate segment for each gap keeps single readings visible without joining missing observations.
function seriesPath(samples: MetricSample[], field: 'value' | 'soc', x: (at: number) => number,
  y: (v: number) => number, maxGap: number, baseline?: number) {
  let line = '', area = '', segment = '', firstX = '', lastX = '', previous: number | undefined;
  function close() {
    if (!segment) return;
    line += segment;
    if (baseline !== undefined) area += segment + 'L' + lastX + ' ' + baseline + 'H' + firstX + 'Z';
    segment = '';
  }
  for (const sample of samples) {
    const v = sample[field];
    if (v === undefined) continue;
    if (v === null) { close(); previous = undefined; continue; }
    if (previous !== undefined && sample.at - previous > maxGap) close();
    lastX = x(sample.at).toFixed(2);
    const point = lastX + ' ' + y(v).toFixed(2);
    if (!segment) { firstX = lastX; segment = 'M' + point + 'l.01 0'; }
    else segment += 'L' + point;
    previous = sample.at;
  }
  close();
  return { line, area };
}

const emptySeries: MetricSample[] = [];

type SampleDetail = { label: string; value: string };
type Lane = {
  key: 'primary' | 'soc' | 'temp'; label: string; unit: string; color: string;
  points: MetricSample[]; field: 'value' | 'soc'; low: number; high: number; available: boolean;
};

function SampleLane({ lane, x, at, reading, maxGap }: {
  lane: Lane; x: (at: number) => number; at?: number; reading?: number | null; maxGap: number;
}) {
  const id = useId().replace(/:/g, '');
  const { key, label, unit, color, points, field, low, high, available } = lane;
  const y = useMemo(() => (v: number) => plot.bottom - (v - low) / (high - low) * (plot.bottom - plot.top), [low, high]);
  const path = useMemo(() => seriesPath(points, field, x, y, maxGap, plot.bottom), [points, field, x, y, maxGap]);
  return <div className="sample-lane" data-series={key}>
    <div className="sample-lane-label"><i style={{ background: color }} /><span>{label}</span><small>{unit}</small>
      {!available && <small className="sample-unavailable">暂无采样</small>}</div>
    {available && <svg className="chart-svg" viewBox="0 0 340 68" aria-hidden="true">
      <defs><linearGradient id={id} x1="0" y1="0" x2="0" y2="1">
        <stop stopColor={color} stopOpacity=".15" /><stop offset="1" stopColor={color} stopOpacity=".02" />
      </linearGradient></defs>
      {[low, (low + high) / 2, high].map(tick => <g key={tick}>
        <path className="sample-grid" d={`M${plot.left} ${y(tick)}H${plot.right}`} />
        <text className={'sample-axis-' + key} x={plot.left - 8} y={y(tick) + 3} textAnchor="end">{Number(tick.toFixed(2))}</text>
      </g>)}
      <g className="sample-curves"><path d={path.area} fill={'url(#' + id + ')'} />
        <path className={'sample-line sample-' + key + '-path'} d={path.line} stroke={color} />
      </g>
      {at !== undefined && <g><line x1={x(at)} x2={x(at)} y1={plot.top} y2={plot.bottom} className="sample-cursor" />
        {reading != null && <circle className="sample-point" cx={x(at)} cy={y(reading)} r="3.6" fill={color} />}</g>}
    </svg>}
  </div>;
}

export function Timeline({ title, unit, samples, primarySamples = samples, temperatures, selectedAt, onSelect, details, maxGap = tripSampleGap }: {
  title: string; unit: 'km/h' | 'kW'; samples: MetricSample[]; primarySamples?: MetricSample[]; temperatures?: MetricSample[];
  selectedAt: number | null; onSelect: (at: number) => void; details?: SampleDetail[]; maxGap?: number;
}) {
  const temperature = temperatures ?? emptySeries;
  const timeline = useMemo(() => {
    const byTime = new Map<number, { at: number; sample?: MetricSample; temp?: number | null }>();
    for (const sample of samples) byTime.set(sample.at, { at: sample.at, sample });
    for (const sample of temperature) {
      if (sample.value != null) byTime.set(sample.at, { ...byTime.get(sample.at), at: sample.at, temp: sample.value });
    }
    return [...byTime.values()].sort((a, b) => a.at - b.at);
  }, [samples, temperature]);
  const start = timeline[0]?.at ?? 0, end = timeline.at(-1)?.at ?? start;
  const span = Math.max(1, end - start);
  const x = useMemo(() => (time: number) => plot.left + (end === start ? .5 : (time - start) / span) * (plot.right - plot.left), [start, end, span]);
  const lanes = useMemo<Lane[]>(() => {
    let peak = -Infinity, minSoc = Infinity, maxSoc = -Infinity, minTemp = Infinity, maxTemp = -Infinity;
    for (const sample of primarySamples) if (sample.value != null) peak = Math.max(peak, sample.value);
    for (const sample of samples) {
      if (sample.soc != null) { minSoc = Math.min(minSoc, sample.soc); maxSoc = Math.max(maxSoc, sample.soc); }
    }
    for (const { value: temp } of temperature) {
      if (temp != null) { minTemp = Math.min(minTemp, temp); maxTemp = Math.max(maxTemp, temp); }
    }
    const detailSoc = unit === 'km/h' && Number.isFinite(minSoc) && maxSoc - minSoc <= 15;
    const socBottom = detailSoc ? Math.min(80, Math.max(0, Math.ceil((maxSoc - 20) / 5) * 5,
      Math.floor((minSoc + maxSoc) / 10) * 5 - 10)) : 0;
    const tempStep = axisStep(Math.max(4, maxTemp - minTemp));
    const tempBottom = Number.isFinite(minTemp) ? Math.floor((minTemp - .25) / tempStep) * tempStep : 0;
    return [
      { key: 'primary', label: unit === 'kW' ? '充电功率' : '车速', unit, color: 'var(--accent)', points: primarySamples,
        field: 'value', low: 0, high: axisStep(Math.max(1, peak)) * divisions, available: Number.isFinite(peak) },
      { key: 'soc', label: '电量 SOC', unit: '%', color: 'var(--success)', points: samples,
        field: 'soc', low: socBottom, high: detailSoc ? socBottom + 20 : 100, available: Number.isFinite(minSoc) },
      { key: 'temp', label: '电池最低温', unit: '°C', color: 'var(--sample-temp)', points: temperature, field: 'value',
        low: tempBottom, high: Math.max(tempBottom + 2 * tempStep, Math.ceil((maxTemp + .25) / tempStep) * tempStep), available: Number.isFinite(minTemp) },
    ];
  }, [samples, primarySamples, temperature, unit]);
  const index = selectedAt === null ? -1 : timeline.findIndex(row => row.at === selectedAt);
  const current = timeline[index];
  const readings = { primary: current?.sample?.value, soc: current?.sample?.soc, temp: current?.temp };
  const readout: SampleDetail[] = current ? [
    { label: '采样时间', value: timeWithSeconds.format(current.at) },
    ...lanes.map(lane => {
      const reading = readings[lane.key];
      return { label: lane.label, value: reading == null ? '暂无' : lane.key === 'primary' ? value(reading, 1) + ' ' + unit :
        Number(reading.toFixed(1)) + (lane.key === 'soc' ? '%' : ' °C') };
    }),
    ...(details ?? []),
  ] : [];
  const scrub = usePlotScrub((el, clientX) => {
    const rect = el.getBoundingClientRect();
    if (!timeline.length || !rect.width) return;
    const px = (clientX - rect.left) / rect.width * plot.width;
    const fraction = Math.max(0, Math.min(1, (px - plot.left) / (plot.right - plot.left)));
    onSelect(timeline[closest(timeline, start + span * fraction)].at);
  });
  return <div className="card chart-card sample-card">
    <div className="chart-head"><h3>{title}</h3></div>
    {lanes.every(lane => !lane.available) ? <p className="tiny muted">当前来源缺少采样。</p> : <>
      <div className="sample-timeline" role="slider" tabIndex={0} aria-label={title + '时间轴'}
        aria-valuemin={1} aria-valuemax={timeline.length} aria-valuenow={Math.max(1, index + 1)}
        aria-valuetext={current ? readout.map(row => row.label + ' ' + row.value).join('，') : '尚未选择采样'} {...scrub}
        onKeyDown={event => {
          if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
          event.preventDefault();
          const next = event.key === 'Home' ? 0 : event.key === 'End' ? timeline.length - 1 :
            Math.min(timeline.length - 1, Math.max(0, index + (event.key === 'ArrowLeft' ? -1 : 1)));
          onSelect(timeline[next].at);
        }}>
        {lanes.map(lane => <SampleLane key={lane.key} lane={lane} x={x} at={current?.at} reading={readings[lane.key]} maxGap={maxGap} />)}
        <svg className="chart-svg sample-time-axis" viewBox="0 0 340 16" aria-hidden="true">
          <text x={plot.left} y="11">{clock(start)}</text>
          {end !== start && <text x={plot.right} y="11" textAnchor="end">{clock(end)}</text>}
        </svg>
      </div>
      <div className="sample-readout tiny" data-sample-at={current?.at}>{current
        ? <dl>{readout.map(row => <div key={row.label}><dt>{row.label}</dt><dd>{row.value}</dd></div>)}</dl> : '左右拖动查看采样'}</div>
    </>}
  </div>;
}
