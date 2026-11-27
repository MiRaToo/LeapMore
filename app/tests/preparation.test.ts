import assert from 'node:assert/strict';
import test from 'node:test';
import { allowsPreparationContent, applyPreparationEdit, confirmsPreparation, preparationContent, readPreparationPlans } from '../src/data/cloud/preparation.ts';
import type { PreparationPlan, PreparationPreset } from '../src/data/cloud/preparation.ts';
import type { Vehicle } from '../src/data/types.ts';
import { climatePresets } from '../src/data/cloud/climatePresets.ts';
import type { CarState } from '../src/data/types.ts';
import { encodeRemote, matchesRemoteState, needsParkingSentry } from '../src/data/cloud/remote.ts';

const vehicle: Vehicle = { id: 'a', vin: 'test', model: 'C10', nickname: '', year: 0, source: 'fixture', abilities: ['12','170','301','320','440','180'] };
const preset: PreparationPreset = { id: 'work', name: '通勤', destination: { name: '公司', address: '科技路', lat: 30, lon: 120 },
  climate: true, temperature: 24, fan: 2, seat: 'vent', steering: true, mirrors: true };
const content = preparationContent(preset, vehicle);
const plan: PreparationPlan = { set_id: 'existing', enable: true, start_time: '2020-02-03 08:30:00', days: null,
  datacontent: { childSeatAfterCtr: { enable: true }, futureModule: [1] }, futureField: 42 };

test('preparation sends one command containing only the chosen modules', () => {
  assert.deepEqual(encodeRemote({ kind: 'prepare', content }).id, 360);
  assert.deepEqual(content.air_condition, { enable: true, temperature: '24', windlevel: '2', mode: 'nohotcold', operate: 'manual', circle: 'out' });
  assert.deepEqual(Object.keys(content), ['syn_path', 'air_condition', 'seat_setting', 'steeringWheelHeatCtrl', 'rearMirrorHeating']);
  assert.deepEqual(content.syn_path, {enable:true, addresskey:'', addressname:'公司', address:'科技路', latitude:'30', longitude:'120', linenum:'0'});
  for (const ability of ['30', '180']) assert.ok(allowsPreparationContent({...vehicle, abilities:[ability]}, {syn_path: content.syn_path}, true, true));
  assert.ok(!allowsPreparationContent({...vehicle, abilities:['170']}, {syn_path: content.syn_path}, true, true));
  assert.ok(allowsPreparationContent(vehicle, content, false, true));
  assert.ok(!allowsPreparationContent(vehicle, content, true, true));
  assert.ok(!allowsPreparationContent(vehicle, content, false, false));
  assert.deepEqual(Object.keys(preparationContent({ ...preset, climate: false, mirrors: false, steering: false, destination: null }, vehicle)), ['seat_setting']);
  assert.deepEqual(encodeRemote({ kind: 'sentry', on: false }), { id: 400, state: { value: 'off' } });
  assert.equal(matchesRemoteState({ kind: 'sentry', on: false }, { sentry: null } as never), false);
});

test('shared presets check granted commands separately from model features', () => {
  const shared = { ...vehicle, source: 'live' as const, shared: true, abilities: ['12', '30'],
    commandRights: ['170', '171', '180', '301', '320', '360', '361', '370', '440'] };
  const can = (rights: string[], part: typeof content, scheduled = false, location = true) =>
    allowsPreparationContent({ ...shared, commandRights: rights }, part, scheduled, location);
  const climate = { air_condition: content.air_condition };
  const nav = { syn_path: content.syn_path };
  assert.ok(can(shared.commandRights, content));
  assert.ok(can(shared.commandRights, content, true));
  assert.ok(can(['170', '360'], climate));
  assert.ok(!can(['170', '360'], climate, true));
  assert.ok(!can(['171', '360'], climate));
  assert.ok(!can(['360', '361'], climate));
  assert.ok(!can([], climate));
  assert.ok(!can(['180'], nav, false, false));
  assert.ok(!can(['360'], nav));
  assert.ok(!can(['170', '360'], { ...climate, rearMirrorHeating: content.rearMirrorHeating }));
  assert.ok(!can(['301'], { seat_setting: { isHeat: false } }));
  assert.ok(!can(['370'], { seat_setting: { isHeat: true } }));
});

test('schedule writes preserve other plans and opaque fields and reject stale edits', () => {
  const plans = readPreparationPlans(JSON.stringify({ controls: [plan] }));
  const saved = applyPreparationEdit(plans, { action: 'save', preset: { name: '出发', content }, days: [1], time: '07:00' }, 'vin');
  assert.deepEqual(saved.controls[0], plan);
  assert.ok(confirmsPreparation(saved.controls, saved));
  const toggle = applyPreparationEdit(saved.controls, { action: 'toggle', previous: plan }, 'vin');
  assert.deepEqual(toggle.target?.datacontent, plan.datacontent);
  assert.equal(toggle.target?.futureField, 42);
  assert.equal(toggle.target?.enable, true);
  assert.equal(toggle.controls[1], saved.controls[1]);
  assert.throws(() => applyPreparationEdit(toggle.controls, { action: 'delete', previous: plan }, 'vin'), /已变更/);
  const remove = applyPreparationEdit(toggle.controls, { action: 'delete', previous: toggle.controls[0] }, 'vin');
  assert.deepEqual(remove.controls, [saved.target]);
  assert.ok(confirmsPreparation(remove.controls, remove));
  assert.ok(!confirmsPreparation(toggle.controls, remove));
  assert.throws(() => readPreparationPlans('{}'), /无法识别/);
  assert.throws(() => readPreparationPlans({ controls: [plan, plan] }), /无法识别/);
  assert.throws(() => applyPreparationEdit(Array.from({ length: 5 }, (_,i) => ({ ...plan, set_id: String(i) })),
    { action: 'save', days: [], time: '06:00', preset: { name: '出发', content } }, 'vin'), /最多/);
});

test('all four preparation climate presets carry their mode, circulation and defrost settings in both plans and immediate commands', () => {
  for (const [, , settings] of climatePresets) {
    const modules = preparationContent({ ...preset, climatePreset: settings.mode }, vehicle);
    const encoded = encodeRemote({ kind: 'climate', on: true, preset: true, ...settings });
    assert.deepEqual(modules.air_condition, { ...encoded.state as object, enable: true, windlevel: String(settings.fan) });
    const saved = applyPreparationEdit([], { action: 'save', time: '08:00', days: [1], preset: { name: preset.name, content: modules } }, 'vin');
    assert.deepEqual(saved.target?.datacontent, encodeRemote({ kind: 'prepare', content: modules }).state);
  }
});

test('foreground sentry requires a fresh, explicitly off report while parked in P', () => {
  const now = Date.now();
  const stopped = { sentry: false, gear: 0, isDriving: false, freshness: 'fresh', reportedAt: now } as CarState;
  assert.equal(needsParkingSentry(stopped, now), true);
  for (const change of [{ sentry: true }, { sentry: null }, { gear: 2 }, { gear: null }, { isDriving: true },
    { reportedAt: null }, { reportedAt: now - 31 * 60_000 }, { freshness: 'stale' as const }]) {
    assert.equal(needsParkingSentry({ ...stopped, ...change }, now), false);
  }
});
