import { mergeTemperatureSamples } from './ha/measurements.ts';
import type { Charge, Trip } from './ha/measurements.ts';

type Interval = { id: string; startedAt: number; endedAt: number | null };
const newest = (a: Interval, b: Interval) => b.startedAt - a.startedAt;
const tripEnd = (trip: Trip) => trip.endedAt ?? Math.max(trip.startedAt,
  trip.lastSampleAt ?? 0, trip.speeds.at(-1)?.at ?? 0, trip.route.at(-1)?.at ?? 0);
const chargeEnd = (charge: Charge) => charge.endedAt ?? charge.powerTimeline?.at(-1)?.at ?? charge.startedAt;

function matchRecords<T extends Interval>(local: T[], remote: T[], endOf: (record: T) => number, drift: number) {
  const matches = new Map<string, T[]>();
  const unmatched: T[] = [];
  const intervals = remote.map(row => ({ row, end: endOf(row) })).sort((a, b) => a.row.startedAt - b.row.startedAt);
  for (const row of local) {
    const end = endOf(row);
    let best: { row: T; score: number } | undefined;
    for (const { row: candidate, end: candidateEnd } of intervals) {
      if (candidate.startedAt > end + drift) break;
      if (candidateEnd < row.startedAt - drift) continue;
      const startDelta = Math.abs(row.startedAt - candidate.startedAt);
      const endDelta = Math.abs(end - candidateEnd);
      const overlap = Math.min(end, candidateEnd) - Math.max(row.startedAt, candidate.startedAt);
      const shorter = Math.min(end - row.startedAt, candidateEnd - candidate.startedAt);
      // Nearby boundaries alone cannot merge two records separated by a stop.
      const sameInstant = shorter === 0 && (overlap === 0 || startDelta <= 10_000);
      if (!sameInstant && (overlap <= 0 || overlap < shorter * .75)) continue;
      const score = overlap / Math.max(1, shorter) + Math.max(0, 1 - (startDelta + endDelta) / (2 * drift));
      if (!best || score > best.score) best = { row: candidate, score };
    }
    if (!best) { unmatched.push(row); continue; }
    const group = matches.get(best.row.id);
    if (group) group.push(row);
    else matches.set(best.row.id, [row]);
  }
  return { matches, unmatched };
}

type MeterSpan = { from: number; to: number };
function meterSpan(row: Trip): MeterSpan | undefined {
  const from = row.startOdometerKm, to = row.endOdometerKm;
  if (from != null && to != null && from >= 0 && to > from) return { from, to };
}

const tripClockDrift = 120_000;
function overlapsTrip(local: Trip, remote: Trip) {
  const end = Math.min(tripEnd(local), tripEnd(remote));
  const start = Math.max(local.startedAt, remote.startedAt);
  const localMeter = meterSpan(local), remoteMeter = meterSpan(remote);
  if (localMeter && remoteMeter) {
    return end + tripClockDrift >= start && Math.min(localMeter.to, remoteMeter.to) > Math.max(localMeter.from, remoteMeter.from);
  }
  if (end > start) {
    const shorter = Math.min(tripEnd(local) - local.startedAt, tripEnd(remote) - remote.startedAt);
    return end - start >= shorter * .75;
  }
  // An instantaneous observation belongs inside a drive, not to both neighbours at a stop.
  if (end !== start) return false;
  return local.startedAt === remote.startedAt || (local.startedAt < start && tripEnd(local) > end) ||
    (remote.startedAt < start && tripEnd(remote) > end);
}

function uncoveredTripKm(phone: Trip, matches: Trip[]) {
  if (phone.distanceKm === null || phone.endedAt === null) return 0;
  const local = meterSpan(phone);
  const spans = matches.map(meterSpan);
  if (local && spans.every((span): span is MeterSpan => !!span)) {
    // Intersect the union: overlapping HA meter ranges only consume this mileage once.
    let covered = 0, cursor = local.from;
    for (const span of spans.sort((a, b) => a.from - b.from)) {
      const end = Math.min(span.to, local.to);
      covered += Math.max(0, end - Math.max(cursor, span.from));
      cursor = Math.max(cursor, end);
    }
    // GPS may measure a short drive that only crossed one integer odometer tick.
    return covered >= local.to - local.from ? 0 : Math.max(0, phone.distanceKm - covered);
  }
  // Old cached HA summaries can lack meter endpoints. Subtract only entire,
  // non-overlapping HA drives contained in the phone's observation window.
  if (matches.length === 1 && !phone.reconstructed && Math.abs(phone.startedAt - matches[0].startedAt) <= 20_000 &&
    Math.abs(phone.endedAt - tripEnd(matches[0])) <= 20_000) return 0;
  let lastEnd = phone.startedAt, covered = 0;
  for (const row of matches) {
    const end = tripEnd(row);
    if (row.startedAt < lastEnd || end > phone.endedAt || row.endedAt === null || row.distanceKm === null) return 0;
    lastEnd = end;
    covered += row.distanceKm;
  }
  if (matches.length === 1 && Math.abs(matches[0].startedAt - phone.startedAt) <= tripClockDrift &&
    Math.abs(tripEnd(matches[0]) - phone.endedAt) <= tripClockDrift) return 0;
  return Math.max(0, phone.distanceKm - covered);
}

function remainingMileage(row: Trip, km: number): Trip {
  // The residual can span several uncovered intervals. Its distance is known, its route and times are approximate.
  return { id: row.id + '-remainder', source: row.source, startedAt: row.startedAt, endedAt: row.endedAt,
    distanceKm: km, reconstructed: true, mileageRemainder: true, complete: false, gap: true, durationMin: null, avgSpeedKmh: null,
    energyKwh: null, efficiency: null, route: [], speeds: [], pointCount: 0 };
}

export function combineTrips(local: Trip[], remote: Trip[]) {
  const primary = [...new Map(remote.map(row => [row.id, row])).values()].sort((a, b) => a.startedAt - b.startedAt || a.id.localeCompare(b.id));
  const matches = new Map<string, Trip[]>(), aliases = new Map<string, string[]>();
  const extra: Trip[] = [];
  for (const phone of new Map(local.map(row => [row.id, row])).values()) {
    const peers = primary.filter(row => overlapsTrip(phone, row));
    if (!peers.length) { extra.push(phone); continue; }
    const remaining = uncoveredTripKm(phone, peers);
    if (remaining > .000001) {
      const leftover = remainingMileage(phone, remaining);
      extra.push(leftover);
      aliases.set(leftover.id, [phone.id, ...(phone.formerIds ?? [])]);
    } else if (peers.length === 1) {
      const id = peers[0].id;
      const peersForHA = matches.get(id) ?? [];
      peersForHA.push(phone);
      matches.set(id, peersForHA);
      aliases.set(id, peersForHA.flatMap(row => [row.id, ...(row.formerIds ?? [])]));
    }
  }
  const trips = primary.map(row => {
    const candidates = matches.get(row.id);
    const sameBounds = candidates?.find(record => record.endedAt !== null && row.endedAt !== null &&
      Math.abs(record.startedAt - row.startedAt) <= 20_000 && Math.abs(record.endedAt - row.endedAt) <= 20_000);
    const equivalent = candidates?.find(record => Math.abs(record.startedAt - row.startedAt) <= tripClockDrift &&
      Math.abs(tripEnd(record) - tripEnd(row)) <= tripClockDrift && record.route.length >= 2);
    const base = !equivalent || row.route.length || row.reconstructed ? row : { ...row,
      route: equivalent.route.filter(p => p.at >= row.startedAt && p.at <= tripEnd(row)),
      speeds: equivalent.speeds.filter(p => p.at >= row.startedAt && p.at <= tripEnd(row)) };
    return sameBounds ? { ...base, distanceKm: row.distanceKm ?? sameBounds.distanceKm,
      rangeStartKm: row.rangeStartKm ?? sameBounds.rangeStartKm, rangeEndKm: row.rangeEndKm ?? sameBounds.rangeEndKm,
      rangeComparable: row.rangeComparable ?? sameBounds.rangeComparable, socStart: row.socStart ?? sameBounds.socStart,
      socEnd: row.socEnd ?? sameBounds.socEnd, batteryTemperatures: row.batteryTemperatures?.length ? row.batteryTemperatures :
        sameBounds.batteryTemperatures?.filter(sample => sample.at >= row.startedAt && sample.at <= row.endedAt!),
      socSamples: row.socSamples ?? sameBounds.socSamples?.filter(sample => sample.at >= row.startedAt && sample.at <= row.endedAt!) } : base;
  });
  return { trips: [...trips, ...extra].sort(newest), aliases };
}

export function combineCharges(local: Charge[], remote: Charge[]) {
  const { matches, unmatched } = matchRecords(local, remote, chargeEnd, 15 * 60_000);
  const aliases = new Map<string, string[]>();
  const primary = remote.map(row => {
    const matched = matches.get(row.id);
    if (!matched?.length) return row;
    const active = matched.find(record => record.active);
    const end = chargeEnd(row);
    const point = matched.map(record => record.position).find(p => p && p.at >= row.startedAt &&
      (p.at < end || p.at === end && (row.active || end === row.startedAt)));
    const position = row.position && row.position.coordinate !== 'unknown' ? row.position : point ?? row.position;
    const temperatures = (record: Charge) => mergeTemperatureSamples(record.startedAt, record.endedAt ?? Infinity,
      ...matched.map(match => match.batteryTemperatures), row.batteryTemperatures);
    const ids = matched.flatMap(record => record.sampledId ? [record.id, record.sampledId] : [record.id]);
    if (row.active && active) {
      aliases.set(active.id, [row.id, ...ids.filter(id => id !== active.id)]);
      return { ...active, position: active.position ?? position, batteryTemperatures: temperatures(active) };
    }
    aliases.set(row.id, ids);
    const equivalent = matched.find(record => Math.abs(record.startedAt - row.startedAt) < 120_000 &&
      Math.abs(chargeEnd(record) - chargeEnd(row)) < 120_000);
    const base = { ...row, position, batteryTemperatures: temperatures(row) };
    if (!equivalent) return base;
    return { ...base, kwh: row.kwh ?? equivalent.kwh, gridKwh: row.gridKwh ?? equivalent.gridKwh,
      socStart: row.socStart ?? equivalent.socStart, socEnd: row.socEnd ?? equivalent.socEnd,
      powers: row.powers.length ? row.powers : equivalent.powers,
      powerTimeline: row.powerTimeline?.length ? row.powerTimeline : equivalent.powerTimeline };
  });
  return { charges: [...primary, ...unmatched].sort(newest), aliases };
}
