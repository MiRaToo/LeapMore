import { localDay } from './ha/measurements';
import type { Charge, Point, Trip } from './ha/measurements';
import type { EnergyDay, Vehicle } from './types';

export const demoVehicles: Vehicle[] = [
  { id: 'demo-c10', vin: 'DEMO••8821', nickname: '我的 C10', model: 'C10', year: 2026, declaredPowertrain: 'bev', source: 'fixture' },
  { id: 'demo-b10', vin: 'DEMO••3106', nickname: '家里的 B10', model: 'B10', year: 2025, declaredPowertrain: 'bev', source: 'fixture' },
];
export const haVehicle: Vehicle = { id: 'ha-local', vin: '', model: 'C10', nickname: '我的车辆', year: 0, declaredPowertrain: 'bev', source: 'ha' };
export const demoLocation: Point = { at: Date.now() - 120_000, lat: 31.2218, lon: 121.5443, coordinate: 'gcj02' };
export const demoTires = [240, 240, 230, 230];

export function demoEnergy(days: number): EnergyDay[] {
  const sample = [24.5, 16.4, 42.2, 11.4, 33.1, 57.3, 26.8];
  return Array.from({ length: days }, (_, i) => {
    const date = new Date();
    date.setDate(date.getDate() - days + i + 1);
    const km = sample[(7 * days + i - days + 7) % 7];
    const efficiency = 12.1 + (i % 6) * .63;
    return { day: localDay(+date), km, kwh: km * efficiency / 100, efficiency };
  });
}

const at = (days: number, hour: number, min: number) => {
  const date = new Date();
  date.setDate(date.getDate() - days);
  return date.setHours(hour, min, 0, 0);
};

function demoTrip(id: string, startedAt: number, durationMin: number, distanceKm: number, active = false, currentSoc?: number | null): Trip {
  const count = Math.max(12, Math.ceil(durationMin));
  const drop = Math.round(distanceKm * 2) / 10;
  const socEnd = currentSoc ?? 78 - drop;
  const socStart = Math.min(100, socEnd + drop);
  const duration = durationMin * 60_000;
  const timestamps = Array.from({ length: count + 1 }, (_, i) => startedAt + Math.round(i * duration / count));
  const route = timestamps.map((at, i) => {
    const t = i / count;
    return { ...demoLocation, at, lat: demoLocation.lat - .011 + .018 * t,
      lon: demoLocation.lon - .028 + .028 * t + .002 * Math.sin(t * 5 * Math.PI) };
  });
  return {
    id, startedAt, endedAt: active ? null : startedAt + duration, durationMin, distanceKm,
    energyKwh: distanceKm * .142, efficiency: 14.2, avgSpeedKmh: distanceKm / durationMin * 60, pointCount: route.length,
    source: 'phone', complete: !active, gap: false, route, socStart, socEnd,
    speeds: timestamps.map((at, i) => ({ at, value: [5, 6, 7].includes(i) || (!active && i === count) ? 0 :
      i === count ? 48 : Math.round(18 + Math.abs(Math.sin(i * .32) * 45)) })),
    batteryTemperatures: timestamps.map((at, i) => ({ at, value: Math.round(155 + 36 * i / count + 4 * Math.sin(i / 5)) / 10 })),
    socSamples: timestamps.map((at, i) => ({ at, value: Math.round((socStart + (socEnd - socStart) * i / count) * 10) / 10 })),
    rangeStartKm: 305, rangeEndKm: 305 - Math.ceil(distanceKm * 1.22),
  };
}

export function demoActiveTrip(soc: number | null, range: number | null, now = Date.now()) {
  const trip = demoTrip('demo-active-trip', now - 1_140_000, 19, 12.4, true, soc);
  return range === null ? trip : { ...trip, rangeStartKm: range + 16, rangeEndKm: range };
}

export function demoActiveCharge(soc: number | null, power: number | null, now = Date.now()): Charge {
  const startedAt = now - 480_000;
  const kwh = power === null ? null : power * 8 / 60;
  const startSoc = soc === null || kwh === null ? null : Math.max(0, soc - kwh / 55 * 100);
  const powerTimeline = Array.from({ length: 9 }, (_, i) => ({ at: startedAt + i * 60_000,
    value: power, soc: startSoc === null || soc === null ? null : startSoc + (soc - startSoc) * i / 8 }));
  return { id: 'demo-active-charge', source: 'phone', startedAt, endedAt: null, active: true, type: 'ac',
    position: { ...demoLocation, at: startedAt }, kwh, gridKwh: null, cost: null, partial: false,
    batteryTemperatures: powerTimeline.map(({ at }, i) => ({ at, value: Math.round(176 + i * 1.5) / 10 })),
    socStart: startSoc, socEnd: soc, powers: powerTimeline.flatMap(({ at, value }) => value === null ? [] : [{ at, value }]), powerTimeline };
}

export function demoRecords() {
  const now = Date.now();
  const trips: Trip[] = [[0, 18, 32, 12.6, 34], [0, 8, 12, 18.3, 42], [1, 20, 14, 23.4, 55],
    [9, 8, 40, 16.7, 28], [42, 12, 15, 62.6, 78], [370, 14, 10, 38.1, 51]].map(([days, hour, min, distanceKm, durationMin], i) => {
    const startedAt = Math.min(at(days, hour, min), now - (i * 55 + 9 + durationMin) * 60_000);
    return demoTrip('demo-trip-' + i, startedAt, durationMin, distanceKm);
  });
  const charges: Charge[] = [[0, 19, 24, 34.8, 55], [2, 1, 5, 21.4, 240],
    [12, 22, 15, 23.2, 255], [54, 21, 6, 19.7, 201], [372, 23, 17, 26.1, 262]].map(([days, hour, min, kwh, duration], i) => {
    const startedAt = Math.min(at(days, hour, min), now - (duration + 12) * 60_000);
    const powerTimeline = Array.from({ length: 21 }, (_, index) => ({ at: startedAt + index * duration * 3000,
      value: i ? 6.3 - index * .06 : 55 - index * 1.4, soc: Math.round(32 + index * 53 / 20) }));
    return { id: 'demo-charge-' + i, startedAt, endedAt: startedAt + duration * 60_000, source: 'phone', type: i ? 'ac' : 'dc',
      position: { ...demoLocation, at: startedAt, lon: demoLocation.lon + (i ? .006 : 0) },
      kwh, gridKwh: null, socStart: 32, socEnd: 85, cost: null, partial: false, minRecordedBatteryTempC: i ? 17 : 21,
      powers: powerTimeline, powerTimeline,
      batteryTemperatures: powerTimeline.map(({ at }, p) => ({ at, value: (i ? 17 : 21) + Math.round(30 * Math.sin(p / 12)) / 10 })),
    };
  });
  return { trips, charges };
}
