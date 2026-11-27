import { mergeTemperatureSamples, numberOf } from '../ha/measurements.ts';
import type { Charge, Frame, MetricSample } from '../ha/measurements.ts';
import { defaultChargeEfficiency, estimateSocEnergy, socPercent } from '../vehicleEnergy.ts';
import type { VehicleEnergySettings } from '../vehicleEnergy.ts';

const maxGap = 15 * 60_000;
const matchTolerance = 30 * 60_000;
const maxPower = 400;

type Charging = {
  timeline: MetricSample[];
  temperatures: MetricSample[];
  position?: Charge['position'];
  minRecordedBatteryTempC?: number;
  type: 'ac' | 'dc' | 'unknown';
  partial: boolean;
};

export function sampledCharges(frames: Frame[], capacityKwh: number | null, now: number): Charge[] {
  const charges: Charge[] = [];
  let active: Charging | undefined;
  let previous: boolean | null = null;
  function finish(session: Charging, ended: boolean, partial: boolean) {
    const first = session.timeline[0], last = session.timeline.at(-1)!;
    const socStart = first.soc ?? null, socEnd = last.soc ?? null;
    const estimate = estimateSocEnergy(socStart, socEnd, capacityKwh);
    const kwh = estimate !== null && estimate <= maxPower * (last.at - first.at) / 3_600_000 ? estimate : null;
    charges.push({
      id: 'sampled-charge-' + first.at, source: 'live', type: session.type, startedAt: first.at,
      endedAt: ended ? last.at : null, active: !ended, partial: session.partial || partial,
      kwh, socStart, socEnd, gridKwh: null, cost: null, energyBasis: kwh === null ? undefined : 'soc',
      batteryTemperatures: session.temperatures, minRecordedBatteryTempC: session.minRecordedBatteryTempC, ...(session.position && { position: session.position }),
      powerTimeline: session.timeline, powers: session.timeline.flatMap(({ at, value }) => value === null ? [] : [{ at, value }]),
    });
  }
  for (const frame of frames) {
    if (frame.chargeBoundary) {
      if (active) finish(active, true, true);
      active = undefined;
      previous = null;
    }
    // The synthetic trip gap markers and frames from older builds have no charge observation.
    if (!frame.changed.includes('charge')) continue;
    if (active && frame.at - active.timeline.at(-1)!.at > maxGap) {
      finish(active, true, true);
      active = undefined;
      previous = null;
    }
    const { motion, charge, chargeType } = frame.data;
    const status = motion === 'driving' || charge === 'plugged' || charge === 'unplugged' || charge === 'done' ? false :
      charge === 'charging' ? true : null;
    if (status === true) {
      const kind = chargeType === 'ac' || chargeType === 'dc' ? chargeType : 'unknown';
      if (active && active.type !== 'unknown' && kind !== 'unknown' && active.type !== kind) {
        finish(active, true, false);
        active = undefined;
        previous = false;
      }
      active ??= { timeline: [], temperatures: [], type: kind, partial: previous !== false };
      if (!active.position && frame.data.position?.at === frame.at) active.position = frame.data.position;
      if (active.type === 'unknown') active.type = kind;
      const temperature = numberOf(frame.data.batteryMinTemp);
      if (frame.changed.includes('batteryMinTemp')) {
        active.temperatures.push({ at: frame.at, value: temperature });
        if (temperature !== null) active.minRecordedBatteryTempC = Math.min(active.minRecordedBatteryTempC ?? temperature, temperature);
      }
      const power = numberOf(frame.data.power);
      active.timeline.push({ at: frame.at, value: power !== null && power > 0 && power <= maxPower ? power : null, soc: socPercent(frame.data.soc) });
    } else if (active) {
      finish(active, true, status === null);
      active = undefined;
    }
    previous = status;
  }
  if (active) {
    const expired = now - active.timeline.at(-1)!.at > maxGap;
    finish(active, expired, expired);
  }
  return charges;
}

export function reconcileCharges(official: Charge[], sampled: Charge[], settings: VehicleEnergySettings) {
  const candidates: { sample: Charge; record: Charge; score: number }[] = [];
  for (const sample of sampled) {
    if (sample.endedAt === null) continue;
    const end = Math.max(sample.startedAt + 1, sample.endedAt);
    for (const record of official) {
      if (record.endedAt === null || sample.type !== 'unknown' && record.type !== 'unknown' && sample.type !== record.type) continue;
      const overlap = Math.min(end, record.endedAt) - Math.max(sample.startedAt, record.startedAt);
      if (overlap <= 0) continue;
      const shorter = Math.min(end - sample.startedAt, record.endedAt - record.startedAt);
      const startGap = Math.abs(sample.startedAt - record.startedAt);
      if (overlap < Math.min(matchTolerance, shorter / 2) && startGap > matchTolerance) continue;
      candidates.push({ sample, record, score: overlap / shorter - Math.min(startGap, matchTolerance) / (4 * matchTolerance) });
    }
  }
  const matched = new Map<string, Charge>();
  const used = new Set<string>();
  for (const { sample, record } of candidates.sort((a, b) => b.score - a.score)) {
    if (matched.has(record.id) || used.has(sample.id)) continue;
    used.add(sample.id);
    matched.set(record.id, sample);
  }
  const joined: Charge[] = official.map(record => {
    const sample = matched.get(record.id);
    return {
      ...record,
      position: record.position ?? (sample?.position && record.endedAt !== null && sample.position.at >= record.startedAt && sample.position.at < record.endedAt ? sample.position : undefined),
      sampledId: sample?.id,
      batteryTemperatures: mergeTemperatureSamples(record.startedAt, record.endedAt ?? Infinity, sample?.batteryTemperatures, record.batteryTemperatures),
      type: record.type === 'unknown' && sample ? sample.type : record.type,
      kwh: record.kwh ?? sample?.kwh ?? null,
      energyBasis: record.kwh !== null ? 'official' : sample?.energyBasis,
      partial: record.kwh === null && (!sample || sample.partial || sample.kwh === null),
      socStart: record.socStart ?? sample?.socStart ?? null,
      socEnd: record.socEnd ?? sample?.socEnd ?? null,
      powers: sample?.powers ?? record.powers,
      powerTimeline: sample?.powerTimeline ?? record.powerTimeline,
    };
  });
  return [...joined, ...sampled.filter(sample => !used.has(sample.id))].map(row => {
    const efficiency = row.type === 'ac' ? settings.acEfficiency : row.type === 'dc' ? settings.dcEfficiency : defaultChargeEfficiency;
    return { ...row, gridKwh: row.kwh === null ? null : row.kwh * 100 / efficiency };
  }).sort((a, b) => b.startedAt - a.startedAt);
}
