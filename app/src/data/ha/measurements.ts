import type { ChargeSession, EnergyDay, TripSummary } from '../types.ts';
import { entityIdOf } from './schema.ts';
import type { Field, Mapping, Sample } from './schema.ts';
import type { Archive } from './archive.ts';
import { estimateSocEnergy, socPercent } from '../vehicleEnergy.ts';

export type Point = { at: number; lat: number; lon: number; coordinate: 'gcj02' | 'wgs84' | 'unknown'; gapBefore?: boolean };
export type MetricSample = { at: number; value: number | null; soc?: number | null };
export type TrackSample = MetricSample & { position?: Point; distanceKm?: number };
export type Reading = Partial<Record<Field, number | string | null>> & { position?: Point | null; rangeBasis?: string };
export type Frame = { at: number; data: Reading; changed: Field[]; tripBoundary?: 'interrupted' | 'ended' | 'parked'; chargeBoundary?: true; chargeOnly?: true; pollIntervalMs?: number };
export type Trip = TripSummary & { route: Point[]; speeds: { at: number; value: number }[]; gap: boolean; group?: 'archive';
  socStart?: number | null; socEnd?: number | null; socSamples?: MetricSample[]; batteryTemperatures?: MetricSample[];
  rangeStartKm?: number | null; rangeEndKm?: number | null; rangeComparable?: boolean; reconstructed?: boolean;
  startOdometerKm?: number | null; endOdometerKm?: number | null; lastSampleAt?: number; formerIds?: string[];
  mileageRemainder?: boolean };
export type Charge = ChargeSession & { position?: Point; powers: { at: number; value: number }[]; powerTimeline?: MetricSample[]; socSamples?: MetricSample[]; batteryTemperatures?: MetricSample[]; group?: 'archive'; active?: boolean;
  energyBasis?: 'official' | 'soc'; sampledId?: string; minRecordedBatteryTempC?: number };

const missing = new Set(['', 'unavailable', 'unknown', 'none', 'null', 'nan', '—']);
export const numberOf = (value: unknown): number | null => {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  if (missing.has(String(value).trim().toLowerCase())) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};
const words = (value: unknown) => String(value ?? '').trim().toLowerCase();
const numeric = new Set<Field>(['soc', 'range', 'odometer', 'speed', 'power', 'charged', 'used', 'latitude', 'longitude', 'inside', 'fuel', 'fuelRange', 'rankEfficiency', 'tireFL', 'tireFR', 'tireRL', 'tireRR']);
export function stateOf(value: unknown) {
  const text = words(value);
  if (['1', 'on', 'true', 'locked', 'closed', '开启', '闭锁', '锁定'].includes(text)) return true;
  if (['0', 'off', 'false', 'unlocked', 'open', '关闭', '解锁'].includes(text)) return false;
  return null;
}

export function openingOf(value: unknown) {
  const text = words(value);
  if (['on', 'true', 'open', '开启', '打开', '已开'].includes(text)) return true;
  if (['off', 'false', 'closed', '关闭', '已关'].includes(text)) return false;
  const opening = numberOf(value);
  return opening !== null && opening >= 0 && opening <= 100 ? opening > 0 : null;
}

export function chargeOf(value: unknown, plug?: unknown) {
  const state = words(value);
  if (['charging', '1', 'on', 'true', '充电中', '正在充电'].includes(state)) return 'charging';
  if (['done', 'full', 'complete', 'completed', '充电完成'].includes(state)) return 'done';
  if (['connected', 'plugged', '已插枪'].includes(state)) return 'plugged';
  if (['unplugged', 'disconnected', '未插枪'].includes(state)) return 'unplugged';
  const connected = stateOf(plug);
  return connected === true ? 'plugged' : connected === false ? 'unplugged' : 'unknown';
}
export function drivingOf(value: Reading) {
  if (['driving', 'moving', 'on', 'd', 'r', '行驶中', '行驶'].includes(words(value.motion))) return true;
  if (['parked', 'parking', 'off', 'p', '已驻车', '驻车'].includes(words(value.motion))) return false;
  const speed = numberOf(value.speed);
  return speed === null ? null : speed > 1;
}
function normalized(field: Field, sample: Sample) {
  if (!numeric.has(field)) return missing.has(words(sample.state)) ? null : sample.state;
  const v = numberOf(sample.state);
  if (v === null) return null;
  const unit = words(sample.attrs?.unit_of_measurement);
  if (field === 'speed' && unit === 'm/s') return v * 3.6;
  if (field === 'speed' && unit === 'mph') return v * 1.609344;
  if (['odometer', 'range', 'fuelRange'].includes(field) && unit === 'mi') return v * 1.609344;
  if (['odometer', 'range', 'fuelRange'].includes(field) && unit === 'm') return v / 1000;
  if (field === 'power' && unit === 'w' || ['charged', 'used'].includes(field) && unit === 'wh') return v / 1000;
  if (field.startsWith('tire') && unit === 'bar') return v * 100;
  if (field.startsWith('tire') && unit === 'psi') return v * 6.89476;
  if (field === 'inside' && unit === '°f') return (v - 32) * 5 / 9;
  return v;
}
export function position(lat: number | null, lon: number | null, at: number, coordinate: Point['coordinate']): Point | null {
  return lat === null || lon === null || !Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180 || (!lat && !lon) ? null : { at, lat, lon, coordinate };
}

// History frames are chronological. Only an actual position update inside the
// session counts; HA carries previous entity values through unrelated updates.
export function withChargePositions(charges: Charge[], frames: Frame[]): Charge[] {
  if (!charges.length || !frames.length) return charges;
  const points = frames.flatMap(f => {
    const p = f.data.position;
    if (!p || p.at !== f.at || drivingOf(f.data) === true ||
      !f.changed.some(key => key === 'tracker' || key === 'latitude' || key === 'longitude')) return [];
    return [p];
  });
  if (!points.length) return charges;
  return charges.map(row => {
    if (row.position && row.position.coordinate !== 'unknown') return row;
    let lo = 0, hi = points.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (points[mid].at < row.startedAt) lo = mid + 1;
      else hi = mid;
    }
    const end = row.endedAt ?? row.powerTimeline?.at(-1)?.at ?? row.startedAt;
    let fallback = row.position;
    for (let i = lo; i < points.length && points[i].at <= end; i++) {
      const p = points[i];
      if (p.at === end && row.endedAt !== null && end !== row.startedAt) break;
      if (p.coordinate !== 'unknown') return { ...row, position: p };
      fallback ??= p;
    }
    return fallback === row.position ? row : { ...row, position: fallback };
  });
}

export function framesOf(entries: Sample[], mapping: Mapping): Frame[] {
  const fieldsByEntity = new Map<string, Field[]>();
  for (const [field, binding] of Object.entries(mapping)) {
    const entity = entityIdOf(binding);
    if (entity) fieldsByEntity.set(entity, [...(fieldsByEntity.get(entity) ?? []), field as Field]);
  }
  const data: Reading = {};
  const frames: Frame[] = [];
  const seen = new Map<Field, number>();
  for (const item of entries) {
    const keys = fieldsByEntity.get(item.entity);
    if (!keys) continue;
    for (const key of keys) {
      const binding = mapping[key];
      if (typeof binding === 'object') {
        const value = item.attrs?.[binding.attribute];
        data[key] = missing.has(words(item.state)) || value == null ? null :
          binding.attribute === 'speed' || binding.attribute === 'battery_min_temp' ? numberOf(value) : typeof value === 'boolean' ? String(value) : null;
      } else data[key] = normalized(key, item);
      seen.set(key, item.at);
      if (key === 'tracker') {
        data.position = missing.has(words(item.state)) ? null :
          position(numberOf(item.attrs?.latitude), numberOf(item.attrs?.longitude), item.at, 'wgs84');
      }
      if (key === 'latitude' || key === 'longitude') {
        const latAt = seen.get('latitude'), lonAt = seen.get('longitude');
        data.position = latAt !== undefined && lonAt !== undefined && Math.abs(latAt - lonAt) < 60_000
          ? position(numberOf(data.latitude), numberOf(data.longitude), item.at, 'unknown') : null;
      }
    }
    const prev = frames.at(-1);
    if (prev?.at === item.at) {
      prev.data = { ...data };
      prev.changed.push(...keys);
    } else frames.push({ at: item.at, data: { ...data }, changed: [...keys] });
  }
  return frames;
}

export function batteryTemperatureSamples(frames: Frame[], start: number, end: number): MetricSample[] {
  return frames.filter(frame => frame.at >= start && frame.at <= end && frame.changed.includes('batteryMinTemp'))
    .map(frame => ({ at: frame.at, value: numberOf(frame.data.batteryMinTemp) }));
}

export function mergeTemperatureSamples(start: number, end: number, ...series: (MetricSample[] | undefined)[]) {
  const byTime = new Map<number, MetricSample>();
  for (const samples of series) {
    for (const sample of samples ?? []) {
      if (sample.at >= start && sample.at <= end && (sample.value !== null || !byTime.has(sample.at))) byTime.set(sample.at, sample);
    }
  }
  return [...byTime.values()].sort((a, b) => a.at - b.at);
}

export function lowestBatteryTemperature(frames: Frame[], start: number, end: number) {
  let lowest: number | null = null;
  for (const frame of frames) {
    if (frame.at < start || frame.at > end || !frame.changed.includes('batteryMinTemp')) continue;
    const temperature = numberOf(frame.data.batteryMinTemp);
    if (temperature !== null && (lowest === null || temperature < lowest)) lowest = temperature;
  }
  return lowest;
}

const diff = (start: unknown, end: unknown) => {
  const a = numberOf(start), b = numberOf(end);
  return a !== null && b !== null && b >= a ? b - a : null;
};
function activeValue(frame: Frame, kind: 'trip' | 'charge') {
  if (kind === 'trip') return drivingOf(frame.data);
  if (['off', '0', 'false', 'not_charging', '未充电'].includes(words(frame.data.charge))) return false;
  const state = chargeOf(frame.data.charge, frame.data.plug);
  return state === 'unknown' ? null : state === 'charging';
}

interface Segment { frames: Frame[]; start: number; end: number | null; partial: boolean; reconstructed?: boolean; formerIds?: string[] }

export const cloudSampleGap = 90_000;
export const cloudFrozenTime = 30 * 60_000;
export const parkingConfirmation = (frame: Frame) => Math.max(60_000, 3 * (frame.pollIntervalMs ?? 6000));
const maxOdometerJump = 1500;
const pluggedIn = (frame: Frame) => ['charging', 'plugged', 'done'].includes(String(frame.data.charge));

// Replay the LeapToHA trip lifecycle from this vehicle's stored reports. Sample gaps
// break a trace, whereas confirmed parking, plugging in and the frozen watchdog end a trip.
function splitCloudTrips(frames: Frame[], now?: number): Segment[] {
  const trips: Segment[] = [];
  let active: Segment | undefined;
  let previous: Frame | undefined;
  let baseline: Frame | undefined;
  let lastMovingAt = 0;
  let parkedSince: number | undefined;
  let meter: number | null = null;
  let outliers = 0;

  function finish(interrupted: boolean) {
    if (active) {
      active.end = lastMovingAt;
      active.partial ||= interrupted;
      trips.push(active);
    }
    active = undefined;
    parkedSince = undefined;
  }

  for (let frame of frames) {
    if (frame.tripBoundary) {
      finish(frame.tripBoundary === 'interrupted');
      if (frame.tripBoundary === 'parked') {
        if (pluggedIn(frame)) baseline = undefined;
        continue;
      }
      previous = baseline = undefined;
      meter = null;
      outliers = 0;
      continue;
    }
    // Empty markers in older databases carry no vehicle observation.
    if (frame.chargeOnly || !frame.changed.length || previous && frame.at <= previous.at) continue;
    if (previous && frame.at - previous.at > cloudFrozenTime) finish(true);
    const rawMeter = numberOf(frame.data.odometer);
    if (rawMeter !== null && rawMeter >= 0) {
      if (meter !== null && Math.abs(rawMeter - meter) > maxOdometerJump) {
        if (++outliers < 3) frame = { ...frame, data: { ...frame.data, odometer: null } };
        else {
          finish(true);
          baseline = undefined;
          meter = rawMeter;
          outliers = 0;
        }
      } else { meter = rawMeter; outliers = 0; }
    }
    const km = numberOf(frame.data.odometer);
    const driving = drivingOf(frame.data) === true;
    const plugged = !driving && pluggedIn(frame);
    if (active && parkedSince !== undefined && previous && frame.at - parkedSince >= parkingConfirmation(previous) && driving) finish(false);

    if (!active) {
      const delta = baseline && diff(baseline.data.odometer, km);
      if (baseline && delta != null && delta >= 1 && delta <= maxOdometerJump && !pluggedIn(baseline) && !plugged) {
        const before = socPercent(baseline.data.soc), after = socPercent(frame.data.soc);
        if (before === null || after === null || after <= before + .5) {
          trips.push({ frames: [baseline, frame], start: baseline.at, end: frame.at, partial: true, reconstructed: true });
        }
      }
      if (driving) {
        // LeapToHA uses the last trusted meter if the first driving frame lacks it.
        if (km === null && baseline && meter !== null) frame = { ...frame, data: { ...frame.data, odometer: meter } };
        active = { frames: [], start: frame.at, end: null, partial: !previous || drivingOf(previous.data) !== false };
      }
    }

    if (active) {
      if (driving && active.frames.length && previous && (frame.at - previous.at > cloudSampleGap || drivingOf(previous.data) !== true)) {
        (active.formerIds ??= []).push('live-' + frame.at);
      }
      active.partial ||= !!previous && frame.at - previous.at > cloudSampleGap;
      active.frames.push(frame);
      if (driving) {
        lastMovingAt = frame.at;
        parkedSince = undefined;
      } else {
        parkedSince ??= frame.at;
        if (plugged || frame.at - parkedSince >= parkingConfirmation(frame)) finish(false);
      }
    }
    if (km !== null && km >= 0) baseline = frame;
    else if (plugged) baseline = undefined;
    previous = frame;
  }
  if (active && now !== undefined && previous) {
    if (parkedSince !== undefined && now - parkedSince >= parkingConfirmation(previous)) finish(false);
    else if (now - previous.at > cloudFrozenTime) finish(true);
  }
  if (active) trips.push({ ...active, partial: true });
  return trips;
}

function split(frames: Frame[], kind: 'trip' | 'charge') {
  const result: Segment[] = [];
  let active: Segment | null = null;
  let previous: boolean | null = null;
  for (const frame of frames) {
    if (frame.tripBoundary) {
      if (kind === 'trip') {
        if (active) {
          active.end = active.frames.at(-1)!.at;
          active.partial ||= frame.tripBoundary === 'interrupted';
          result.push(active);
          active = null;
        }
        previous = null;
      }
      continue;
    }
    if (kind === 'trip' && frame.chargeOnly) continue;
    const status = activeValue(frame, kind);
    if (active) active.frames.push(frame);
    if (!active && status === true) {
      active = { frames: [frame], start: frame.at, end: null, partial: previous !== false };
    } else if (active && status !== true) {
      active.end = status === false ? frame.at : null;
      active.partial ||= status === null;
      result.push(active);
      active = null;
    }
    previous = status;
  }
  if (active) result.push({ ...active, partial: true });
  return result;
}

function samples(frames: Frame[], field: 'speed' | 'power') {
  return frames.filter(f => f.changed.includes(field)).flatMap(f => {
    const value = numberOf(f.data[field]);
    return value === null ? [] : [{ at: f.at, value }];
  });
}
export function kmBetween(a: Pick<Point, 'lat' | 'lon'>, b: Pick<Point, 'lat' | 'lon'>) {
  const rad = Math.PI / 180;
  const d = Math.sin((b.lat - a.lat) * rad / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin((b.lon - a.lon) * rad / 2) ** 2;
  return 12742 * Math.asin(Math.min(1, Math.sqrt(d)));
}

function cloudOdometerDistance(frames: Frame[]) {
  let first: number | null = null, last: number | null = null;
  let count = 0;
  for (const frame of frames) {
    const km = numberOf(frame.data.odometer);
    if (km === null || km < 0) continue;
    if (last !== null && km < last) return null;
    first ??= km;
    last = km;
    count++;
  }
  return count >= 2 ? diff(first, last) : null;
}

function tripFrom(segment: Segment, id: string, source: 'ha' | 'phone' | 'live', capacityKwh: number | null = null): Trip {
  const { frames, start, end, partial } = segment;
  const first = frames[0]?.data ?? {};
  const last = frames.at(-1)?.data ?? {};
  const trace = source === 'live' && end !== null ? frames.filter(f => f.at <= end) : frames;
  const points = segment.reconstructed ? [] : trace.flatMap(f => f.changed.some(key => ['tracker', 'latitude', 'longitude'].includes(key)) && f.data.position ? [f.data.position] : []);
  const route = source === 'live' ? points.map((p, i) => i > 0 && p.at - points[i - 1].at > cloudSampleGap ? { ...p, gapBefore: true } : p) : points;
  const speeds = segment.reconstructed ? [] : samples(trace, 'speed');
  const usableRoute = route.length > 1 && route.every((p, index) =>
    !p.gapBefore && p.coordinate === route[0].coordinate && (index === 0 || p.at - route[index - 1].at < 180_000));
  const odometer = source === 'live' ? cloudOdometerDistance(frames) ??
    (frames.length === 1 && end === start ? diff(first.odometer, last.odometer) : null) :
    frames.length > 1 ? diff(first.odometer, last.odometer) : null;
  const fullOdometer = odometer !== null && diff(first.odometer, last.odometer) === odometer;
  const gpsKm = usableRoute ? route.slice(1).reduce((km, p, i) => km + kmBetween(route[i], p), 0) : null;
  const integerCrossing = source === 'live' && gpsKm !== null && gpsKm > 0 && odometer !== null &&
    (odometer < 1 || odometer === 1 && gpsKm < .5);
  const distanceKm = integerCrossing ? gpsKm : fullOdometer ? odometer : gpsKm ?? odometer;
  const avg = distanceKm !== null && end !== null && end > start ? distanceKm * 3_600_000 / (end - start) : null;
  const usableTime = !segment.reconstructed || avg !== null && avg >= 8 && avg <= 160;
  const durationMin = end !== null && usableTime ? (source === 'live' ? (end - start) / 60_000 : Math.round((end - start) / 60_000)) : null;
  const socStart = socPercent(first.soc);
  const socEnd = socPercent(last.soc) ?? (source === 'live' ?
    frames.slice(1).reduceRight<number | null>((latest, frame) => latest ?? socPercent(frame.data.soc), null) : null);
  const energyKwh = source === 'live' ? estimateSocEnergy(socEnd, socStart, capacityKwh) : diff(first.used, last.used);
  const socSamples = trace.filter(frame => frame.changed.includes('soc')).map(frame => ({ at: frame.at, value: socPercent(frame.data.soc) }));
  return {
    id, startedAt: start, endedAt: end, source, distanceKm, durationMin, energyKwh,
    efficiency: distanceKm && (source !== 'live' || distanceKm >= 0.5) && energyKwh !== null ? 100 * energyKwh / distanceKm : null,
    avgSpeedKmh: usableTime ? avg : null, ...(segment.reconstructed && { reconstructed: true }),
    ...(source === 'live' && { startOdometerKm: numberOf(first.odometer), endOdometerKm: numberOf(last.odometer), lastSampleAt: frames.at(-1)?.at }),
    ...(segment.formerIds && { formerIds: segment.formerIds }),
    pointCount: route.length || null, route, speeds, complete: !partial && (fullOdometer || usableRoute),
    gap: partial || !route.length || !usableRoute,
    socStart, socEnd, socSamples, batteryTemperatures: batteryTemperatureSamples(frames, start, end ?? Infinity),
    rangeStartKm: numberOf(first.range), rangeEndKm: numberOf(last.range),
    rangeComparable: first.rangeBasis === last.rangeBasis,
  };
}

function chargeFrom(segment: Segment, id: string, source: 'ha' | 'phone' = 'ha'): Charge {
  const first = segment.frames[0]?.data ?? {}, last = segment.frames.at(-1)?.data ?? {};
  const types = new Set(segment.frames.map(f => words(f.data.chargeType)).filter(Boolean).flatMap(t =>
    ['ac', 'slow', '交流', '慢充'].includes(t) ? ['ac'] as const : ['dc', 'quick', '直流', '快充'].includes(t) ? ['dc'] as const : []));
  const powers = samples(segment.frames, 'power');
  let kwh = diff(first.charged, last.charged);
  if (kwh === null && powers.length > 1 && !segment.partial && powers[0].at - segment.start < 120_000
    && segment.end !== null && segment.end - powers.at(-1)!.at < 120_000) {
    let estimated = 0;
    let covered = true;
    for (let i = 1; i < powers.length; i++) {
      const dt = powers[i].at - powers[i - 1].at;
      if (dt > 180_000) covered = false;
      estimated += Math.max(0, powers[i - 1].value) * dt / 3_600_000;
    }
    if (covered) kwh = estimated;
  }
  return {
    id, startedAt: segment.start, endedAt: segment.end, source, type: types.size === 2 ? 'mixed' : [...types][0] ?? 'unknown',
    socSamples: segment.frames.filter(frame => frame.changed.includes('soc')).map(frame => ({ at: frame.at, value: socPercent(frame.data.soc) })),
    batteryTemperatures: batteryTemperatureSamples(segment.frames, segment.start, segment.end ?? Infinity),
    kwh, gridKwh: null, cost: null, socStart: numberOf(first.soc), socEnd: numberOf(last.soc), partial: segment.partial || kwh === null, powers,
  };
}
export function deriveTrips(frames: Frame[], source: 'ha' | 'phone' | 'live', capacityKwh: number | null = null, now?: number) {
  const segments = source === 'live' ? splitCloudTrips(frames, now) : split(frames, 'trip');
  const trips = segments.map(s => tripFrom(s, s.reconstructed ? 'live-gap-' + s.start + '-' + s.end : source + '-' + s.start, source, capacityKwh));
  return (source === 'live' ? trips.filter(t => t.endedAt === null || t.distanceKm === null || t.distanceKm >= .2) : trips).reverse();
}
export function deriveHistory(frames: Frame[], source: 'ha' | 'phone' = 'ha') {
  return {
    trips: deriveTrips(frames, source),
    charges: split(frames, 'charge').map(s => chargeFrom(s, source + '-' + s.start, source)).reverse(),
  };
}

export function deriveArchive(archive: Archive) {
  const observations = Object.values(archive.observations).sort((a, b) => a.received_at_ms - b.received_at_ms);
  const frames = new Map<string, Frame>();
  for (const raw of observations) {
    const s = raw.signals_raw;
    const at = raw.received_at_ms;
    const v = numberOf(s['1177'] ?? s['chargeVoltage'] ?? s['legacy_voltage']);
    const a = numberOf(s['1178'] ?? s['chargeCurrent'] ?? s['legacy_current']);
    const charging = s.charge_status ?? s.legacy_charge_state;
    const plug = stateOf(s['47'] ?? s.charge_plug ?? s['1149'] ?? s.charge_connection);
    const speed = numberOf(s['1319'] ?? s.speed ?? s.legacy_speed_kmh);
    const type = s.legacy_charge_type ?? s.charge_type;
    const data: Reading = {
      speed,
      odometer: numberOf(s['1318'] ?? s.totalMileage ?? s.odometer ?? s.legacy_odometer_km),
      soc: numberOf(s['100003'] ?? s['1204'] ?? s.soc ?? s.legacy_soc_percent),
      charge: typeof charging === 'string' && chargeOf(charging) !== 'unknown' ? charging :
        plug === false ? 'unplugged' : plug && v !== null && a !== null && v > 0 && a > 0 && (speed ?? 0) < 1 ? 'charging' : null,
      plug: plug === true ? 'on' : plug === false ? 'off' : null,
      power: v !== null && a !== null && a >= 0 ? v * a / 1000 : numberOf(s.legacy_power_kw),
      chargeType: typeof type === 'string' ? type : stateOf(s['1197']) === true ? 'dc' : null,
      position: position(numberOf(s['3'] ?? s.latitude ?? s.legacy_latitude_wgs84),
        numberOf(s['2'] ?? s.longitude ?? s.legacy_longitude_wgs84), at, raw.coordinate_system),
    };
    const changed: Field[] = ['tracker', 'speed', 'power'];
    if ('1182' in s) { data.batteryMinTemp = numberOf(s['1182']); changed.push('batteryMinTemp'); }
    frames.set(raw.observation_id, { at, data, changed });
  }
  const fallback = deriveHistory([...frames.values()]);
  const trips: Trip[] = [], charges: Charge[] = [];
  for (const [key, record] of Object.entries(archive.records)) {
    const membership = archive.membership[key];
    const references = membership?.observation_ids ?? record.observation_refs ?? [];
    const linked = references.flatMap(id => frames.get(id) ?? []).sort((a, b) => a.at - b.at);
    const start = numberOf(record.boundary_hint?.started_at_ms) ?? linked[0]?.at;
    if (start === undefined) continue;
    const end = record.phase === 'recording' ? null : numberOf(record.boundary_hint?.ended_at_ms) ?? linked.at(-1)?.at ?? null;
    const gap = Object.values(archive.events).some(event => event.occurred_at_ms && event.occurred_at_ms >= start
      && event.occurred_at_ms <= (end ?? Date.now()) && ['poll_failed', 'collector_stopped', 'vehicle_unavailable'].includes(event.event ?? ''));
    const segment = { frames: linked, start, end, partial: record.phase !== 'completed' || membership?.coverage !== 'complete' || linked.length !== references.length || gap };
    if (record.kind === 'trip') trips.push({ ...tripFrom(segment, 'archive-t-' + record.record_id, 'ha'), group: 'archive' });
    else charges.push({ ...chargeFrom(segment, 'archive-c-' + record.record_id), group: 'archive' });
  }
  const overlaps = (a: { startedAt: number; endedAt: number | null }, b: { startedAt: number; endedAt: number | null }) =>
    a.startedAt <= (b.endedAt ?? Infinity) && b.startedAt <= (a.endedAt ?? Infinity);
  return {
    trips: [...trips, ...fallback.trips.filter(r => !trips.some(t => overlaps(t, r)))].sort((a, b) => b.startedAt - a.startedAt),
    charges: [...charges, ...fallback.charges.filter(r => !charges.some(t => overlaps(t, r)))].sort((a, b) => b.startedAt - a.startedAt),
  };
}

export const localDay = (time: number) => {
  const d = new Date(time);
  return [d.getFullYear(), d.getMonth() + 1, d.getDate()].map((v, i) => String(v).padStart(i ? 2 : 4, '0')).join('-');
};
export function dailyEnergy(frames: Frame[], days: number, now = Date.now()): EnergyDay[] {
  const values = new Map<string, { km?: number; kwh?: number }>();
  for (const [field, key] of [['odometer', 'km'], ['used', 'kwh']] as const) {
    let prev: { day: string; value: number } | null = null;
    for (const frame of frames) {
      if (!frame.changed.includes(field)) continue;
      const value = numberOf(frame.data[field]);
      const day = localDay(frame.at);
      if (value !== null && prev !== null && prev.day === day && value >= prev.value) {
        const row = values.get(day) ?? {};
        row[key] = (row[key] ?? 0) + value - prev.value;
        values.set(day, row);
      }
      prev = value === null ? null : { day, value };
    }
  }
  return Array.from({ length: days }, (_, index) => {
    const d = new Date(now);
    d.setDate(d.getDate() - (days - index - 1));
    const day = localDay(+d);
    const km = values.get(day)?.km ?? null, kwh = values.get(day)?.kwh ?? null;
    return { day, km, kwh, efficiency: km && kwh !== null ? kwh * 100 / km : null };
  });
}
