import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { localDay } from '../../data/ha/measurements';
import { haChargeSessions, haOlderChargeSessions } from '../../data/ha/ledger';
import { chargeCostTotals, chargeWindowStart } from '../../data/tariff';
import { combineCharges } from '../../data/combinedRecords';
import { Seg } from '../../ui/components';
import { useModelContext } from '../context';
import { useDailyPlot } from './useDailyPlot';
import { useChartReveal } from './useChartReveal';

export const costText = (cost: number | null) => cost === null ? '—' : '¥' + cost.toFixed(2);

export function useExpenseCharges(m: ReturnType<typeof useModelContext>, days: number, visible = true) {
  const { config, vin } = m.ha;
  const useHA = visible && m.usesHA && m.canSee('mileage') && m.ha.connected && !!vin;
  const recent = useQuery({
    queryKey: ['ha', 'cost-charges', config?.url, vin],
    queryFn: ({ signal }) => haChargeSessions(config!, vin, 31, signal),
    enabled: useHA, retry: false, staleTime: 120_000,
  });
  const older = useQuery({
    queryKey: ['ha', 'cost-archive', config?.url, vin],
    queryFn: ({ signal }) => haOlderChargeSessions(config!, vin, signal),
    enabled: useHA && days === 90, retry: false, staleTime: 120_000,
  });
  const charges = useMemo(() => {
    if (!useHA || m.simulated) return m.records.charges;
    const rows = [...new Map([...(days === 90 && older.data ? older.data.charges : []),
      ...m.ha.records.charges, ...(recent.data ?? [])].map(charge => [charge.id, charge])).values()];
    return combineCharges(m.cloudRecords.charges, rows).charges;
  }, [days, useHA, m.simulated, m.records.charges, m.ha.records.charges, m.cloudRecords.charges, recent.data, older.data]);
  const partial = m.usesHA && useHA && (recent.isError ||
    (days === 90 && !older.isFetching && (older.isError || older.data?.coverage !== 'complete')));
  return { charges, partial, loading: useHA && (recent.isFetching || days === 90 && older.isFetching) };
}

export function ExpenseTotals({ totals, title }: { totals: ReturnType<typeof chargeCostTotals>; title?: string }) {
  return <div className={'expense-totals' + (title ? ' expense-totals-titled' : '')}>
    {title && <span className="tiny muted">{title}</span>}
    {([['合计', totals.total], ['交流', totals.ac], ['直流', totals.dc]] as const).map(([label, amount]) =>
      <div key={label}><span className="tiny muted">{label}</span><b className="num">{costText(amount)}</b></div>)}
  </div>;
}

export function ExpenseCard({ active }: { active: boolean }) {
  const m = useModelContext();
  const [days, setDays] = useState(30);
  const { charges, partial, loading } = useExpenseCharges(m, days, active);
  const start = chargeWindowStart(days);
  const { totals, samples, recordCount } = useMemo(() => {
    const now = Date.now();
    const rows = charges.filter(charge => charge.startedAt >= start && charge.startedAt <= now);
    const byDay = new Map<string, typeof charges>();
    for (const charge of rows) {
      const date = localDay(charge.startedAt);
      const existing = byDay.get(date);
      if (existing) existing.push(charge);
      else byDay.set(date, [charge]);
    }
    const date = new Date(start);
    const samples = Array.from({ length: days }, () => {
      const day = localDay(date.getTime());
      date.setDate(date.getDate() + 1);
      return { day, ...chargeCostTotals(byDay.get(day) ?? [], m.tariff, m.chargeFees.get) };
    });
    return { totals: chargeCostTotals(rows, m.tariff, m.chargeFees.get), samples, recordCount: rows.length };
  }, [charges, days, m.tariff, m.chargeFees.get, start]);
  const reveal = useChartReveal(active, totals.count > 0);
  const left = 14, right = 306, top = 12, bottom = 75;
  const { bindings, guide, index, spacing, x } = useDailyPlot(samples, 320, left, right, active);
  const selected = samples[index];
  const maximum = Math.max(1, ...samples.map(day => day.total ?? 0));
  const barWidth = Math.max(1, Math.min(18, spacing * .6));
  return <section className="card chart-card expense-card" id="expense-statistics" tabIndex={-1}>
    <div className="chart-head"><h3>{totals.manualCount ? '充电费用' : '充电费用估算'}</h3>
      <Seg options={[[7, '7 天'], [30, '30 天'], [90, '90 天']]} current={days} choose={setDays} label="费用统计范围" />
    </div>
    <ExpenseTotals totals={totals} />
    <div {...bindings} className={'energy-plot expense-day-plot' + (guide ? ' show-guide' : '')} role="group" tabIndex={0}
      aria-label="费用统计，左右拖动或按方向键查看日期">
      <svg className="chart-svg expense-plot" viewBox="0 0 320 98" role="img" aria-label={`近 ${days} 天${totals.manualCount ? '' : '预估'}电费柱状图`}>
        {[top, 43, bottom].map(y => <line key={y} x1={left} x2={right} y1={y} y2={y} stroke="var(--line-strong)" />)}
        {totals.count > 0 && <g className="plot-series" {...reveal}>{samples.map(({ day, total }, i) => {
          if (total === null) return null;
          const height = Math.max(1, (bottom - top) * total / maximum);
          return <rect key={day} data-day={day} x={x(i) - barWidth / 2} y={bottom - height} width={barWidth} height={height} rx="1" fill="var(--accent)">
            <title>{day + ' · ' + costText(total)}</title>
          </rect>;
        })}</g>}
        {selected && <line className="energy-guide" x1={x(index)} x2={x(index)} y1={top} y2={bottom} />}
        {[0, Math.floor(days / 2), days - 1].map((i, tick) => <text key={i} x={[left, 160, right][tick]} y="92"
          textAnchor={(['start', 'middle', 'end'] as const)[tick]} fontSize="11" fill="var(--text2)">{samples[i].day.slice(5)}</text>)}
      </svg>
    </div>
    {selected && <div className="energy-trend-footer expense-day-details" role="status" id="expense-day-reading" data-day={selected.day}>
      <b className="num">{selected.day.slice(5).replace('-', '月')}日 · {costText(selected.total)}</b>
      <span className="tiny muted">交流 {costText(selected.ac)} · 直流 {costText(selected.dc)}</span>
    </div>}
    {(partial || totals.count < recordCount) && <p className="tiny muted">{partial ? '部分 HA 历史暂不可用。' : ''}合计仅含有实付或估算金额的记录。</p>}
    {loading && !totals.count && <p className="tiny muted">正在读取充电记录…</p>}
    {!loading && !totals.count && <p className="tiny muted">该时段暂无可估算的充电记录。</p>}
  </section>;
}
