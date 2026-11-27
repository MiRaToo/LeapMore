import { Fragment, useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { useModelContext } from '../context';
import { useSetting } from '../../data/preferences';
import { haEnergy } from '../../data/ha/ledger';
import type { EnergyDay } from '../../data/types';
import { localDay, numberOf } from '../../data/ha/measurements';
import { periodStart } from '../../data/recordPeriod';
import { AppBar, Hint, Seg, Sheet, value } from '../../ui/components';
import { Icon, type IconName } from '../../ui/Icon';
import { ExpenseCard } from './Expenses';
import { useDailyPlot } from './useDailyPlot';
import { useCardReorder } from './useCardReorder';
import { useChartReveal } from './useChartReveal';

const metrics = [
  { key: 'km', label: '里程', unit: 'km', color: 'var(--accent)' },
  { key: 'kwh', label: '耗电', unit: 'kWh', color: 'var(--success)' },
  { key: 'efficiency', label: '百公里能耗', unit: 'kWh/100km', color: 'var(--warning)' },
] as const;

function Trend({ active, days, setDays, rows, loading }: { active: boolean; days: number; setDays: (days: number) => void; rows: EnergyDay[]; loading: boolean }) {
  const [series, setSeries] = useState(0);
  const [display, setDisplay] = useState<'bar' | 'line'>('bar');
  const metric = metrics[series];
  const values = rows.map(row => row[metric.key]);
  const numbers = values.filter((v): v is number => v !== null);
  const reveal = useChartReveal(active, numbers.length > 0);
  const sum = (key: 'km' | 'kwh') => rows.reduce((total, r) => total + (r[key] ?? 0), 0);
  const totals = rows.filter(r => r.km !== null && r.kwh !== null);
  const knownKm = totals.reduce((s, r) => s + r.km!, 0);
  const totalMetric = !numbers.length ? null : metric.key === 'efficiency' ? knownKm ? 100 * totals.reduce((s, r) => s + r.kwh!, 0) / knownKm : null : sum(metric.key);
  const tick = Math.max(1, Math.ceil(Math.max(0, ...numbers) / 3));
  const left = 29, right = 340, top = 12, bottom = 154;
  const { bindings, guide, index, spacing, x } = useDailyPlot(rows, 350, left, right, active);
  const y = (v: number) => bottom - v * (bottom - top) / (tick * 3);
  const reading = rows[index] ? rows[index].day.slice(5).replace('-', '月') + '日 · ' + value(values[index], 1) + ' ' + metric.unit : '暂无采样';
  let line = '';
  values.forEach((v, i) => {
    if (v !== null) line += (i > 0 && values[i - 1] !== null ? 'L' : 'M') + x(i) + ' ' + y(v) + ' ';
  });
  return <div className="card chart-card trend-card">
    <div className="chart-head"><h3>里程与能耗</h3><div className="trend-controls">
      <Seg options={[[7, '周'], [30, '月']]} current={days} choose={setDays} label="时间范围" />
      <Seg options={[[ 'bar', '柱状'], ['line', '折线']]} current={display} choose={setDisplay} label="图表类型" />
    </div></div>
    <div className="series-chips" role="group" aria-label="趋势指标">{metrics.map((m, i) => <button className="schip" aria-pressed={series === i} key={m.key} onClick={() => setSeries(i)}><i style={{ background: m.color }} />{m.label}</button>)}
      <span className="energy-axis-unit trend-unit">{metric.unit}</span></div>
    <div {...bindings} className={'energy-plot' + (guide ? ' show-guide' : '')} role="group" tabIndex={0}
      aria-label={metric.label + '趋势，左右拖动或按方向键查看日期'}>
      <svg className="chart-svg" viewBox="0 0 350 184" role="img" aria-label={metric.label + ' · ' + metric.unit}>
        {[0, 1, 2, 3].map(i => <Fragment key={i}><line x1={left} x2={right} y1={y(tick * i)} y2={y(tick * i)} stroke="var(--line-strong)" />
          <text x={22} y={y(tick * i) + 4} textAnchor="end" fontSize={13} fill="var(--text2)">{tick * i}</text></Fragment>)}
        {numbers.length > 0 && <g className="plot-series" {...reveal}>
        {display === 'line' && <path d={line} fill="none" strokeWidth={2.5} stroke={metric.color} strokeLinejoin="round" />}
        {values.map((v, i) => v === null ? null : display === 'bar' ?
          <rect key={i} x={x(i) - spacing * .29} y={y(v)} width={Math.min(24, spacing * .58)} height={Math.max(1, bottom - y(v))} rx="3" fill={metric.color} opacity=".85" /> :
          <circle key={i} cx={x(i)} cy={y(v)} r={2.4} fill={metric.color} />)}
        </g>}
        {index >= 0 && <line className="energy-guide" y1={top} y2={bottom} x1={x(index)} x2={x(index)} />}
        {rows.map((r, i) => (rows.length <= 10 || i % 6 === 0 || i === rows.length - 1) &&
          <text key={r.day} x={Math.min(329, x(i))} y="176" textAnchor="middle" fontSize="13" fill="var(--text2)">{r.day.slice(-5)}</text>)}
      </svg>
    </div>
    <div className="energy-trend-footer"><b className="num" role="status" id="energy-day-reading">{reading}</b><span className="energy-unit">
      {metric.key === 'efficiency' ? '平均 ' : '合计 '}{value(totalMetric, 1)} {metric.unit}</span></div>
    {loading && !numbers.length ? <p className="tiny muted" role="status">正在读取统计数据…</p> :
      numbers.length !== rows.length && <p className="tiny muted">空白日期缺少{metric.label}采样，合计仅含已读取的数据。</p>}
  </div>;
}

const labels = { weekKm: '本周行驶', efficiency: '平均能耗', rank: '近 6 周能耗排名', totalDays: '累计天数',
  totalKm: '累计里程', totalKwh: '累计能耗', monthKm: '本月行驶', trend: '里程与能耗', breakdown: '上周能耗构成', cost: '充电费用估算' };
type Card = keyof typeof labels;
const initialCards: Card[] = ['monthKm', 'weekKm', 'efficiency', 'rank', 'trend', 'totalDays', 'totalKm', 'totalKwh', 'breakdown', 'cost'];
type SavedCards = string[] | { version?: number; cards: string[] };
function restoreCards(saved?: SavedCards): Card[] {
  if (!saved) return initialCards;
  // 早期数组布局始终在末尾展示费用卡；新布局只显示用户保留的卡片。
  const list = Array.isArray(saved) ? [...saved, 'cost'] : saved.cards;
  const migrated = list.flatMap(key => key === 'stats' ? ['weekKm', 'efficiency'] : [key])
    .filter((key): key is Card => Object.hasOwn(labels, key));
  if (Array.isArray(saved) || saved.version !== 2) {
    const last = Math.max(migrated.indexOf('weekKm'), migrated.indexOf('efficiency'), migrated.indexOf('rank'));
    migrated.splice(last + 1, 0, 'totalDays', 'totalKm', 'totalKwh', 'monthKm');
  }
  return [...new Set(migrated)];
}
function MetricCard({ icon, label, reading, unit, note }: { icon: IconName; label: string; reading: string; unit?: string; note?: string }) {
  return <div className="card stat energy-metric"><div className="k metric-label"><Icon name={icon} size={14} />{label}</div><strong className="v num">{reading}</strong>
    <div className="energy-unit">{unit}{note && <span>{note}</span>}</div></div>;
}
export function EnergyPage({ active }: { active: boolean }) {
  const m = useModelContext();
  const [search, setSearch] = useSearchParams();
  const jumpToExpense = search.get('section') === 'cost';
  const [days, setDays] = useState(7);
  const [byVehicle, updateCards] = useSetting<Record<string, SavedCards>>('energyCards', {});
  const cards = restoreCards(byVehicle[m.vehicleId]);
  const hasCost = cards.includes('cost');
  const setCards = (next: Card[]) => updateCards(current => ({ ...current, [m.vehicleId]: { version: 2, cards: next } }));
  function closeCostLink() {
    const next = new URLSearchParams(search);
    next.delete('section');
    setSearch(next, { replace: true });
  }
  const [editing, setEditing] = useState(false);
  const [adding, setAdding] = useState(false);
  const mileage = m.canSee('mileage');
  useEffect(() => {
    if (!active) { setAdding(false); return; }
    if (jumpToExpense && mileage && hasCost) document.getElementById('expense-statistics')?.scrollIntoView({ block: 'start' });
  }, [active, jumpToExpense, mileage, hasCost]);
  const useCloud = mileage && !!m.client;
  const cloud = useQuery({ queryKey: ['cloud', 'energy', m.cloudKey, days], queryFn: ({ signal }) => m.client!.getEnergy(m.vehicleId, days, signal),
    enabled: active && useCloud, retry: false, staleTime: 5 * 60_000 });
  const history = useQuery({ queryKey: ['ha', 'energy', m.ha.config?.url, m.ha.vin, 31],
    queryFn: ({ signal }) => haEnergy(m.ha.config!, m.ha.vin, 31, signal),
    enabled: active && mileage && m.usesHA && m.ha.connected && !!m.ha.vin,
    retry: false, staleTime: 120_000, refetchInterval: query => query.state.data?.pending ? 60_000 : false });
  const facts = useQuery({
    queryKey: ['cloud', 'energy-facts', m.cloudKey, m.current.powertrain],
    enabled: active && useCloud,
    queryFn: () => m.client!.getEnergyFacts(m.vehicleId, m.current.powertrain === 'reev'), retry: false, staleTime: 300_000,
  });
  const rank = useQuery({
    queryKey: ['cloud', 'energy-rank', m.cloudKey], queryFn: () => m.client!.getEnergyRank(m.vehicleId),
    enabled: active && useCloud, retry: false, staleTime: 300_000,
  });
  const percentile = m.simulated ? '1%' : rank.data?.rank;
  const monthStart = localDay(periodStart('month'));
  const summary = useQuery({ queryKey: ['cloud', 'mileage-summary', m.cloudKey, monthStart],
    queryFn: ({ signal }) => m.client!.getMileageSummary(m.vehicleId, signal), enabled: active && useCloud, retry: false, staleTime: 300_000 });
  const fallback = m.energyPlaceholder(31);
  const tripTotals = useMemo(() => {
    const byDay = new Map<string, { km: number | null; kwh: number | null }>();
    let energy: number | null = null;
    for (const trip of m.records.trips) {
      const day = localDay(trip.startedAt), total = byDay.get(day) ?? { km: null, kwh: null };
      if (trip.distanceKm !== null) total.km = (total.km ?? 0) + trip.distanceKm;
      if (trip.energyKwh !== null) {
        total.kwh = (total.kwh ?? 0) + trip.energyKwh;
        energy = (energy ?? 0) + trip.energyKwh;
      }
      byDay.set(day, total);
    }
    return { byDay, energy };
  }, [m.records.trips]);
  const haDays = new Map(mileage && m.ha.vin ? history.data?.daily.map(row => [row.day, row]) : []);
  const officialMonth = new Map(summary.data?.daily.map(row => [row.day, row.km]));
  const cloudDays = new Map(useCloud ? cloud.data?.map(row => [row.day, row]) : []);
  // 以完整月份填充仪表卡。切换趋势图的周/月只改变图表窗口。
  const baseDays = fallback.map(row => {
    const ha = haDays.get(row.day), trip = tripTotals.byDay.get(row.day);
    const km = officialMonth.get(row.day) ?? ha?.km ?? row.km ?? trip?.km ?? null;
    const kwh = ha?.kwh ?? row.kwh ?? trip?.kwh ?? null;
    return { ...row, km, kwh };
  });
  const rows = baseDays.map(row => {
    const cloudRow = cloudDays.get(row.day);
    const km = cloudRow?.km ?? row.km, kwh = cloudRow?.kwh ?? row.kwh;
    return { ...row, km, kwh, efficiency: km !== null && km > 0 && kwh !== null ? 100 * kwh / km : null };
  });
  const weekStart = localDay(periodStart('week'));
  const weekly = rows.filter(row => row.day >= weekStart), weeklyKm = weekly.filter(r => r.km !== null), paired = weekly.filter(r => r.km !== null && r.kwh !== null);
  const sumKm = (data: EnergyDay[]) => data.reduce((s, r) => s + r.km!, 0);
  const eff = sumKm(paired) ? paired.reduce((s, r) => s + r.kwh!, 0) * 100 / sumKm(paired) : null;
  const monthRows = baseDays.filter(r => r.day >= monthStart && r.km !== null);
  const monthMax = monthRows.reduce((highest, row) => Math.max(highest, row.km!), 1);
  const monthKm = summary.data?.monthKm ?? (monthRows.length ? monthRows.reduce((sum, row) => sum + row.km!, 0) : null);
  const haReading = m.usesHA && mileage ? m.ha.currentReading : undefined;
  const lifetimeKwh = m.simulated ? 1741.6 : summary.data?.totalEnergy ?? numberOf(haReading?.used);
  const lifetimeDays = m.simulated ? 436 : summary.data?.deliveryDays ?? numberOf(haReading?.deliveryDays);
  const lifetimeKm = summary.data?.totalKm ?? m.current.odometer ?? numberOf(haReading?.odometer);
  const recordedKwh = tripTotals.energy;
  const fuel = m.current.powertrain === 'reev';
  const labelFor = (key: Card) => key === 'efficiency' && fuel ? '平均油耗' : labels[key];
  function move(from: Card, to: Card) {
    if (from === to) return;
    const next = cards.filter(key => key !== from);
    next.splice(cards.indexOf(to), 0, from);
    setCards(next);
  }
  const page = useCardReorder(active && editing, move);
  const breakdown = m.mode === 'ha' ? history.data?.breakdown : facts.data?.breakdown;
  const parts = [
    ['驱动', m.simulated ? 86.9 : breakdown?.drive ?? null, 'var(--accent)'],
    ['空调', m.simulated ? 8.6 : breakdown?.climate ?? null, 'var(--success)'],
    ['其它', m.simulated ? 6.2 : breakdown?.other ?? null, 'var(--warning)'],
  ] as const;
  const total = parts.every(([, n]) => n !== null) ? parts.reduce((sum, [, n]) => sum + (n ?? 0), 0) : null;
  const revealBreakdown = useChartReveal(active && mileage && cards.includes('breakdown'), total !== null && total > 0);
  function content(key: Card) {
    if (key === 'cost') return <ExpenseCard active={active} />;
    if (key === 'trend') return <Trend active={active} days={days} setDays={setDays} rows={rows.slice(-days)} loading={cloud.isFetching || history.isFetching} />;
    if (key === 'weekKm') return <MetricCard icon="route" label={labels[key]} reading={value(weeklyKm.length ? sumKm(weeklyKm) : null, 1)} unit="km" />;
    if (key === 'efficiency') return <MetricCard icon={fuel ? 'fuel' : 'bolt'} label={labelFor(key)} reading={value(fuel ? m.simulated ? 6.8 : facts.data?.fuel : eff, 1)} unit={fuel ? 'L/100km' : 'kWh/100km'} />;
    if (key === 'rank') return <MetricCard icon="trophy" label="近 6 周排名" reading={percentile ? '超过 ' + percentile : '—'}
      note={m.simulated || rank.data?.efficiency != null ? (m.simulated ? '14.6' : value(rank.data?.efficiency, 1)) + ' kWh/100km' :
        rank.isFetching ? '正在读取排名…' : m.mode === 'ha' ? '请登录零跑账号查看排名。' : '暂无排名数据'} />;
    if (key === 'totalDays') return <MetricCard icon="calendar" label={labels[key]} reading={value(lifetimeDays)} unit="天" />;
    if (key === 'totalKm') return <MetricCard icon="gauge" label={labels[key]} reading={value(lifetimeKm)} unit="km" />;
    if (key === 'totalKwh') return <MetricCard icon="battery" label={labels[key]} reading={value(lifetimeKwh ?? recordedKwh, 1)} unit="kWh"
      note={lifetimeKwh == null && recordedKwh !== null ? '已记录行程' : undefined} />;
    if (key === 'monthKm') return <div className="card month-driving"><div><span className="k">{labels[key]}</span>
      <strong className="num">{value(monthKm, 1)} <small className="energy-unit">km</small></strong>
      {monthKm !== null && summary.data?.monthKm == null && monthRows.length < new Date().getDate() && <small className="muted">已读取 {monthRows.length} 天</small>}</div>
      {monthRows.length > 0 && <svg viewBox="0 0 124 38" role="img" aria-label="本月逐日里程">
        {monthRows.map(row => <rect key={row.day} x={(Number(row.day.slice(-2)) - 1) * 4} y={36 - 34 * row.km! / monthMax} width="3" height={Math.max(1, 34 * row.km! / monthMax)} rx="1" fill="currentColor" />)}
      </svg>}</div>;
    return <div className="card chart-card"><div className="chart-head"><h3>{labels.breakdown}</h3><b className="num">{value(total, 1)} kWh</b></div>
        {total !== null && total > 0 && <div className="stackbar" {...revealBreakdown}>{parts.map(([name, n, color]) => <i key={name} style={{ width: (n ?? 0) / total * 100 + '%', background: color }} />)}</div>}
        <div className="energy-readings">{parts.map(([name, n, color]) => <div key={name}><span className="energy-reading-label"><i style={{ background: color }} />{name}</span><b className="energy-reading-value">{value(n, 1)} kWh</b></div>)}</div></div>;
  }
  return <div className="energy-screen" hidden={!active}><AppBar title="统计" back="/home" action={mileage ? <button className="appbar-action icon-action" aria-label={editing ? '完成' : '编辑'}
    title={editing ? '完成' : '编辑'} onClick={() => { if (jumpToExpense) closeCostLink(); setEditing(!editing); }}><Icon name={editing ? 'check' : 'edit'} size={18} /></button> : undefined} />
    <div className="page energy-page" ref={page}>{!mileage ? <MileageNotice /> : <>
      {editing && <p className="tiny muted">长按卡片后拖动排序，点右上角移除。</p>}
      <div className="energy-grid">{cards.map((key, i) => <article key={key} data-energy-card={key}
        className={'energy-card' + (['weekKm','efficiency','rank','totalDays','totalKm','totalKwh'].includes(key) ? ' compact-metric' : '') + (editing ? ' editing' : '')}>
        {editing && <><button className="card-del" aria-label={'删除' + labelFor(key)} onClick={() => setCards(cards.filter(item => item !== key))}>×</button>
          <button className="sr-only" disabled={i === 0} onClick={() => move(key, cards[i - 1])}>向上移动{labelFor(key)}</button>
          <button className="sr-only" disabled={i === cards.length - 1} onClick={() => move(key, cards[i + 1])}>向下移动{labelFor(key)}</button></>}
        {content(key)}
      </article>)}</div>
      {editing && <button className="btn ghost" onClick={() => setAdding(true)}>+ 添加卡片</button>}
      {active && jumpToExpense && !hasCost && <Sheet title="充电费用明细" close={closeCostLink} showClose><ExpenseCard active /></Sheet>}
    </>}
    {active && adding && <Sheet title="添加统计卡片" close={() => setAdding(false)}>
      {(Object.keys(labels) as Card[]).map(key => <button key={key} className="btn ghost" disabled={cards.includes(key)} onClick={() => { setCards([...cards, key]); setAdding(false); }}>{labelFor(key)}</button>)}
    </Sheet>}
    </div></div>;
}
export function MileageNotice() {
  return <div className="card grant-card"><div className="confirm-ic"><Icon name="chart" /></div><b>里程能耗未授权</b><Link className="link" to="/vehicle-access">查看车辆授权</Link></div>;
}
