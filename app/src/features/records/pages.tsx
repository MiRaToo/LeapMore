import { useEffect, useMemo, useRef, useState } from 'react';
import type { MouseEvent, ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link, Navigate, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { useModelContext } from '../context';
import { AppBar, Hint, Row, Section, Seg, Sheet, SheetButtons, clock, stamp, value } from '../../ui/components';
import { SlidingSelector } from '../../ui/SlidingSelector';
import { Icon } from '../../ui/Icon';
import { MileageNotice } from './Energy';
import { localDay } from '../../data/ha/measurements';
import { haTripTrack } from '../../data/ha/ledger';
import { defaultRecordSource, useSetting } from '../../data/preferences';
import type { Trip } from '../../data/ha/measurements';
import { chargeCostTotals, estimateChargeRecord } from '../../data/tariff';
import { costText, ExpenseTotals, useExpenseCharges } from './Expenses';
import { AmapView, useMapStyle } from '../vehicle/AmapView';
import type { MapStyle } from '../vehicle/AmapView';
import { mapPoint } from '../vehicle/Location';
import { useAmapAddress } from '../vehicle/amapServices';
import { Timeline, tripTimeline } from './Timeline';
import { TripThumbnail } from './TripThumbnail';
import { ExportRecords } from './ExportRecords';

const types = { ac: '交流 · 慢充', dc: '直流 · 快充', mixed: '多种类型', unknown: '类型未知' };
const socText = (soc: number | null | undefined) => soc == null ? '—' : value(soc, 1) + '%';
const tripViews = [['simple', '简洁'], ['thumbnail', '缩略图'], ['cards', '卡片']] as const;
type TripView = typeof tripViews[number][0];
const tripMapHeight = 210;
function Badge({ source }: { source: string }) {
  return <span className={'src-badge src-' + (source === 'ha' ? 'ha' : 'phone')}>{source === 'ha' ? 'HA' : source === 'live' ? '零跑云' : '手机'}</span>;
}
function currentMonth<T extends { startedAt: number }>(rows: T[], today: string) {
  const month = today.slice(0, 7);
  return rows.filter(row => localDay(row.startedAt).startsWith(month));
}

function tripMetric(trips: Trip[], field: 'distanceKm' | 'durationMin' | 'energyKwh') {
  const known = trips.flatMap(trip => trip[field] ?? []);
  return { total: known.length ? known.reduce((sum, n) => sum + n, 0) : null, count: known.length };
}

function tripTotal(metric: ReturnType<typeof tripMetric>, trips: number, unit: string, digits: number) {
  if (metric.total === null) return '—';
  return (metric.count < trips ? '已知 ' : '') + value(metric.total, digits) + ' ' + unit;
}

function MonthSummary({ label, primary, secondary }: { label: string; primary: ReactNode; secondary: ReactNode }) {
  return <section className="card trip-sum" aria-label={label}>
    <div className="between record-summary-top">{primary}</div>
    <div className="divider" />
    <div className="record-summary-bottom">{secondary}</div>
  </section>;
}

function TripMonth({ trips, limited }: { trips: Trip[]; limited: boolean }) {
  const distance = tripMetric(trips, 'distanceKm');
  const duration = tripMetric(trips, 'durationMin');
  const energy = tripMetric(trips, 'energyKwh');
  return <><MonthSummary label="本月行程统计" primary={<>
    <div><div className="tiny muted">本月行程</div>
      <b className="num record-total">{trips.length} 段 · {tripTotal(distance, trips.length, 'km', 1)}</b></div>
    <div><div className="tiny muted">有数据的平均单段</div><b className="num">{distance.total === null ? '—' : value(distance.total / distance.count, 1) + ' km'}</b></div>
  </>} secondary={<div className="between">
      <div><div className="tiny muted">累计耗时</div><b className="num">{tripTotal(duration, trips.length, '分钟', 0)}</b></div>
      <div><div className="tiny muted">行程耗电</div><b className="num">{tripTotal(energy, trips.length, 'kWh', 1)}</b></div>
  </div>} />{limited && <p className="tiny muted record-summary-note">仅含当前同步范围内的行程。</p>}</>;
}

function TripDayTotals({ trips }: { trips: Trip[] }) {
  return <div className="trip-day-totals num">
    <small><span className="sr-only">当天里程 </span>{tripTotal(tripMetric(trips, 'distanceKm'), trips.length, 'km', 1)}</small>
    <small><span className="sr-only">当天耗时 </span>{tripTotal(tripMetric(trips, 'durationMin'), trips.length, '分钟', 0)}</small>
  </div>;
}

function liveReading(reading: number | null | undefined, unit: string, digits = 1) {
  return reading == null ? '—' : `${value(reading, digits)} ${unit}`;
}

function RecordingCard({ title, metrics }: { title: string; metrics: [label: string, reading: string][] }) {
  return <section className="card recording" aria-label={title}>
    <div className="rec-left"><span className="rec-dot" aria-hidden="true" /><b>{title}</b></div>
    <dl className="recording-metrics">
      {metrics.map(([label, reading]) => <div key={label}>
        <dt className="tiny muted">{label}</dt><dd className="num">{reading}</dd>
      </div>)}
    </dl>
  </section>;
}

function TripListLink({ trip, view, mapStyle, onDelete }: { trip: Trip; view: TripView; mapStyle: MapStyle; onDelete?: () => void }) {
  const hold = useRef<{ id: number; x: number; y: number; timer: ReturnType<typeof setTimeout> } | null>(null);
  const held = useRef(false);
  function cancelHold() {
    if (hold.current) clearTimeout(hold.current.timer);
    hold.current = null;
  }
  useEffect(() => cancelHold, []);
  return <Link className={'trip-row' + (view === 'cards' ? ' trip-card' : view === 'thumbnail' ? ' trip-row-with-map' : '')}
    to={'/trips/' + encodeURIComponent(trip.id)} draggable={false} data-deletable={onDelete ? true : undefined}
    aria-keyshortcuts={onDelete ? 'Delete' : undefined} aria-description={onDelete ? '长按可删除行程' : undefined}
    onPointerDown={event => {
      if (!onDelete || !event.isPrimary || event.button !== 0) return;
      cancelHold();
      held.current = false;
      hold.current = { id: event.pointerId, x: event.clientX, y: event.clientY, timer: setTimeout(() => {
        cancelHold();
        held.current = true;
        onDelete();
      }, 550) };
    }}
    onPointerMove={event => {
      const pending = hold.current;
      if (pending?.id === event.pointerId && Math.hypot(event.clientX - pending.x, event.clientY - pending.y) > 10) cancelHold();
    }}
    onPointerUp={cancelHold} onPointerCancel={cancelHold} onPointerLeave={cancelHold}
    onContextMenu={event => {
      if (!onDelete) return;
      event.preventDefault();
      cancelHold();
      held.current = true;
      onDelete();
    }}
    onKeyDown={event => {
      if (event.key === 'Delete' && onDelete) { event.preventDefault(); onDelete(); }
    }}
    onClick={event => {
      if (held.current && event.detail !== 0) event.preventDefault();
      held.current = false;
    }}>
    {view !== 'simple' && <TripThumbnail trips={[trip]} mapStyle={mapStyle} />}
    <span className="trip-time">{clock(trip.startedAt)}<small>→ {clock(trip.endedAt)}</small></span>
    <span className="trip-main"><b className="num">{value(trip.distanceKm, 1)} km</b><small>{value(trip.durationMin)} 分钟{view !== 'cards' && ` · ${value(trip.efficiency, 1)} kWh/100km`}{!trip.complete && ' · 片段'}</small></span>
    <Badge source={trip.source} />{view !== 'cards' && <Icon name="chevron" size={15} />}
  </Link>;
}

export function RecordsPage() {
  const m = useModelContext();
  const [search, update] = useSearchParams();
  const [tripView, setTripView] = useSetting<TripView>('tripListView', 'simple');
  const { style: mapStyle } = useMapStyle();
  const [pendingDelete, setPendingDelete] = useState<{ scope: string; trip: Trip }>();
  const [deleteIssue, setDeleteIssue] = useState('');
  const [deleting, setDeleting] = useState(false);
  const tabs = ['trips', 'charges'];
  const tab = Math.max(0, tabs.indexOf(search.get('tab') ?? 'trips'));
  const phoneTrip = m.simulated ? m.current.driving && { speedKmh: 48, distanceKm: 12.4 } : m.cloudRecords.activeTrip;
  const phoneCharge = m.simulated ? m.current.charging === 'charging' && { soc: m.current.soc, kwh: 4.2, powerKw: m.current.power } : m.cloudRecords.activeCharge;
  const activeTrip = (m.usesPhone && phoneTrip) || (m.usesHA && m.ha.activeTrip);
  const activeCharge = (m.usesPhone && phoneCharge) || (m.usesHA && !phoneTrip && m.ha.activeCharge);
  const expense = useExpenseCharges(m, 30, tab === 1);
  const today = localDay(Date.now());
  const monthly = currentMonth(expense.charges, today);
  const tripMonthLimited = m.source === 'ha' && !!m.ha.config && Number(today.slice(-2)) > m.ha.config.days;
  const monthCost = chargeCostTotals(monthly, m.tariff);
  const measured = monthly.filter(row => row.kwh !== null);
  const kwh = measured.reduce((sum, row) => sum + row.kwh!, 0);
  const cloudRecords = m.mode === 'cloud' && m.usesPhone;
  const permitted = m.canSee('mileage');
  const showTripViews = tab === 0 && permitted;
  function cycleTripView() {
    const [next, label] = tripViews[(tripViews.findIndex(([key]) => key === tripView) + 1) % tripViews.length];
    setTripView(next);
    m.setToast(label);
  }
  const selectedTrip = showTripViews && pendingDelete?.scope === m.tripScope ? pendingDelete.trip : undefined;
  function requestDelete(trip: Trip) {
    setDeleteIssue('');
    setPendingDelete({ scope: m.tripScope, trip });
  }
  async function confirmDelete() {
    if (!selectedTrip || deleting) return;
    setDeleting(true);
    setDeleteIssue('');
    try {
      await m.deleteTrip(selectedTrip.id);
      setPendingDelete(undefined);
      m.setToast('已从本机删除行程');
    } catch (error) {
      setDeleteIssue(error instanceof Error ? error.message : '暂时无法删除行程，请重试。');
    } finally {
      setDeleting(false);
    }
  }
  if (search.get('tab') === 'cost') return <Navigate to="/energy?section=cost" replace />;
  return <><AppBar title={permitted ? <><span className="sr-only">记录</span>
    <SlidingSelector label="记录类型" options={['行程', '充电']} selected={tab} change={i => update({ tab: tabs[i] }, { replace: true })} /></> : '记录'}
    back="/home" className="records-appbar"
    action={<div className="records-actions">
      {showTripViews && <button type="button" className="appbar-action icon-action" aria-label="行程显示"
        title={tripViews.find(([key]) => key === tripView)?.[1]} onClick={cycleTripView}>
        <Icon name="layout" size={18} />
      </button>}
      <Link className="appbar-action icon-action" to="/records-source" aria-label="记录设置" title="记录设置"><Icon name="gear" size={18} /></Link>
    </div>} />
    {selectedTrip && <Sheet title="删除行程" dismissOnBackdrop={false} close={() => { if (!deleting) setPendingDelete(undefined); }}>
      <p>{stamp(selectedTrip.startedAt)} · {liveReading(selectedTrip.distanceKm, 'km')}</p>
      <p className="muted">仅从本机的行程列表和导出中移除。Home Assistant 上的行程和轨迹会保留。</p>
      {deleteIssue && <Hint kind="err">{deleteIssue}</Hint>}
      <SheetButtons cancel={() => { if (!deleting) setPendingDelete(undefined); }} action={() => void confirmDelete()}
        label={deleting ? '正在删除…' : '确认删除'} disabled={deleting} danger />
    </Sheet>}
    <div className="page">
    {!permitted ? <MileageNotice /> : <>
      {m.source === 'ha' && m.ha.error && <Hint kind="warn">{m.ha.error} <Link to="/ha" className="link">查看连接</Link></Hint>}
      {m.source === 'ha' && !m.ha.vin && <Hint>{m.ha.identifying ? '正在识别 HA 车辆…' : '需要连接 HA 并识别到车辆。'} <Link className="link" to="/ha">设置 HA</Link></Hint>}
      {cloudRecords && tab === 0 && m.cloudRecords.issue && <Hint>{m.cloudRecords.issue}</Hint>}
      <div className="record-panel" id="record-panel" role="tabpanel" aria-labelledby={'record-tab-' + tab} tabIndex={0}>
        {m.source === 'off' ? <div className="card empty"><b>还没有开启记录</b><Link className="btn accent" to="/records-source">选择数据来源</Link></div> :
          tab === 0 ? <>
            {activeTrip && <RecordingCard title="正在记录行程" metrics={[
              ['实时车速', liveReading(activeTrip.speedKmh, 'km/h', 0)],
              ['已行驶里程', liveReading(activeTrip.distanceKm, 'km')],
            ]} />}
            <TripMonth trips={currentMonth(m.records.trips, today)} limited={tripMonthLimited} />
            {!m.records.trips.length && <EmptyRecords kind="行程" />}
            <RecordDays rows={m.records.trips} unit="段" grid={tripView === 'cards'}
              preview={tripView === 'thumbnail' ? group => ({ map: <TripThumbnail trips={group} mapStyle={mapStyle} daily />,
                totals: <TripDayTotals trips={group} /> }) : undefined}
              render={trip => <TripListLink key={trip.id} trip={trip} view={tripView} mapStyle={mapStyle}
                onDelete={m.canDeleteTrip(trip.id) ? () => requestDelete(trip) : undefined} />} />
          </> : <>
            {activeCharge && <RecordingCard title="正在记录充电" metrics={[
              ['实时电量', socText(activeCharge.soc)],
              ['已充入电量', liveReading(activeCharge.kwh, 'kWh')],
              ['充电功率', liveReading(activeCharge.powerKw, 'kW')],
            ]} />}
            <MonthSummary label="本月充电统计" primary={<>
              <div><div className="tiny muted">本月充电</div><b className="num record-total">{monthly.length} 次 · {measured.length ? value(kwh, 1) : '—'} kWh</b></div>
              <div><div className="tiny muted">有数据的平均单次</div><b className="num">{measured.length ? value(kwh / measured.length, 1) : '—'} kWh</b></div>
            </>} secondary={<ExpenseTotals title="本月电费估算" totals={monthCost} />} />
            {expense.partial && <p className="tiny muted record-summary-note">部分充电记录暂不可用。</p>}
            {!m.records.charges.length && (m.source === 'ha' ? <EmptyRecords kind="充电" /> : <div className="card empty"><div className="confirm-ic"><Icon name="plug" /></div>
              <b>{m.cloudRecords.loading ? '正在读取充电记录…' : m.cloudRecords.error && cloudRecords ? '无法读取充电记录' : '暂无充电记录'}</b>
              {cloudRecords && m.cloudRecords.error && <button className="btn secondary sm" onClick={() => void m.cloudRecords.refreshCharges()}>重试</button>}</div>)}
            <RecordDays rows={m.records.charges} unit="次" render={row => {
              const estimate = estimateChargeRecord(row, m.tariff);
              return <Link key={row.id} className="trip-row" to={'/charges/' + encodeURIComponent(row.id)}>
              <span className="trip-time">{clock(row.startedAt)}<small>→ {row.active ? '充电中' : clock(row.endedAt)}</small></span>
              <span className="trip-main"><b className="num">{value(row.kwh, 1)} kWh</b><small>{types[row.type]}</small>
                <small className="charge-estimate">{estimate ? `约 ${costText(estimate.cost)} · ${estimate.averagePrice.toFixed(2)} 元/kWh` : '预估费用 —'}</small></span>
              <Badge source={row.source} /><Icon name="chevron" size={15} /></Link>;
            }} />
          </>}
      </div>
    </>}
  </div></>;
}

function RecordDay({ summary, children }: { summary: ReactNode; children: ReactNode }) {
  const details = useRef<HTMLDetailsElement>(null);
  const body = useRef<HTMLDivElement>(null);
  const motion = useRef<Animation | null>(null);
  function toggle(event: MouseEvent<HTMLElement>) {
    const el = details.current, content = body.current;
    if (!el || !content) return;
    event.preventDefault();
    const open = el.open && el.dataset.closing !== 'true';
    const from = el.open ? content.getBoundingClientRect().height : 0;
    motion.current?.cancel();
    delete el.dataset.closing;
    if (!event.detail || matchMedia('(prefers-reduced-motion: reduce)').matches || !content.animate) {
      el.open = !open;
      return;
    }
    el.open = true;
    if (open) el.dataset.closing = 'true';
    const to = open ? 0 : content.scrollHeight;
    const animation = content.animate([{ height: `${from}px`, opacity: open ? 1 : .55 },
      { height: `${to}px`, opacity: open ? .55 : 1 }], { duration: open ? 170 : 210, easing: 'cubic-bezier(.23,1,.32,1)' });
    motion.current = animation;
    animation.onfinish = () => {
      el.open = !open;
      delete el.dataset.closing;
      motion.current = null;
    };
  }
  return <details className="record-day" ref={details}>
    <summary className="trip-day" onClick={toggle}>{summary}</summary>
    <div className="record-day-items" ref={body}>{children}</div>
  </details>;
}

function RecordDays<T extends { startedAt: number }>({ rows, unit, render, grid = false, preview }: {
  rows: T[]; unit: string; render: (row: T) => ReactNode; grid?: boolean; preview?: (group: T[]) => { map: ReactNode; totals: ReactNode };
}) {
  const days = new Map<string, T[]>();
  for (const row of rows) {
    const day = localDay(row.startedAt);
    const group = days.get(day);
    if (group) group.push(row);
    else days.set(day, [row]);
  }
  const today = localDay(Date.now());
  return [...days].map(([day, group]) => {
    const visual = preview?.(group);
    return <RecordDay key={day} summary={<>{visual?.map}<div className="trip-day-heading">
        <b>{day === today ? '今天' : day}</b>{visual?.totals}</div><span>{group.length} {unit}</span><Icon name="chevron" size={14} />
      </>}>
      {grid ? <div className="trip-grid">{group.map(render)}</div> : group.map(render)}
    </RecordDay>;
  });
}

function EmptyRecords({ kind }: { kind: string }) {
  const m = useModelContext();
  const cloud = m.mode === 'cloud' && m.usesPhone;
  const ha = m.source === 'ha';
  const loading = ha && (m.ha.identifying || m.ha.recordSyncing);
  const unavailable = ha && (kind === '行程' ? m.ha.tripUnavailable : m.ha.chargeUnavailable);
  const title = loading ? `正在同步${kind}记录…` : unavailable ? `${kind}记录暂不可用` : `暂无${kind}记录`;
  return <div className="card empty"><div className="confirm-ic"><Icon name={kind === '行程' ? 'route' : 'plug'} /></div><b>{title}</b>
    {!loading && <p className="tiny muted">{ha ? unavailable ? '可在 HA 同步设置中重试并查看同步状态。' : '当前同步范围内没有可用记录。' :
      cloud ? '行程来自零跑云车况采样。可在记录设置中开启后台轮询。' : '手机记录需要登录零跑账号。'}</p>}
    <Link className="btn secondary sm" to={m.source === 'ha' ? '/ha' : cloud ? '/records-source' : '/background-guide'}>{m.source === 'ha' ? '同步设置' : cloud ? '记录设置' : '手机记录设置'}</Link></div>;
}

export function TariffSheet({ close }: { close: () => void }) {
  const m = useModelContext();
  const [draft, setDraft] = useState(m.baseTariff);
  const editEfficiency = m.source === 'ha';
  const [issue, setIssue] = useState('');
  const mins = (time: string) => { const [h, m] = time.split(':').map(Number); return h * 60 + m; };
  function save() {
    const prices = [draft.ac.peak, draft.ac.valley, ...draft.dc.periods.map(p => p.price)];
    if (prices.some(p => !Number.isFinite(p) || p < 0)) {
      setIssue('请填写有效价格。'); return;
    }
    if (editEfficiency && [draft.ac.efficiency, draft.dc.efficiency].some(v => !(v >= 50 && v <= 100))) {
      setIssue('充电效率须为 50%–100%。'); return;
    }
    const count = new Uint8Array(1440);
    for (const p of draft.dc.periods) {
      const start = mins(p.start), end = mins(p.end);
      if (!Number.isFinite(start) || !Number.isFinite(end) || start === end) { setIssue('请填写完整的直流分时。'); return; }
      for (let t = start; t !== end; t = (t + 1) % 1440) count[t]++;
    }
    if (count.some(v => v !== 1)) { setIssue('直流时段须覆盖全天且互不重叠。'); return; }
    m.setTariff(draft); close();
  }
  return <Sheet title="电价设置" sub="交流峰谷 · 直流分时" close={close} showClose className="tariff-sheet">
    <div className="tariff-section"><b>交流慢充</b><div className="tariff-grid">
      {([['peak', '峰电价 · 元/kWh'], ['valley', '谷电价 · 元/kWh'], ['efficiency', '交流效率 %']] as const)
        .filter(([key]) => key !== 'efficiency' || editEfficiency).map(([key, label]) => <label key={key}>{label}
        <input type="number" step="0.01" min={key === 'efficiency' ? 50 : 0} value={Number.isFinite(draft.ac[key]) ? draft.ac[key] : ''}
          onChange={e => setDraft({ ...draft, ac: { ...draft.ac, [key]: e.target.valueAsNumber } })} /></label>)}
      {([['valleyStart', '谷电开始'], ['valleyEnd', '谷电结束']] as const).map(([key, label]) => <label key={key}>{label}
        <input type="time" value={draft.ac[key]} onChange={e => setDraft({ ...draft, ac: { ...draft.ac, [key]: e.target.value } })} /></label>)}
    </div></div>
    <div className="tariff-section"><b>直流快充</b><p className="tiny muted">时段须覆盖全天且互不重叠。</p>
      {draft.dc.periods.map((row, i) => <div className="period-row" key={i}>
        {(['start', 'end', 'price'] as const).map(key => <input type={key === 'price' ? 'number' : 'time'} min="0" step={key === 'price' ? '0.01' : undefined} key={key}
          aria-label={'时段 ' + (i + 1) + ({ start: ' 开始', end: ' 结束', price: ' 单价' }[key])}
          value={key === 'price' && !Number.isFinite(row.price) ? '' : row[key]} onChange={e => {
            const periods = draft.dc.periods.map((p, ix) => ix === i ? { ...p, [key]: key === 'price' ? e.target.valueAsNumber : e.target.value } : p);
            setDraft({ ...draft, dc: { ...draft.dc, periods } });
          }} />)}
        <button className="del-period" aria-label="删除时段" onClick={() => setDraft({ ...draft, dc: { ...draft.dc, periods: draft.dc.periods.filter((_, ix) => ix !== i) } })}>×</button>
      </div>)}
      <button className="link" onClick={() => setDraft({ ...draft, dc: { ...draft.dc, periods: [...draft.dc.periods, { start: '00:00', end: '01:00', price: 0 }] } })}>+ 添加时段</button>
      {editEfficiency && <label className="tariff-row">直流效率 <input type="number" min="50" max="100" value={Number.isFinite(draft.dc.efficiency) ? draft.dc.efficiency : ''}
        onChange={e => setDraft({ ...draft, dc: { ...draft.dc, efficiency: e.target.valueAsNumber } })} />%</label>}
    </div>
    {issue && <p role="alert">{issue}</p>}
    <SheetButtons cancel={close} action={save} label="保存电价" />
  </Sheet>;
}

export function TripDetail() {
  const m = useModelContext();
  const { id } = useParams();
  const [selection, setSelection] = useState<{ id?: string; at: number } | null>(null);
  const trip = m.findTrip(id);
  const permitted = m.canSee('mileage');
  const showRoute = m.canSee('location');
  const haId = trip?.id.startsWith('ha-trip-') ? trip.id.slice(8) : '';
  const track = useQuery({ queryKey: ['ha', 'trip-track', m.ha.config?.url, m.ha.vin, haId],
    queryFn: ({ signal }) => haTripTrack(m.ha.config!, m.ha.vin, haId, signal),
    enabled: permitted && showRoute && !!haId && m.ha.connected && !!m.ha.vin, staleTime: 5 * 60_000 });
  const samples = useMemo(() => tripTimeline(trip, showRoute ? track.data : undefined), [trip, showRoute, track.data]);
  const route = useMemo(() => showRoute ? samples.flatMap((sample, i) => sample.position && sample.position.coordinate !== 'unknown'
    ? [{ ...mapPoint(sample.position), speed: sample.value, gapBefore: i > 0 && (!samples[i - 1].position || samples[i - 1].position?.coordinate === 'unknown') }]
    : []) : [], [showRoute, samples]);
  const selectedAt = selection?.id === id ? selection?.at ?? null : null;
  const selected = selectedAt === null ? undefined : samples.find(sample => sample.at === selectedAt);
  const selectedPosition = selected?.position;
  const locationText = showRoute && selected ? selectedPosition && selectedPosition.coordinate !== 'unknown' ?
    `距起点 ${value(selected.distanceKm, 2)} km · ${selectedPosition.lat.toFixed(5)}, ${selectedPosition.lon.toFixed(5)}` : '暂无定位' : undefined;
  const selectSample = (at: number | null) => setSelection(previous => {
    if (at === null) return null;
    return previous && previous.id === id && previous.at === at ? previous : { id, at };
  });
  const first = route[0], last = route.at(-1);
  const firstAddress = useAmapAddress(first, showRoute && !m.simulated).data;
  const lastAddress = useAmapAddress(last, showRoute && !m.simulated).data;
  const startDay = trip ? localDay(trip.startedAt) : undefined;
  const endDay = trip?.endedAt == null ? startDay : localDay(trip.endedAt);
  const dateRange = endDay && endDay !== startDay ? `${startDay} 至 ${endDay}` : startDay;
  const title = trip ? `${clock(trip.startedAt)} → ${clock(trip.endedAt)}` : '行程详情';
  return <><AppBar title={title} back="/records" sub={dateRange} action={trip && <Badge source={trip.source} />} />
    <div className="page no-nav record-detail">{!permitted ? <MileageNotice /> : !trip ? <Hint>行程不存在、正在载入或已从本机清理。</Hint> : <>
      {showRoute && (first ? <AmapView key={id} lat={first.lat} lon={first.lon} height={tripMapHeight} name="行程路线" route={route} selectedAt={selectedAt} onRouteSelect={selectSample} /> :
        track.isFetching || !!haId && m.ha.identifying ? <div className="amap-view trip-map-placeholder" style={{ height: tripMapHeight }} role="status">
          <Icon name="map" size={22} />正在读取 HA 轨迹…
        </div> : <Hint>缺少可用轨迹或坐标系未知。</Hint>)}
      {!showRoute && <Hint icon="shield">车辆定位未授权。</Hint>}
      <div className="card trip-info"><div className="trip-metrics">
        {[
          ['里程', trip.distanceKm, 'km', 1], ['耗时', trip.durationMin, '分钟', 0], [trip.source === 'live' ? '估算耗电' : '耗电', trip.energyKwh, 'kWh', 1],
          ['百公里电耗', trip.efficiency, 'kWh/100km', 1], ['平均速度', trip.avgSpeedKmh, 'km/h', 0], ['轨迹点', showRoute ? trip.pointCount : null, '个', 0],
        ].map(([key, n, unit, digits]) => <div className="tm" key={String(key)}><span>{key}</span><b className="num">{value(n as number | null, Number(digits))}</b><small>{unit}</small></div>)}
      </div>
      {trip.source === 'live' && (trip.socStart != null || trip.socEnd != null) &&
        <div className="tiny muted">电量 {socText(trip.socStart)} → {socText(trip.socEnd)}</div>}
      {showRoute && first && last && <><div className="divider" /><div className="trip-legs">
        {([['起点', first, 'start', firstAddress], ['终点', last, 'end', lastAddress]] as const).map(([label, p, pointClass, address]) => <div key={label} className="trip-leg">
          <i className={'leg-dot ' + pointClass} /><div><b>{label}</b><small>{address || `${p.lat.toFixed(5)}, ${p.lon.toFixed(5)}`} · {clock(p.at)}</small></div></div>)}
      </div></>}
      </div>
      {showRoute && first && selected && <Timeline title="车速采样" unit="km/h" samples={samples} selectedAt={selectedAt} onSelect={selectSample} extra={locationText} />}
      {trip.source === 'live' && trip.energyKwh === null && (m.energySettings.capacityKwh === null ?
        <Hint>设置电池可用容量后，可按行程起止电量估算耗电。 <Link className="link" to="/vehicle-manage?setting=energy">设置容量</Link></Hint> :
        <Hint>需要记录到行程起止电量下降才能估算耗电。</Hint>)}
    </>}</div></>;
}

export function ChargeDetail() {
  const m = useModelContext();
  const { id } = useParams();
  const [selection, setSelection] = useState<{ id?: string; at: number } | null>(null);
  const charge = m.findCharge(id);
  const showSamples = charge?.source === 'ha' || m.simulated || !!charge?.powers.length;
  const est = charge && estimateChargeRecord(charge, m.tariff);
  const average = charge?.powers.length ? charge.powers.reduce((s, p) => s + p.value, 0) / charge.powers.length : null;
  const peak = charge?.powers.length ? charge.powers.reduce((n, p) => Math.max(n, p.value), 0) : null;
  return <><AppBar title="充电详情" back="/records?tab=charges" sub={charge ? stamp(charge.startedAt) : undefined} action={charge && <Badge source={charge.source} />} />
    <div className="page no-nav record-detail">{!m.canSee('mileage') ? <MileageNotice /> : !charge ? <Hint>充电记录不存在、正在载入或已从本机清理。</Hint> : <>
      <div className="card"><div className="between"><div><div className="tiny muted">{charge.energyBasis === 'soc' ? '估算充入电量' : charge.energyBasis === 'official' ? '官方充入电量' : '充入电量'}</div><b className="record-total num">{value(charge.kwh, 1)} kWh</b></div>
        <span className={'pill ' + (charge.partial && !charge.active ? 'pending' : 'green')}>{charge.active ? '充电中' : charge.partial ? '片段' : '已完成'}</span></div>
        <div className="between"><span>{charge.socStart !== null || charge.socEnd !== null ?
          socText(charge.socStart) + ' → ' + socText(charge.socEnd) : clock(charge.startedAt) + ' → ' + clock(charge.endedAt)}</span><span>{charge.endedAt ? Math.round((charge.endedAt - charge.startedAt) / 60_000) : '—'} 分钟 · {types[charge.type]}</span></div></div>
      {showSamples && <Timeline title="充电功率" unit="kW" samples={charge.powerTimeline ?? charge.powers} maxGap={900_000}
        selectedAt={selection?.id === id ? selection?.at ?? null : null} onSelect={at => setSelection(previous => previous && previous.id === id && previous.at === at ? previous : { id, at })} />}
      <div className="card cost-est"><div className="tiny muted">本次预估电费</div><div className="cost-big num">{est ? '约 ¥' + est.cost.toFixed(2) : '—'}</div>
        <p className="tiny muted">{est ? '估算取电 ' + value(est.gridKwh, 1) + ' kWh · 平均 ¥' + value(est.averagePrice, 3) + '/kWh' :
          charge.source === 'live' && charge.gridKwh !== null ? '估算取电 ' + value(charge.gridKwh, 1) + ' kWh' : '需要充电量、充电类型和完整时段。'}</p>
        <Link className="link" to="/records-source?setting=tariff">修改电价</Link>{charge.source === 'live' && <>
          {' · '}<Link className="link" to="/vehicle-manage?setting=energy">修改充电效率</Link></>}</div>
      {showSamples && <div className="detail-stats">{[['平均采样功率', value(average, 1) + ' kW'], ['最大功率', value(peak, 1) + ' kW'],
        ['充电类型', types[charge.type]], ['完整性', charge.partial ? '存在缺口' : '完整']].map(([key, v]) => <div className="ds" key={key}><span>{key}</span><b>{v}</b></div>)}</div>}
    </>}</div></>;
}

const sources = [
  ['phone', '手机记录', '由 App 查询零跑云车况，行程保存在本机。'],
  ['ha', 'HA 同步', '只读同步详细行程、充电和历史采样。'],
  ['hybrid', '手机记录 + HA 同步', '手机继续记录，连接到同车 HA 后自动合并。'],
  ['off', '关闭记录', '停止采样与历史同步。'],
] as const;
export function RecordsSource() {
  const m = useModelContext();
  const [settings, setSettings] = useSearchParams();
  const navigate = useNavigate();
  const [cleanup, setCleanup] = useState(false);
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [selection, setSelection] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);
  const defaultSource = m.mode === 'ha' ? 'ha' : defaultRecordSource;
  return <><AppBar title="记录与数据源" back="/records" sub="行程与充电记录的来源" /><div className="page no-nav">
    <Section title="选择数据源">{sources.filter(([key]) => key !== 'hybrid' || m.mode !== 'ha').map(([key, label, note]) => {
      const badge = key === defaultSource ? '默认' : key === 'ha' ? '推荐' : '';
      return <button type="button" key={key} className={'source-opt' + (key === m.source ? ' on' : '')} aria-pressed={key === m.source}
        onClick={() => { m.setSource(key); if (key === 'ha' || key === 'hybrid' && m.mode === 'cloud' && !m.ha.connected) navigate('/ha'); }}>
        <span className="radio" /><span className="so-body"><b>{label}</b><small>{note}</small></span>{badge && <span className="pill">{badge}</span>}</button>;
    })}</Section>
    {m.usesPhone && <Section title="后台常驻"><p className="tiny muted">{m.background.active ? '后台车况轮询已启动' :
      m.mode !== 'cloud' ? '登录零跑账号后可采集车辆上报。' : m.background.supported ? '开启后，应用退到后台也会查询车况。' : '此平台在应用前台时查询车况。'}</p>
      <Link className="btn secondary sm" to="/background-guide">打开后台常驻设置</Link></Section>}
    {m.usesHA && <Section title="Home Assistant"><p className="tiny muted">{!m.ha.connected || m.ha.expired ? '未连接' :
      m.source === 'hybrid' && m.ha.error ? '等待连接 HA · 手机继续记录' : '已连接'}</p>
      <Link className={m.ha.connected && !m.ha.expired ? 'btn secondary sm' : 'btn accent sm'} to="/ha">{m.ha.connected && !m.ha.expired ? '管理 HA 连接' : '登录 Home Assistant'}</Link></Section>}
    {m.source === 'off' && <Hint>已关闭记录。可继续查看即时车况。</Hint>}
      <Section title="充电费用">
        <Row icon="bolt" title="电价设置" sub="交流峰谷 · 直流分时" onClick={() => setSettings({ setting: 'tariff' })} />
      </Section>
      <Section title="数据管理">
        <Row icon="clock" title="同步范围" sub={'Recorder 最近 ' + (m.ha.config?.days ?? 30) + ' 天'} right="修改"
          onClick={() => m.ha.config ? setSelection(true) : navigate('/ha')} />
        <Row icon="file" title="导出记录" label="导出记录" sub="CSV · 脱敏" onClick={() => setExportOpen(true)} disabled={!m.canSee('mileage')} />
        <Row icon="trash" title="清理本地记录" sub="本车的采样和同步副本" onClick={() => { setConfirm(''); setCleanup(true); }} />
      </Section>
      {settings.get('setting') === 'tariff' && <TariffSheet close={() => setSettings({}, { replace: true })} />}
      {exportOpen && m.canSee('mileage') && <ExportRecords {...m.records} key={m.tripScope}
        close={() => setExportOpen(false)} saved={() => { setExportOpen(false); m.setToast('已导出记录'); }} />}
      {selection && m.ha.config && <Sheet title="Recorder 同步范围" close={() => setSelection(false)} className="ha-range">
        <Seg options={[[7, '7 天'], [30, '30 天'], [90, '90 天']]} current={m.ha.config.days} label="同步范围"
          choose={days => { m.ha.setConfig({ ...m.ha.config!, days }); setSelection(false); }} /></Sheet>}
      {cleanup && <Sheet title="清理本地记录？" close={busy ? undefined : () => setCleanup(false)}>
        <p className="confirm-desc">本车的本地记录将永久删除。HA 服务器中的原始数据保留。输入「清除本地记录」确认。</p>
        <div className="field"><input aria-label="输入清除本地记录" value={confirm} onChange={e => setConfirm(e.target.value)} /></div>
        <SheetButtons cancel={() => { if (!busy) setCleanup(false); }} label="清除记录" danger disabled={confirm.trim() !== '清除本地记录' || busy} action={() => {
          setBusy(true);
          void m.clearLocal().then(() => { m.setToast('本车本地记录已清理'); setCleanup(false); }).catch(() => m.setToast('本地记录清理失败')).finally(() => setBusy(false));
        }} />
      </Sheet>}
  </div></>;
}
