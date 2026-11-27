import { numberOf } from './measurements';
import type { Charge, MetricSample, Point, TrackSample, Trip } from './measurements';
import type { EnergyDay } from '../types';
import type { HAConfig } from './schema';
import { vehicleChargeIndex, vehicleLedger } from './archive';
import { readDataset, saveDataset, updateDataset } from '../localDatabase';
import { ledgerKey, savedLedgerKey, trackPrefix } from './cacheKeys';
import { chargeWindowStart } from '../tariff';

type Row = Record<string, unknown>;
const rows = (value: unknown): Row[] => Array.isArray(value) ? value.filter(row => row && typeof row === 'object' && !Array.isArray(row)) : [];
const epoch = (value: unknown) => {
  const seconds = numberOf(value);
  return seconds !== null && seconds >= 1e9 && seconds < 1e10 ? Math.round(seconds * 1000) : null;
};
const energy = (value: unknown) => {
  const n = numberOf(value);
  return n !== null && n >= 0 ? n : null;
};
const socOf = (value: unknown) => { const n = energy(value); return n !== null && n <= 100 ? n : null; };
const reading = (value: unknown, socs: unknown): MetricSample[] => Array.isArray(value) ? value.flatMap((point, index) => {
  const at = Array.isArray(point) ? epoch(point[0]) : null;
  if (at === null) return [];
  return [{ at, value: energy(point[1]), soc: Array.isArray(socs) ? socOf(socs[index]) : null }];
}).sort((a, b) => a.at - b.at) : [];

function asTrip(raw: Row): Trip | null {
  const start = epoch(raw.started_at), end = epoch(raw.ended_at);
  if (typeof raw.id !== 'string' || start === null || end !== null && end < start) return null;
  const distanceKm = energy(raw.distance_km);
  const pointCount = energy(raw.point_count);
  const approximate = !!(raw.reconstructed || raw.frozen || raw.approx_time || raw.gap_seconds);
  return { id: 'ha-trip-' + raw.id, startedAt: start, endedAt: end, source: 'ha', distanceKm, durationMin: energy(raw.duration_min),
    energyKwh: energy(raw.energy_kwh), efficiency: energy(raw.efficiency), avgSpeedKmh: energy(raw.avg_speed_kmh), pointCount,
    gap: approximate || !pointCount || raw.track_dropped === true, complete: !approximate && end !== null && distanceKm !== null, route: [], speeds: [],
    socStart: socOf(raw.start_soc), socEnd: socOf(raw.end_soc), reconstructed: raw.reconstructed === true,
    startOdometerKm: energy(raw.start_odo), endOdometerKm: energy(raw.end_odo) };
}

function asCharge(raw: Row): Charge | null {
  const active = raw.active === true;
  const start = epoch(raw.started_at), end = epoch(raw.ended_at) ?? (active ? null : epoch(raw.last_at));
  if (typeof raw.id !== 'string' || start === null || end !== null && end < start) return null;
  const type = raw.charge_type;
  const kwh = energy(raw.official_energy_kwh) ?? energy(raw.kwh);
  const powerTimeline = reading(raw.power_samples, raw.soc_samples);
  return { id: 'ha-charge-' + raw.id, source: 'ha', startedAt: start, endedAt: end,
    kwh, gridKwh: energy(raw.grid_kwh), cost: energy(raw.cost), type: type === 'ac' || type === 'dc' || type === 'mixed' ? type : 'unknown',
    partial: raw.partial === true, active, powerTimeline,
    powers: powerTimeline.flatMap(({ at, value }) => value === null ? [] : [{ at, value }]),
    socStart: energy(raw.soc_start), socEnd: energy(raw.soc_end) };
}

function ledgerRows<T extends { id: string }>(value: unknown, parse: (row: Row) => T | null) {
  const records = rows(value).flatMap(row => parse(row) ?? []);
  return [...new Map(records.map(record => [record.id, record])).values()];
}

interface Ledger { trips: Trip[]; charges: Charge[]; lastSync: number }
const legacyLedgerKey = (config: HAConfig, vin: string) => 'ha-ledger:' + JSON.stringify([config.url, vin, config.days]);
export const readLedger = (config: HAConfig, vin: string) => readDataset<Ledger>(ledgerKey(config, vin));
type SavedRecords = Pick<Ledger, 'trips' | 'charges'>;
export const readSavedLedger = (config: HAConfig, vin: string) => readDataset<SavedRecords>(savedLedgerKey(config, vin));

// Each response replaces only its verified time window. Older pages and the other
// record type survive independent or concurrent syncs.
async function rememberRows<K extends keyof SavedRecords>(config: HAConfig, vin: string, kind: K, rows: SavedRecords[K],
  signal: AbortSignal, from = Infinity, to = Infinity) {
  signal.throwIfAborted();
  await updateDataset<SavedRecords>(savedLedgerKey(config, vin), prior => {
    const previous = prior ?? { trips: [], charges: [] };
    if (signal.aborted) return previous;
    const known = new Map<string, Trip | Charge>();
    for (const row of previous[kind]) if (row.startedAt < from || row.startedAt > to) known.set(row.id, row);
    for (const row of rows) known.set(row.id, row);
    return { ...previous, [kind]: [...known.values()].sort((a, b) => b.startedAt - a.startedAt) };
  });
}

export async function haChargeSessions(config: HAConfig, vin: string, days: number, signal: AbortSignal) {
  const reply = await vehicleLedger<{ vin: string; sessions: unknown }>(config, vin, 'charging/history', { days }, signal);
  if (!Array.isArray(reply.sessions)) throw new Error('HA 充电记录暂不可用。');
  const charges = ledgerRows(reply.sessions, asCharge);
  await rememberRows(config, vin, 'charges', charges, signal, chargeWindowStart(days));
  return charges;
}

export async function haOlderChargeSessions(config: HAConfig, vin: string, signal: AbortSignal, from = chargeWindowStart(90)) {
  const to = chargeWindowStart(31) - 1;
  const result = await vehicleChargeIndex(config, vin, from, to, signal);
  const charges = ledgerRows(result.rows, raw => asCharge({ id: raw.record_id, started_at: Number(raw.started_at_ms) / 1000,
    ended_at: Number(raw.ended_at_ms) / 1000, charge_type: raw.charge_type, partial: raw.phase !== 'completed',
    kwh: raw.energy && typeof raw.energy === 'object' && 'kwh' in raw.energy ? raw.energy.kwh : null }));
  const inRange = charges.filter(row => row.startedAt >= from && row.startedAt <= to);
  await rememberRows(config, vin, 'charges', inRange, signal, result.coverage === 'complete' ? from : Infinity, to);
  return { charges: inRange, coverage: result.coverage };
}

export async function haTripHistory(config: HAConfig, vin: string, from: number, signal: AbortSignal, latestOnly = false) {
  const trips = new Map<string, Trip>();
  let end = Date.now() / 1000;
  for (;;) {
    const days = Math.min(3650, Math.ceil((end * 1000 - from) / 86400_000) + 1);
    const window = !from && !trips.size ? {} : { days, end };
    const result = await vehicleLedger<{ vin: string; trips: unknown }>(config, vin, 'trips/list', { ...window, limit: latestOnly ? 1 : 2000 }, signal);
    if (!Array.isArray(result.trips)) throw new Error('行程历史暂不可用。');
    const page = ledgerRows(result.trips, asTrip);
    for (const trip of page) if (trip.startedAt >= from) trips.set(trip.id, trip);
    const oldest = Math.min(...page.map(trip => trip.startedAt));
    if (latestOnly || result.trips.length < 2000 || oldest <= from) break;
    if (!Number.isFinite(oldest) || oldest / 1000 > end) throw new Error('无法读取更早的行程。');
    end = (oldest - 1) / 1000;
  }
  const history = [...trips.values()];
  await rememberRows(config, vin, 'trips', history, signal, latestOnly ? Infinity : from);
  return history;
}

export async function syncLedger(config: HAConfig, vin: string, signal: AbortSignal) {
  const [travel, charging] = await Promise.allSettled([
    vehicleLedger<{ vin: string; trips: unknown; active: unknown }>(config, vin, 'trips/list', { days: config.days, limit: 500 }, signal),
    haChargeSessions(config, vin, Math.min(30, config.days), signal),
  ]);
  signal.throwIfAborted();
  const prior = await readLedger(config, vin);
  const tripsRead = travel.status === 'fulfilled' && Array.isArray(travel.value.trips);
  const chargesRead = charging.status === 'fulfilled';
  // Match the HA cards' trips and sessions collections. Active trips and unpaired official charges are separate API data.
  const trips = tripsRead && travel.status === 'fulfilled' ? ledgerRows(travel.value.trips, asTrip) : prior?.trips ?? [];
  const activeRow = tripsRead && travel.status === 'fulfilled' && travel.value.active && typeof travel.value.active === 'object'
    ? travel.value.active as Row : null;
  const trip = activeRow && asTrip(activeRow);
  const activeTrip = trip;
  const charges = charging.status === 'fulfilled' ? charging.value : prior?.charges ?? [];
  const result = { trips, charges, lastSync: tripsRead || chargesRead ? Date.now() : prior?.lastSync ?? 0 };
  signal.throwIfAborted();
  if (tripsRead) await rememberRows(config, vin, 'trips', trips, signal, trips.length >= 500
    ? Math.min(...trips.map(row => row.startedAt)) : chargeWindowStart(config.days));
  if (tripsRead || chargesRead) await saveDataset(ledgerKey(config, vin), result);
  return { ...result, tripsRead, chargesRead, activeTrip };
}

export const ledgerKeys = (config: HAConfig, vin: string) => [savedLedgerKey(config, vin),
  ...[7, 30, 90].flatMap(days => [ledgerKey({ ...config, days }, vin), legacyLedgerKey({ ...config, days }, vin)])];

export async function haTripTrack(config: HAConfig, vehicle: string, tripId: string, signal: AbortSignal, maxPoints = 20_000,
  policy: 'refresh' | 'saved-first' | 'saved-only' = 'refresh') {
  const prefix = trackPrefix(config, vehicle) + JSON.stringify(tripId) + ':';
  const key = prefix + maxPoints;
  const saved = () => readDataset<TrackSample[]>(key);
  const alternate = () => readDataset<TrackSample[]>(prefix + (maxPoints === 120 ? 20_000 : 120));
  if (policy !== 'refresh') {
    const existing = await saved();
    if (existing) return existing;
    if (policy === 'saved-only') return await alternate() ?? [];
  }
  let result: { vin: string; points?: unknown };
  try {
    result = await vehicleLedger(config, vehicle, 'trips/track', { trip_id: tripId, max_points: maxPoints }, signal);
  } catch (error) {
    signal.throwIfAborted();
    const existing = await saved() ?? await alternate();
    if (existing) return existing;
    throw error;
  }
  const samples: TrackSample[] = [];
  if (Array.isArray(result?.points)) for (const point of result.points) {
    if (!Array.isArray(point)) continue;
    const [lat, lon, speed, timestamp, soc] = point;
    const at = epoch(timestamp);
    if (at === null) continue;
    const position: Point | undefined = typeof lat === 'number' && typeof lon === 'number' && Math.abs(lat) <= 90 && Math.abs(lon) <= 180 && (lat || lon)
      ? { at, lat, lon, coordinate: 'wgs84' } : undefined;
    const value = energy(speed), pct = socOf(soc);
    if (position || value !== null || pct !== null) samples.push({ at, position, value, soc: pct });
  }
  signal.throwIfAborted();
  await saveDataset(key, samples);
  return samples;
}

export async function haEnergy(config: HAConfig, vehicle: string, days: number, signal: AbortSignal) {
  const result = await vehicleLedger<{ vin: string; days: unknown; pending?: number; fuel_average?: unknown }>(config, vehicle, 'energy/daily', { days: Math.min(31, Math.max(14, days)) }, signal);
  if (!result || !Array.isArray(result.days)) return null;
  const daily: EnergyDay[] = rows(result.days).flatMap(row => {
    const km = energy(row.km), kwh = energy(row.kwh);
    return typeof row.day === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(row.day) ? [{ day: row.day, km, kwh,
      efficiency: km !== null && km > 0 && kwh !== null ? kwh * 100 / km : null }] : [];
  }).sort((a, b) => a.day.localeCompare(b.day));
  const last = Date.parse(daily.at(-1)?.day ?? '');
  const monday = last - (new Date(last).getUTCDay() + 6) % 7 * 86_400_000;
  const parts = rows(result.days).filter(row => typeof row.day === 'string' && Date.parse(row.day) >= monday - 7 * 86_400_000 && Date.parse(row.day) < monday);
  const sum = (field: string) => {
    const values = parts.map(row => energy(row[field]));
    return values.some(v => v !== null) ? values.reduce<number>((s, v) => s + (v ?? 0), 0) : null;
  };
  return { daily: daily.slice(-days), pending: energy(result.pending) ?? 0, fuel: energy(result.fuel_average),
    breakdown: { drive: sum('drv'), climate: sum('ac'), other: sum('oth') } };
}
