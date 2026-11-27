import { cloudFrozenTime, cloudSampleGap, drivingOf, numberOf, parkingConfirmation, position } from '../ha/measurements.ts';
import { recordingTime } from './polling.ts';
import type { Charge, Frame, Reading } from '../ha/measurements.ts';
import type { CarState } from '../types.ts';
import { socPercent } from '../vehicleEnergy.ts';
import { displayedRange } from '../powertrain.ts';

const DAY = 86_400_000;
const CHINA = 8 * 3_600_000;
export const cloudDay = (at: number) => new Date(at + CHINA).toISOString().slice(0, 10);
export const dayStart = (at: number) => Math.floor((at + CHINA) / DAY) * DAY - CHINA;
export const vehicleTimestamp = (value: unknown) => {
  const n = numberOf(value);
  if (n === null || n <= 0) return null;
  const ms = Math.trunc(n < 10_000_000_000 ? n * 1000 : n);
  return ms >= 1_000_000_000_000 && ms <= Date.now() + 60_000 ? ms : null;
};

export function energyParts(data: Record<string, unknown>) {
  const fields = [data.driverEC, data.acEC, data.otherEC].map(numberOf);
  const [drive, climate, other] = fields.map(n => n !== null && n >= 0 ? n : null);
  const total = drive === null || climate === null || other === null ? null : drive + climate + other;
  return { drive, climate, other, total: total !== null && Number.isFinite(total) ? total : null };
}

export function officialCharge(row: Record<string, unknown>, includeLocation = false): Charge | null {
  const start = numberOf(row.chargeGunStartTs), end = numberOf(row.chargeGunEndTs);
  if (start === null || end === null || start < 1e12 || !(end > start)) return null;
  const type = String(row.chargeType ?? '').trim().toUpperCase();
  const energy = numberOf(row.chargeInEnergy);
  const kwh = energy !== null && energy >= 0 ? energy : null;
  // The charging history response does not specify a coordinate system.
  const point = includeLocation && position(numberOf(row.chargeStartLatitude), numberOf(row.chargeStartLongitude), start, 'unknown');
  return { id: 'official-' + start + '-' + end, source: 'live', startedAt: start, endedAt: end,
    kwh, gridKwh: null, type: type === 'SLOW' || type === '1' ? 'ac' : type === 'QUICK' || type === '2' ? 'dc' : 'unknown',
    partial: kwh === null, powers: [], socStart: null, socEnd: null, cost: null, ...(point ? { position: point } : {}),
    ...(kwh === null ? {} : { energyBasis: 'official' as const }) };
}

export function validFrameTime(at: number | null | undefined, now = Date.now()): at is number {
  return typeof at === 'number' && Number.isFinite(at) && at > 0 && now - at <= cloudFrozenTime && at <= now + 60_000;
}

export function cloudFrame(state: CarState, location: boolean, now = Date.now(), pollIntervalMs?: number): Frame | null {
  const at = recordingTime(state);
  if (!validFrameTime(at, now)) return null;
  const { latitude: lat, longitude: lon } = state;
  const position: Reading['position'] = location && typeof lat === 'number' && typeof lon === 'number' &&
    Math.abs(lat) <= 90 && Math.abs(lon) <= 180 && (lat !== 0 || lon !== 0) ? { at, lat, lon, coordinate: 'gcj02' } : null;
  const ranges = state.rangeReadings;
  const range = displayedRange(ranges?.evidence ? 'reev' : 'bev', ranges);
  const data: Reading = { motion: state.isDriving === true ? 'driving' : state.parked ? 'parked' : null,
    speed: state.isDriving === false && !state.parked ? null : state.speedKmh, odometer: state.odometer, position,
    soc: socPercent(state.soc), range: state.rangeKm,
    rangeBasis: range.source === 'missing' ? undefined : range.source === 'live' ? 'live' : ranges?.mode + ':' + range.source,
    charge: state.charging, chargeType: state.chargeType, power: state.chargingPowerKw,
    batteryMinTemp: state.batteryMinTempC };
  return { at, data, ...(pollIntervalMs && { pollIntervalMs }), changed: ['motion', 'speed', 'odometer', 'tracker', 'soc', 'range', 'charge', 'chargeType', 'power', 'batteryMinTemp'] };
}

// A sleeping vehicle can repeat the same timestamp while its gear or plug state changes.
// Persist only the confirmed stop, so repeated replies never create track or energy samples.
export class RepeatedReportParking {
  private at = 0;
  private stoppedSince: number | undefined;
  private confirmed = false;

  observe(frame: Frame, receivedAt: number): Frame | undefined {
    if (frame.at < this.at) return;
    const driving = drivingOf(frame.data);
    const plugged = driving !== true && ['charging', 'plugged', 'done'].includes(String(frame.data.charge));
    if (frame.at > this.at) {
      this.at = frame.at;
      this.stoppedSince = driving === false || plugged ? receivedAt : undefined;
      this.confirmed = plugged;
      return;
    }
    if (driving === true || driving === null && !plugged) { this.stoppedSince = undefined; return; }
    this.stoppedSince ??= receivedAt;
    if (!this.confirmed && (plugged || receivedAt - this.stoppedSince >= parkingConfirmation(frame))) {
      this.confirmed = true;
      return { at: this.at + 1, tripBoundary: 'parked', changed: [], data: plugged ? { charge: frame.data.charge } : {} };
    }
  }
}

export function appendCloudFrame(previous: Frame[], frame: Frame): Frame[] {
  const last = previous.at(-1);
  if (last?.at === frame.at && last.tripBoundary && !frame.tripBoundary) return mergeTripFrames(previous, [frame]);
  if (last && last.at >= frame.at) return previous;
  const sameIdle = (f: Frame | undefined) => f && f.data.motion === frame.data.motion && f.data.charge === frame.data.charge &&
    f.data.odometer === frame.data.odometer && f.chargeOnly === frame.chargeOnly;
  const compact = last && frame.at - last.at <= cloudSampleGap && frame.data.motion === 'parked' &&
    ['done', 'plugged', 'unplugged'].includes(String(frame.data.charge)) && sameIdle(last) && sameIdle(previous.at(-2));
  const history = compact ? previous.slice(0, -1) : previous;
  return [...history.filter(f => f.at >= frame.at - 90 * DAY), frame].slice(-40_000);
}

// The native queue can replay a committed batch, or deliver it behind newer foreground charge samples.
export function mergeTripFrames(previous: Frame[], batch: Frame[]): Frame[] {
  const rows = new Map<number, Frame>();
  const boundaries = new Map<number, Frame>();
  for (const frame of [...previous, ...batch]) {
    if (frame.tripBoundary) {
      if (frame.tripBoundary !== 'parked' || !boundaries.has(frame.at)) boundaries.set(frame.at, frame);
    }
    else if (frame.changed.length && (!frame.chargeOnly || !rows.has(frame.at))) rows.set(frame.at, frame);
  }
  const sorted = [...rows.values(), ...boundaries.values()].sort((a, b) => a.at - b.at || Number(!!b.tripBoundary) - Number(!!a.tripBoundary));
  const cutoff = (sorted.at(-1)?.at ?? 0) - 90 * DAY;
  return sorted.filter(frame => frame.at >= cutoff).slice(-40_000);
}
