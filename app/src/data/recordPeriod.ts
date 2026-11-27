export const recordPeriods = [['recent', '最近'], ['week', '周'], ['month', '月'], ['all', '全']] as const;
export type RecordPeriod = typeof recordPeriods[number][0];
export const periodTitles = { recent: '最近', week: '本周', month: '本月', all: '全部' };

export function periodStart(period: RecordPeriod | 'year', now = Date.now()) {
  if (period === 'all' || period === 'recent') return 0;
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  if (period === 'week') start.setDate(start.getDate() - (start.getDay() + 6) % 7);
  else if (period === 'month') start.setDate(1);
  else start.setMonth(0, 1);
  return start.getTime();
}
