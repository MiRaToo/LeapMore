import test from 'node:test';
import assert from 'node:assert/strict';
import { framesOf, deriveHistory, dailyEnergy, deriveArchive, numberOf, openingOf } from '../src/data/ha/measurements.ts';

test('HA opening sensors distinguish a closed component from missing data', () => {
  assert.deepEqual(['open', 'closed', 'on', 'off', '100', '0', 'unavailable'].map(openingOf),
    [true, false, true, false, true, false, null]);
});
import { mergeSamples } from '../src/data/ha/history.ts';
import type { Archive } from '../src/data/ha/archive.ts';
import type { Sample } from '../src/data/ha/schema.ts';

const today = new Date(2026, 10, 23, 9).getTime();
const at = (minutes: number) => today + minutes * 60_000;
const sample = (entity: string, minutes: number, state: string, attrs?: Sample['attrs']): Sample => ({ entity, at: at(minutes), state, attrs });

test('Recorder deduplicates unchanged pages and preserves different payloads for one timestamp', () => {
  const a = sample('sensor.soc', 1, '45');
  const b = sample('sensor.soc', 1, '46');
  assert.deepEqual(mergeSamples([a], [b, b, a], today).map(s => s.state).sort(), ['45', '46']);
  assert.deepEqual(mergeSamples([a], [b], at(2)), []);
});

test('Unavailable samples interrupt a trip and preserve missing values', () => {
  const frames = framesOf([
    sample('sensor.speed', 0, '0'), sample('sensor.speed', 1, '10', { unit_of_measurement: 'm/s' }),
    sample('sensor.speed', 2, 'unavailable'), sample('sensor.speed', 4, '0'),
  ], { speed: 'sensor.speed' });
  const [trip] = deriveHistory(frames).trips;
  assert.equal(trip.endedAt, null);
  assert.equal(trip.distanceKm, null);
  assert.equal(trip.energyKwh, null);
  assert.equal(trip.speeds[0].value, 36);
  assert.equal(trip.complete, false);
});

test('Daily counters exclude midnight jumps, missing states and reset intervals', () => {
  const entries = [
    sample('sensor.odo', -600, '100'), sample('sensor.odo', 0, '109'),
    sample('sensor.odo', 1, '112'), sample('sensor.odo', 2, 'unknown'),
    sample('sensor.odo', 3, '130'), sample('sensor.odo', 4, '2'),
  ];
  const frames = framesOf(entries, { odometer: 'sensor.odo' });
  const rows = dailyEnergy(frames, 2, at(5));
  assert.deepEqual(rows.map(row => [row.km, row.kwh]), [[null, null], [3, null]]);
  assert.equal(numberOf('0'), 0);
  assert.equal(numberOf('unknown'), null);
});

test('Recorder can provide completed trip and charge from separate mapped entities', () => {
  const frames = framesOf([
    sample('motion', 0, 'off'), sample('odo', 0, '100'), sample('used', 0, '100'),
    sample('motion', 1, 'on'), sample('odo', 10, '112'), sample('used', 10, '102'), sample('motion', 10, 'off'),
    sample('charge', 11, 'off'), sample('charged', 11, '122'), sample('type', 11, 'ac'), sample('charge', 12, 'on'),
    sample('charged', 30, '129'), sample('charge', 30, 'off'),
  ], { motion: 'motion', odometer: 'odo', used: 'used', charge: 'charge', charged: 'charged', chargeType: 'type' });
  const results = deriveHistory(frames);
  assert.equal(results.trips[0].distanceKm, 12);
  assert.equal(results.trips[0].energyKwh, 2);
  assert.equal(results.charges[0].kwh, 7);
  assert.equal(results.charges[0].type, 'ac');
});

test('Known archive membership is scoped to the announced observation IDs', () => {
  const archive: Archive = {
    cursor: 'a', events: {}, records: {}, observations: {}, membership: {},
  };
  for (const [i, id] of ['a', 'b', 'other'].entries()) archive.observations[id] = {
    observation_id: id, vehicle_id: 'car', origin: 'leapmotor_cloud', fidelity: 'native_raw', field_schema: 'leapmotor.raw.v1',
    layout: 'signal_map', coordinate_system: 'gcj02', received_at_ms: at(i),
    source_timestamps: {}, signals_raw: { '1182': i - 1, '1318': 100 + i, '1319': 21, '2': 121 + i * .001, '3': 31 + i * .001 },
  };
  archive.records['trip:first'] = {
    vehicle_id: 'car', kind: 'trip', phase: 'completed', record_id: 'first', revision: 1,
    membership_revision: 1, boundary_hint: { started_at_ms: at(0), ended_at_ms: at(2) },
  };
  archive.membership['trip:first'] = { coverage: 'partial', membership_revision: 1, observation_ids: ['a', 'b'] };
  assert.equal(deriveArchive(archive).trips[0].pointCount, 2);
  assert.deepEqual(deriveArchive(archive).trips[0].batteryTemperatures, [{ at: at(0), value: -1 }, { at: at(1), value: 0 }]);
  assert.equal(deriveArchive(archive).trips[0].complete, false);
  archive.membership['trip:first'].coverage = 'complete';
  assert.equal(deriveArchive(archive).trips[0].complete, true);
  delete archive.observations.a;
  assert.equal(deriveArchive(archive).trips[0].pointCount, 1);
});
