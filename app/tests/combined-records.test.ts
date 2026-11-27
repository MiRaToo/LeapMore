import assert from 'node:assert/strict';
import { test } from 'node:test';
import { combineCharges, combineTrips } from '../src/data/combinedRecords.ts';
import type { Charge, Trip } from '../src/data/ha/measurements.ts';

const minute = 60_000;
const base = 1_800_000_000_000;
const trip = (id: string, source: Trip['source'], from: number, to: number | null): Trip => ({
  id, source, startedAt: base + from * minute, endedAt: to === null ? null : base + to * minute,
  distanceKm: 4, durationMin: null, energyKwh: 1, efficiency: null, avgSpeedKmh: null,
  pointCount: null, complete: to !== null, gap: false, route: [], speeds: [],
});
const charge = (id: string, source: Charge['source'], from: number, to: number, type: Charge['type']): Charge => ({
  id, source, type, startedAt: base + from * minute, endedAt: base + to * minute,
  kwh: source === 'ha' ? 20 : 18, gridKwh: null, socStart: 27, socEnd: 68, cost: null, partial: false, powers: [],
});

test('HA trip replaces overlapping phone fragments while keeping separately recorded drives', () => {
  const phoneOnly = trip('live-older', 'live', 0, 12);
  const after = trip('live-next', 'live', 36, 41);
  const fragments = [trip('live-part-1', 'live', 14, 21), trip('live-part-2', 'live', 22, 35)];
  const master = trip('ha-trip-master', 'ha', 13, 36);
  const rows = combineTrips([phoneOnly, after, ...fragments], [master]);
  assert.deepEqual(rows.trips.map(row => row.id), [after.id, master.id, phoneOnly.id]);
  assert.deepEqual(rows.aliases.get(master.id), fragments.map(row => row.id));
  assert.deepEqual(combineTrips([phoneOnly, after, ...fragments], []).trips.length, 4);
});

test('one phone meter window spanning multiple HA drives counts their union once across syncs', () => {
  const phone = { ...trip('live-gap', 'live', 0, 35), reconstructed: true, distanceKm: 14,
    startOdometerKm: 5000, endOdometerKm: 5014 };
  const first = { ...trip('ha-a', 'ha', 5, 14), startOdometerKm: 5000, endOdometerKm: 5006, distanceKm: 6 };
  const second = { ...trip('ha-b', 'ha', 18, 32), startOdometerKm: 5006, endOdometerKm: 5014, distanceKm: 8 };
  const partial = combineTrips([phone], [first]);
  assert.equal(partial.trips.reduce((total,row) => total + row.distanceKm!, 0), 14);
  const leftover = partial.trips.find(row => row.source === 'live')!;
  assert.deepEqual([leftover.distanceKm, leftover.energyKwh, leftover.durationMin, leftover.route.length], [8,null,null,0]);
  for (const remote of [[first, second], [second, first, first]]) {
    const merged = combineTrips([phone, phone], remote);
    assert.deepEqual(merged.trips.map(row => [row.id, row.distanceKm]), [['ha-b', 8], ['ha-a', 6]]);
  }
  assert.deepEqual(combineTrips([phone], []).trips, [phone]);
  const cached = combineTrips([phone], [{ ...first, startOdometerKm: undefined, endOdometerKm: undefined }]);
  assert.deepEqual(cached.trips.map(row => row.distanceKm), [6,8]);
});

test('partially overlapping meter intervals preserve uncovered kilometres and distinguish adjacent drives', () => {
  const local = { ...trip('live-trip', 'live', 0, 12), startOdometerKm: 100, endOdometerKm: 110, distanceKm: 10 };
  const ha = { ...trip('ha-trip', 'ha', 6, 18), startOdometerKm: 105, endOdometerKm: 115, distanceKm: 10 };
  assert.deepEqual(combineTrips([local], [ha]).trips.map(row => [row.id,row.distanceKm]), [['ha-trip',10],['live-trip-remainder',5]]);
  const next = { ...ha, startOdometerKm: 110, endOdometerKm: 120 };
  assert.deepEqual(combineTrips([local], [next]).trips, [next,local]);
  const point = trip('instant', 'live', 18, 18);
  assert.deepEqual(combineTrips([point], [ha]).trips, [point, ha]);
  const partial = { ...ha, startedAt: local.startedAt, endedAt: local.endedAt, endOdometerKm: 110, distanceKm: 5 };
  assert.equal(combineTrips([local], [partial]).trips.reduce((n, row) => n + row.distanceKm!, 0), 10);
  const earlier = trip('earlier', 'live', 0, 12), adjacent = trip('adjacent', 'ha', 11.9, 22);
  assert.deepEqual(combineTrips([earlier], [adjacent]).trips, [adjacent, earlier]);
});

test('Charging sessions use one amount and keep adjacent unplug-and-replug sessions', () => {
  const old = charge('official-1', 'live', 30, 60, 'ac');
  const similar = charge('sampled-1', 'live', 62, 96, 'ac');
  const remote = charge('ha-charge-1', 'ha', 61, 97, 'dc');
  const next = charge('sampled-2', 'live', 97, 115, 'dc');
  similar.position = { at: similar.startedAt, lat: 30, lon: 120, coordinate: 'gcj02' };
  similar.batteryTemperatures = [{ at: similar.startedAt, value: -2 }, { at: similar.startedAt + minute, value: 0 }];
  remote.batteryTemperatures = [{ at: similar.startedAt + minute, value: null }, { at: remote.endedAt!, value: 3 }];
  const combined = combineCharges([old, similar, next], [remote]);
  assert.deepEqual(combined.charges.find(c => c.id === remote.id)?.batteryTemperatures,
    [...similar.batteryTemperatures, { at: remote.endedAt!, value: 3 }]);
  assert.deepEqual(combined.charges.map(row => [row.id, row.kwh]), [[next.id, 18], [remote.id, 20], [old.id, 18]]);
  assert.deepEqual(combined.aliases.get(remote.id), [similar.id]);
  assert.deepEqual(combined.charges.find(c => c.id === remote.id)?.position, similar.position);
  assert.equal(combined.charges.find(c => c.id === next.id)?.position, undefined);
});
