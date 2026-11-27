import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendCloudFrame, cloudDay, cloudFrame, dayStart, energyParts, officialCharge, mergeTripFrames, RepeatedReportParking } from '../src/data/cloud/records.ts';
import { CloudRateLimited, VehiclePolling, vehicleRateLimited } from '../src/data/cloud/polling.ts';
import { deriveTrips, framesOf, withChargePositions } from '../src/data/ha/measurements.ts';
import type { Frame, Reading } from '../src/data/ha/measurements.ts';
import type { CarState } from '../src/data/types.ts';
import { reconcileCharges, sampledCharges } from '../src/data/cloud/charges.ts';
import { defaultVehicleEnergy } from '../src/data/vehicleEnergy.ts';
import { vehicleBatteryPacks } from '../src/data/batteryPacks.ts';
import { estimateChargeRecord } from '../src/data/tariff.ts';
import { tripSampleMetrics } from '../src/data/tripSampleMetrics.ts';
import type { Tariff } from '../src/data/types.ts';

const start = Date.UTC(2026, 10, 22, 16);
const frame = (second: number, data: Reading): Frame => ({ at: start + second * 1000, data, changed: ['power', 'speed', 'odometer'] });

test('repeated timestamps confirm parking after three polling intervals without duplicating measurements', () => {
  const tracker = new RepeatedReportParking();
  const moving = frame(30, { motion: 'driving', odometer: 502 });
  const parked = { ...moving, pollIntervalMs: 60_000, data: { motion: 'parked', odometer: 502 } };
  tracker.observe(moving, moving.at);
  assert.equal(tracker.observe(parked, moving.at + 1), undefined);
  assert.equal(tracker.observe(parked, moving.at + 180_000), undefined);
  const end = tracker.observe(parked, moving.at + 180_001)!;
  assert.equal(end.tripBoundary, 'parked');
  assert.equal(tracker.observe(parked, moving.at + 240_000), undefined);
  const trips = deriveTrips([frame(0, { motion: 'driving', odometer: 500 }), moving, end], 'live');
  assert.equal(trips.length, 1);
  assert.equal(trips[0].distanceKm, 2);
  assert.equal(trips[0].endedAt, moving.at);

  const plugged = new RepeatedReportParking();
  plugged.observe(moving, moving.at);
  const plugEnd = plugged.observe({ ...parked, data: { charge: 'plugged' } }, moving.at + 1000)!;
  const next = frame(300, { motion: 'parked', odometer: 508 });
  assert.deepEqual(deriveTrips([frame(0, { motion: 'driving', odometer: 500 }), moving, plugEnd, next], 'live')
    .map(trip => trip.distanceKm), [2]);
  assert.deepEqual(deriveTrips([moving, plugEnd, next], 'live'), []);
});

test('Vehicle reports drive the HA polling tiers and rate-limit cooldown', () => {
  const policy = new VehiclePolling();
  const parked = { isDriving: false, parked: true, locked: true, charging: 'unplugged' } as const;
  policy.observe({ ...parked, reportedAt: start }, start);
  assert.equal(policy.delay(start), 60_000);
  policy.observe({ ...parked, locked: false, reportedAt: start + 1000 }, start + 1000);
  assert.equal(policy.delay(start + 1000), 6000);
  policy.observe({ ...parked, locked: false, reportedAt: start + 600_000 }, start + 600_000);
  assert.equal(policy.delay(start + 601_001), 60_000);
  policy.observe({ ...parked, isDriving: true, parked: false, reportedAt: start + 602_000 }, start + 602_000);
  assert.equal(policy.delay(start + 602_000), 6000);
  policy.observe({ ...parked, reportedAt: start + 608_000 }, start + 608_000);
  assert.equal(policy.delay(start + 608_000), 6000);
  policy.observe({ ...parked, charging: 'charging', reportedAt: start + 614_000 }, start + 614_000);
  assert.equal(policy.delay(start + 614_000), 60_000);

  assert.ok(vehicleRateLimited({ _status: 429, code: 0 }));
  assert.ok(vehicleRateLimited({ code: 1023 }));
  assert.ok(vehicleRateLimited({ message: '操作过于频繁' }));
  assert.ok(!vehicleRateLimited({ code: 0, message: '请求成功' }));
  policy.rateLimit(start + 620_000);
  assert.equal(policy.delay(start + 620_000), 120_000);
  assert.throws(() => policy.beforeRequest(start + 621_000), CloudRateLimited);
  policy.beforeRequest(start + 740_000);
  assert.throws(() => policy.beforeRequest(start + 741_000), CloudRateLimited);
  assert.equal(policy.delay(start + 1_520_000), 60_000);
});

test('Duplicate and stale reports cannot keep driving or activate launch boost', () => {
  const policy = new VehiclePolling();
  const report = { isDriving: true, locked: true, charging: 'unplugged', reportedAt: start } as const;
  policy.observe(report, start);
  policy.observe({ ...report, isDriving: false, locked: false }, start + 60_000);
  policy.observe({ ...report, isDriving: false, locked: false, reportedAt: start + 1000 }, start + 100_000);
  assert.equal(policy.delay(start + 100_000), 60_000);
});

test('Vehicle location is optional for cloud journey sampling', () => {
  const state = { reportedAt: start, isDriving: true, speedKmh: 50, odometer: 101,
    latitude: 31.2, longitude: 121.5, rangeKm: 192 } as CarState;
  assert.deepEqual(cloudFrame(state, true, start)?.data.position, { at: start, lat: 31.2, lon: 121.5, coordinate: 'gcj02' });
  assert.equal(cloudFrame(state, false, start)?.data.position, null);
  assert.equal(cloudFrame(state, false, start)?.data.odometer, 101);
  assert.equal(cloudFrame(state, false, start)?.data.range, 192);
});

test('Trip detail derives range and zero-speed duration from observed samples only', () => {
  const [trip] = deriveTrips([
    frame(0, { motion: 'driving', speed: 58, odometer: 100, range: 305, soc: 61, batteryMinTemp: -1 }),
    frame(60, { motion: 'driving', speed: 0, soc: 60.5 }),
    frame(120, { motion: 'driving', speed: 0, soc: 60, odometer: 102 }),
    frame(360, { motion: 'driving', speed: 0, odometer: 110 }),
    frame(420, { motion: 'parked', speed: 22, odometer: 112, range: 290, soc: 58 }),
  ].map(row => ({ ...row, changed: [...row.changed, 'soc', 'batteryMinTemp'] })), 'live');
  assert.equal(trip.socSamples?.[1].value, 60.5);
  assert.deepEqual(trip.batteryTemperatures?.slice(0, 2), [{ at: start, value: -1 }, { at: start + 60_000, value: null }]);
  assert.deepEqual(tripSampleMetrics(trip, trip.speeds), {
    highestSpeed: 58, stoppedMs: 60_000, rangeStart: 305, rangeEnd: 290, achievement: 80,
  });
  assert.equal(tripSampleMetrics({ ...trip, rangeEndKm: 306 }, trip.speeds).achievement, null);
  assert.equal(tripSampleMetrics(trip, [{ at: start, value: 0 }]).stoppedMs, null);
});

test('Phone trip energy uses a valid positive SOC drop and the selected battery capacity', () => {
  const frames = [
    frame(0, { motion: 'parked', soc: 60, odometer: 100 }),
    frame(6, { motion: 'driving', soc: 60, odometer: 100 }),
    frame(12, { motion: 'driving', soc: 58, odometer: 103 }),
    frame(18, { motion: 'parked', odometer: 105 }),
  ];
  const trip = deriveTrips(frames, 'live', 67)[0];
  assert.equal(trip.socStart, 60);
  assert.equal(trip.socEnd, 58);
  assert.equal(trip.energyKwh, 1.34);
  assert.equal(trip.efficiency, 26.8);
  assert.equal(deriveTrips(frames, 'live', 55)[0].energyKwh, 1.1);
  assert.equal(deriveTrips(frames, 'live')[0].energyKwh, null);
  assert.equal(deriveTrips([frames[0], frame(6, { motion: 'driving', soc: 101 }), ...frames.slice(2)], 'live', 67)[0].energyKwh, null);
  assert.equal(deriveTrips([...frames.slice(0, 3), frame(18, { motion: 'parked', soc: 61, odometer: 105 })], 'live', 67)[0].energyKwh, null);
});

const chargeFrame = (second: number, charge: string, soc: number | null, power?: number): Frame => ({
  at: start + second * 1000, data: { motion: 'parked', charge, chargeType: 'ac', soc, power }, changed: ['charge', 'soc', 'power'],
});
const tariff: Tariff = {
  ac: { peak: 1, valley: 1, valleyStart: '23:00', valleyEnd: '07:00', efficiency: 90 },
  dc: { periods: [{ start: '00:00', end: '23:59', price: 1 }], efficiency: 92 },
};
const parts = { capacityKwh: 50, acEfficiency: 80, dcEfficiency: 95 };

test('Charge sampling retains charge curves, uses SOC, and combines official energy without counting twice', () => {
  const frames = [
    chargeFrame(0, 'unplugged', 40), chargeFrame(60, 'charging', 40, 6.2),
    chargeFrame(180, 'charging', 41), chargeFrame(360, 'charging', 42, 6.4),
    chargeFrame(420, 'plugged', 42), chargeFrame(480, 'plugged', 42), chargeFrame(540, 'unplugged', 42),
  ].reduce(appendCloudFrame, [] as Frame[]);
  const timed = frames.filter(frame => frame.data.charge === 'charging');
  timed.forEach((frame, index) => {
    frame.changed.push('batteryMinTemp');
    frame.data.batteryMinTemp = [-3, null, 0][index];
  });
  const [sample] = sampledCharges(frames, parts.capacityKwh, start + 550_000);
  assert.ok(sample);
  assert.deepEqual(sample.powerTimeline?.map(entry => [entry.value, entry.soc]), [[6.2, 40], [null, 41], [6.4, 42]]);
  assert.equal(sample.kwh, 1);
  assert.equal(sample.partial, false);
  assert.equal(sample.energyBasis, 'soc');
  assert.equal(reconcileCharges([], [sample], parts)[0].gridKwh, 1.25);
  const known = officialCharge({ chargeGunStartTs: start + 50_000, chargeGunEndTs: start + 400_000,
    chargeInEnergy: 1.2, chargeType: 'SLOW' })!;
  const rows = reconcileCharges([known], [sample], parts);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, known.id);
  assert.equal(rows[0].sampledId, sample.id);
  assert.deepEqual(rows[0].batteryTemperatures, timed.map(frame => ({ at: frame.at, value: frame.data.batteryMinTemp })));
  const clipped = reconcileCharges([{ ...known, startedAt: timed[1].at }], [sample], parts);
  assert.deepEqual(clipped[0].batteryTemperatures, rows[0].batteryTemperatures?.slice(1));
  assert.equal(rows[0].energyBasis, 'official');
  assert.equal(rows[0].kwh, 1.2);
  assert.equal(rows[0].gridKwh, 1.5);
  assert.equal(rows[0].socEnd, 42);
  assert.ok(Math.abs((estimateChargeRecord(rows[0], { ...tariff, ac: { ...tariff.ac, efficiency: parts.acEfficiency } })?.cost ?? 0) - 1.5) < 1e-9);
  assert.equal(reconcileCharges([{ ...known, type: 'dc' }], [], parts)[0].gridKwh, 120 / 95);
});

test('an explicit charging report is recorded without motion telemetry; a driving report still ends it', () => {
  const reports = [chargeFrame(0, 'plugged', 40), chargeFrame(60, 'charging', 40, 6),
    chargeFrame(360, 'charging', 41, 6), chargeFrame(420, 'charging', 42, 6)];
  for (const frame of reports) frame.data.motion = null;
  reports[3].data.motion = 'driving';
  const [charge] = sampledCharges(reports, 50, start + 430_000);
  assert.equal(charge.startedAt, reports[1].at);
  assert.equal(charge.endedAt, reports[2].at);
  assert.equal(charge.kwh, 0.5);
  assert.equal(charge.active, false);
});

test('Unknown charging state and long gaps never add unobserved SOC to charging energy', () => {
  const frames = [chargeFrame(0, 'unplugged', 40), chargeFrame(60, 'charging', 40),
    chargeFrame(120, 'charging', 42), chargeFrame(1200, 'charging', 60), chargeFrame(1260, 'charging', 61)];
  const rows = sampledCharges(frames, 50, start + 2_200_000);
  assert.deepEqual(rows.map(charge => charge.kwh), [1, 0.5]);
  assert.ok(rows.every(charge => charge.partial && !charge.active));
  const stopped = sampledCharges([...frames.slice(0, 3), chargeFrame(180, 'unknown', 42)], 50, start + 190_000);
  assert.equal(stopped[0].partial, true);
  const implausible = sampledCharges([chargeFrame(60, 'charging', 40), chargeFrame(66, 'charging', 100)], 50, start + 70_000);
  assert.equal(implausible[0].kwh, null);
});

test('Battery pack settings respect identified variants and preserve earlier custom charge efficiency', () => {
  const usable = vehicleBatteryPacks({ model: 'C10 530 后驱' }, 'bev').preset;
  assert.equal(usable?.kwh, 67);
  assert.equal(usable?.basis, 'usable');
  const published = vehicleBatteryPacks({ model: 'C10 2027款 纯电660智享版' }).preset;
  assert.equal(published?.kwh, 81.9);
  assert.equal(published?.basis, 'published');
  assert.equal(vehicleBatteryPacks({ model: 'C10 AWD' }, 'bev').preset, undefined);
  assert.equal(vehicleBatteryPacks({ model: 'B10' }, 'bev').preset, undefined);
  assert.deepEqual(vehicleBatteryPacks({ model: '零跑', carType: 'B05' }, 'bev').choices.map(pack => pack.kwh), [56.2, 67.1, 69.7]);
  assert.equal(vehicleBatteryPacks({ model: 'T03' }, 'bev').preset, undefined);
  assert.equal(vehicleBatteryPacks({ model: 'C16 280 增程' }).preset, undefined);
  assert.equal(vehicleBatteryPacks({ model: 'C16 280 增程', year: 2026 }).preset?.kwh, 38.7);
  assert.equal(vehicleBatteryPacks({ model: 'C11 580 四驱', year: 2024 }).preset?.kwh, 89.97);
  assert.equal(vehicleBatteryPacks({ model: 'C11 580', year: 2024 }).preset, undefined);
  assert.deepEqual(defaultVehicleEnergy(usable, tariff), { capacityKwh: 67, capacityBasis: 'usable', acEfficiency: 90, dcEfficiency: 90 });
  assert.equal(defaultVehicleEnergy(published, { ...tariff, dc: { ...tariff.dc, efficiency: 95 } }).dcEfficiency, 95);
});

test('All current mainland series have distinct published variant presets and legacy packs remain available', () => {
  const examples = [
    ['T03 310 舒享版', 31.9], ['A05S 510', 53], ['A10 403', 39.8], ['B01 590', 60.8],
    ['B10 610', 69.7], ['Lafa 5 605 Pro', 67.1], ['C10 290 增程', 38.7],
    ['C11 2027款 300 增程', 41.7], ['C16 2027款 280 增程', 38.9], ['D19 增程 400', 63.7],
    ['D99 纯电 700', 115], ['C01 316 增程', 43.7], ['S01 380 Pro', 35.6],
  ] as const;
  for (const [model, kwh] of examples) {
    const { choices, preset } = vehicleBatteryPacks({ model });
    assert.equal(preset?.kwh, kwh, model);
    assert.equal(preset?.basis, 'published', model);
    assert.equal(new Set(choices.map(pack => pack.label)).size, choices.length, model);
  }
  assert.equal(vehicleBatteryPacks({ model: 'D99' }).preset, undefined);
  assert.equal(vehicleBatteryPacks({ model: 'D99' }, 'reev').preset?.kwh, 80.3);
  assert.equal(vehicleBatteryPacks({ model: 'C18' }).choices.length, 0);
});

test('The capacity catalog contains mainland battery variants only', () => {
  assert.deepEqual(vehicleBatteryPacks({ model: 'A10' }).choices.map(pack => pack.kwh), [39.8, 53]);
  assert.deepEqual(vehicleBatteryPacks({ model: 'B10' }).choices.map(pack => pack.kwh), [56.2, 67.1, 60.8, 69.7]);
  assert.ok(!vehicleBatteryPacks({ model: 'T03' }).choices.some(pack => pack.kwh === 36));
  assert.equal(vehicleBatteryPacks({ model: 'B03X' }).choices.length, 0);
});

test('Cloud energy uses China calendar windows and rejects partial breakdown totals', () => {
  assert.equal(dayStart(start + 60_000), start);
  assert.equal(cloudDay(start - 1), '2026-11-22');
  assert.equal(cloudDay(start), '2026-11-23');
  const parts = energyParts({ driverEC: '8.2', acEC: '1.2', otherEC: '.6' });
  assert.deepEqual([parts.drive, parts.climate, parts.other], [8.2, 1.2, .6]);
  assert.ok(parts.total !== null && Math.abs(parts.total - 10) < 1e-9);
  assert.equal(energyParts({ driverEC: 5, acEC: 0, otherEC: null }).total, null);
});

test('a duplicate adds no samples and the next parked meter reading accounts for the final gap', () => {
  const stopped = frame(0, { motion: 'parked', odometer: 100 });
  const drive = frame(10, { motion: 'driving', speed: 30, odometer: 100 });
  let history = appendCloudFrame([stopped], drive);
  assert.equal(appendCloudFrame(history, drive), history);
  history = appendCloudFrame(history, frame(22, { motion: 'driving', speed: 40, odometer: 101 }));
  history = appendCloudFrame(history, frame(600, { motion: 'parked', odometer: 113 }));
  const trip = deriveTrips(history, 'live')[0];
  assert.equal(trip.complete, false);
  assert.equal(trip.distanceKm, 13);
  assert.equal(trip.energyKwh, null);
  assert.equal(trip.gap, true);
});

test('Official charging exposes the measured session without sampled detail', () => {
  const official = officialCharge({ chargeGunStartTs: start + 10_000, chargeGunEndTs: start + 130_000,
    chargeInEnergy: '0.2', chargeType: 'SLOW' });
  assert.ok(official);
  assert.equal(official.kwh, .2);
  assert.equal(official.type, 'ac');
  assert.equal(official.socStart, null);
  assert.deepEqual(official.powers, []);
});

test('Charging coordinates respect location grants and invalid or missing values', () => {
  const row = { chargeGunStartTs: start, chargeGunEndTs: start + 120_000, chargeStartLatitude: '31.2', chargeStartLongitude: '121.5' };
  assert.equal(officialCharge(row, false)?.position, undefined);
  assert.deepEqual(officialCharge(row, true)?.position, { at: start, lat: 31.2, lon: 121.5, coordinate: 'unknown' });
  for (const [lat, lon] of [[0, 0], [null, 121], [100, 0], ['bad', 32], [12, 181]]) {
    assert.equal(officialCharge({ ...row, chargeStartLatitude: lat, chargeStartLongitude: lon }, true)?.position, undefined);
  }
});

test('A charge uses a fresh fix inside its own interval and never borrows the next session or a moving car', () => {
  const row = officialCharge({ chargeGunStartTs: start, chargeGunEndTs: start + 60_000 })!;
  const fix = (second: number): Frame => ({ at: start + second * 1000, changed: ['tracker'],
    data: { position: { at: start + second * 1000, lat: 31.2, lon: 121.5, coordinate: 'wgs84' } } });
  const stale = { ...fix(-10), at: start + 5000, changed: ['soc'] as Frame['changed'] };
  const moving = fix(12);
  moving.data.motion = 'driving';
  assert.equal(withChargePositions([row], [fix(-10), stale, moving, fix(60)])[0].position, undefined);
  const other = { ...row, startedAt: start + 60_000, endedAt: start + 90_000 };
  const sessions = withChargePositions([other, row], [fix(-10), stale, moving, fix(30), fix(60)]);
  assert.equal(sessions[0].position?.at, other.startedAt);
  assert.equal(sessions[1].position?.at, start + 30_000);
  assert.equal(withChargePositions([{ ...row, active: true, endedAt: null }], [fix(90)])[0].position, undefined);
});

test('HA tire pressures use kPa while preserving already normalized readings', () => {
  const frames = framesOf([
    { entity: 'sensor.kpa', at: start, state: '218', attrs: { unit_of_measurement: 'kPa' } },
    { entity: 'sensor.bar', at: start, state: '2.4', attrs: { unit_of_measurement: 'bar' } },
    { entity: 'sensor.psi', at: start, state: '35', attrs: { unit_of_measurement: 'psi' } },
  ], { tireFL: 'sensor.kpa', tireFR: 'sensor.bar', tireRL: 'sensor.psi' });
  assert.equal(frames[0].data.tireFL, 218);
  assert.equal(frames[0].data.tireFR, 240);
  assert.equal(Math.round(Number(frames[0].data.tireRL)), 241);
});

test('manual trip interruption preserves distance and ends at the last saved sample, even on replay', () => {
  const a = frame(0, { motion: 'driving', odometer: 10 });
  const b = frame(20, { motion: 'driving', odometer: 11 });
  const end: Frame = { at: b.at + 1, data: {}, changed: [], tripBoundary: 'interrupted' };
  const between: Frame = { ...frame(25, { motion: 'driving', odometer: 12 }), chargeOnly: true };
  const resumed = frame(40, { motion: 'driving', odometer: 14 });
  const frames = mergeTripFrames([between, resumed], [a, b, end]);
  assert.deepEqual(mergeTripFrames(frames, [a, b, end]), frames);
  const [current, interrupted] = deriveTrips(frames, 'live');
  assert.equal(current.startedAt, resumed.at);
  assert.equal(interrupted.endedAt, b.at);
  assert.equal(interrupted.distanceKm, 1);
  assert.equal(interrupted.gap, true);
  assert.equal(deriveTrips([between], 'live').length, 0);
  assert.deepEqual(mergeTripFrames([{ ...a, chargeOnly: true }], [a]), [a]);
  const parked: Frame = { ...a, data: {motion:'parked',charge:'unplugged'} };
  assert.ok(appendCloudFrame([parked,{...parked,at:b.at}], {...parked,at:resumed.at,chargeOnly:true}).some(f=>f.at===b.at));
});

test('late native batches fill trace holes while charge-only samples cannot fill a driving trace', () => {
  const drive = (second: number) => {
    const at = start + second * 1000;
    return cloudFrame({ reportedAt: at, isDriving: true, latitude: 31, longitude: 121 + second / 10_000 } as CarState, true, at)!;
  };
  const gap = appendCloudFrame([drive(0)], drive(150));
  assert.equal(deriveTrips(gap, 'live')[0].route.at(-1)?.gapBefore, true);
  assert.equal(deriveTrips(mergeTripFrames(gap,[drive(75)]), 'live')[0].route.at(-1)?.gapBefore, undefined);
  assert.equal(deriveTrips(mergeTripFrames(gap,[{...drive(75),chargeOnly:true}]), 'live')[0].route.at(-1)?.gapBefore, true);
});

test('a sparse 14 km drive survives foreground writes, legacy gap markers and replayed native batches', () => {
  const reports = [[0, 5000], [20, 5000], [420, 5004], [460, 5005],
    [720, 5008], [760, 5009], [1260, 5014], [1280, 5014]];
  const drive = reports.map(([second, odometer]) => {
    const at = start + second * 1000;
    return cloudFrame({ reportedAt: at, isDriving: true, odometer, speedKmh: 40,
      latitude: 31, longitude: 121 + (odometer - 5000) / 100 } as CarState, true, at)!;
  });
  const park = frame(1300, { motion: 'parked', odometer: 5014 });
  const saved = [...drive, park].reduce(appendCloudFrame, [] as Frame[]);
  const legacy = drive.flatMap((f, i) => i < 7 && i % 2 === 1
    ? [f, { at: f.at + 1, changed: [], data: {} }] : [f]).concat(park);
  const replay = mergeTripFrames([park], drive.toReversed());
  for (const frames of [saved, legacy, replay, mergeTripFrames(replay, drive)]) {
    const trips = deriveTrips(frames, 'live', null, park.at + 60_000);
    assert.equal(trips.length, 1);
    const [trip] = trips;
    assert.equal(trip.id, 'live-' + start);
    assert.equal(trip.endedAt, drive.at(-1)!.at);
    assert.equal(trip.distanceKm, 14);
    assert.equal(trip.durationMin, 1280 / 60);
    assert.equal(trip.complete, false);
    assert.deepEqual(trip.route.filter(p => p.gapBefore).map(p => p.at), [drive[2].at, drive[4].at, drive[6].at]);
    assert.equal(trip.route.length, drive.length);
  }
  const [active] = deriveTrips(saved.slice(0, -1), 'live');
  assert.equal(active.endedAt, null);
  assert.equal(active.distanceKm, 14);
});

test('cloud outages preserve a driving session until the frozen watchdog or a confirmed boundary', () => {
  const moving = (s: number, odometer: number | null) => frame(s, { motion: 'driving', odometer });
  const first = [moving(0, 100), moving(30, 101)];
  for (const after of [moving(450, null), moving(450, 101), moving(450, 105)]) {
    const trips = deriveTrips([...first, after], 'live');
    assert.equal(trips.length, 1);
    assert.equal(trips[0].endedAt, null);
  }
  const [resumed, offline, frozen] = deriveTrips([...first, moving(1900, 112)], 'live');
  assert.equal(frozen.endedAt, first[1].at);
  assert.equal(offline.reconstructed, true);
  assert.equal(offline.distanceKm, 11);
  assert.equal(resumed.startedAt, start + 1_900_000);
  const after = moving(450, 108);
  for (const boundary of [
    frame(36, { motion: 'parked' }), frame(36, { charge: 'charging' }),
    { at: first[1].at + 1, changed: [], data: {}, tripBoundary: 'ended' } as Frame,
    { at: first[1].at + 1, changed: [], data: {}, tripBoundary: 'interrupted' } as Frame,
  ]) {
    const recorded = deriveTrips([...first, boundary, after], 'live').filter(trip => !trip.reconstructed);
    assert.equal(recorded.length, 2);
    assert.equal(recorded[0].startedAt, after.at);
  }
});

test('a brief neutral or gearless stop and a missing motion report keep the drive together', () => {
  const report = (s: number, odometer: number, gear: number | null, driving: boolean) => {
    const at = start + s * 1000;
    return cloudFrame({ reportedAt: at, odometer, gear, parked: !driving, isDriving: driving,
      speedKmh: driving ? 40 : 0, charging: 'unplugged' } as CarState, false, at)!;
  };
  const startDrive = report(6, 100, 3, true), resume = report(78, 101, 3, true);
  const park = report(90, 102, 0, false);
  for (const gear of [0, 2, null]) {
    const stopped = report(24, 101, gear, false);
    const frames = [report(0, 100, 0, false), startDrive, stopped, frame(42, { soc: 80 }), resume, park];
    assert.equal(deriveTrips(frames, 'live', null, park.at + 59_000)[0].endedAt, null);
    const trips = deriveTrips(frames, 'live', null, park.at + 60_000);
    assert.equal(trips.length, 1);
    assert.equal(trips[0].distanceKm, 2);
    assert.equal(trips[0].complete, true);
    assert.equal(trips[0].speeds.find(s => s.at === stopped.at)?.value, 0);
    assert.equal(deriveTrips([startDrive, stopped, report(240, 101, 3, true)], 'live').length, 2);
  }
});

test('parked mileage and mileage before the first moving report are accounted for once without invented tracks', () => {
  const parked = (s: number, km: number, soc: number) => frame(s, { motion: 'parked', charge: 'unplugged', odometer: km, soc });
  const rows = [parked(0, 100, 60), parked(60, 100, 60), parked(120, 100, 60), parked(600, 104, 59),
    frame(900, { motion: 'driving', odometer: 107, soc: 58 }), parked(960, 108, 58)].reduce(appendCloudFrame, [] as Frame[]);
  const trips = deriveTrips(rows, 'live', 50);
  assert.deepEqual(trips.map(row => row.distanceKm), [1, 3, 4]);
  const gaps = trips.filter(trip => trip.reconstructed);
  assert.equal(gaps.length, 2);
  assert.equal(gaps[1].startedAt, start + 120_000);
  assert.equal(gaps[1].energyKwh, .5);
  assert.ok(gaps.every(trip => !trip.complete && !trip.route.length && !trip.speeds.length));
  assert.equal(deriveTrips([rows[0], parked(36_000, 106, 59)], 'live')[0].durationMin, null);
  assert.deepEqual(deriveTrips([rows[0], parked(600, 104, 61)], 'live'), []);
  assert.deepEqual(deriveTrips([rows[0], frame(600, { motion: 'parked', charge: 'charging', odometer: 104 })], 'live'), []);
  assert.deepEqual(deriveTrips([rows[0], { ...rows[0], at: start + 1, tripBoundary: 'ended' }, parked(600, 104, 59)], 'live'), []);
  assert.deepEqual(deriveTrips([rows[0], parked(120, 99999, 60), parked(240, 100, 60)], 'live'), []);
});

test('a frozen drive ends at its last moving report and keeps intermediate odometer readings', () => {
  const moving = (s: number, km: number | null) => frame(s, { motion: 'driving', odometer: km });
  const reports = [moving(0, null), moving(40, 100), moving(80, 102), moving(100, null)];
  assert.equal(deriveTrips(reports, 'live', null, start + 120_000)[0].endedAt, null);
  const [frozen] = deriveTrips(reports, 'live', null, start + 2_000_000);
  assert.equal(frozen.endedAt, reports.at(-1)!.at);
  assert.equal(frozen.distanceKm, 2);
  assert.equal(frozen.complete, false);
});

test('delayed vehicle frames keep their measurement time and cannot refresh live polling', () => {
  const state = { reportedAt: start, recordingFallbackAt: start + 300_000, isDriving: true, speedKmh: 42 } as CarState;
  const policy = new VehiclePolling();
  policy.observe(state, start + 300_000);
  assert.equal(policy.delay(start + 300_000), 60_000);
  assert.equal(cloudFrame(state, false, start + 300_000)?.at, start);
  assert.equal(cloudFrame(state, false, start + 1_800_001), null);
  assert.equal(cloudFrame({ ...state, reportedAt: null }, false, start + 300_000)?.at, start + 300_000);
  assert.equal(cloudFrame({ ...state, reportedAt: null, recordingFallbackAt: undefined }, false, start), null);
});
