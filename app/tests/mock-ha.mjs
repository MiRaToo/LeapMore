import { createServer } from 'node:http';
import { createHash, randomUUID } from 'node:crypto';
import { WebSocketServer } from 'ws';

const port = Number(process.env.LEAPMORE_HA_TEST_PORT || 8139);
const allowNative = process.env.LEAPMORE_HA_NATIVE_FIXTURE === '1';
const validApp = 'http://127.0.0.1:' + (process.env.LEAPMORE_TEST_APP_PORT || 5176);
const authCode = new Map();
const bearer = new Set(['local-manual-fixture']);
let fail = 'normal';
let refreshed = 0;
let tripDeleted = false;
let overlapping = null;
let totals = { requests: 0, history: 0, bootstrap: 0, pull: 0, membership: 0, refresh: 0, trips: 0, charges: 0, deletes: 0, energy: 0 };
const at = Date.now(), minute = 60_000;
const time = (n) => new Date(at - n * minute).toISOString();
const entry = (id, state, min = 0, extra = {}) => ({
  entity_id: id, state: String(state), last_changed: time(min), last_updated: time(min),
  attributes: { friendly_name: id.split('.').at(-1), ...extra },
});
const groups = [
  [entry('sensor.car_soc', 62, 55, { battery_min_temp: -2 }), entry('sensor.car_soc', 60, 53, { battery_min_temp: 0 }),
    entry('sensor.car_soc', 37, 30, { battery_min_temp: 12.5 }), entry('sensor.car_soc', 64, 3, { battery_min_temp: 19 })],
  [entry('sensor.car_range', 288, 2)],
  [entry('sensor.fixture_energy_rank', '8%', 2)],
  [entry('sensor.fixture_rank_efficiency', 18.5, 2)],
  [entry('sensor.fixture_vehicle_state', 'parked', 2, { speed: 0, windows_open: true })],
  [entry('sensor.car_odometer', 12300, 60), entry('sensor.car_odometer', 12300, 55), entry('sensor.car_odometer', 12310, 44), entry('sensor.car_odometer', 12310, 40)],
  [entry('sensor.car_speed', 0, 60), entry('sensor.car_speed', 31, 55), entry('sensor.car_speed', 42, 50), entry('sensor.car_speed', 0, 44)],
  [entry('sensor.car_used', 245, 60), entry('sensor.car_used', 245, 55), entry('sensor.car_used', 247, 44)],
  [entry('binary_sensor.car_charging', 'off', 40), entry('binary_sensor.car_charging', 'on', 30), entry('binary_sensor.car_charging', 'off', 3)],
  [entry('sensor.car_charged', 500, 40), entry('sensor.car_charged', 500, 30), entry('sensor.car_charged', 516, 3)],
  [entry('sensor.car_charge_type', 'ac', 45)],
  [entry('sensor.car_power', 0, 40, { unit_of_measurement: 'W' }), entry('sensor.car_power', 6300, 20, { unit_of_measurement: 'W' }), entry('sensor.car_power', 0, 3, { unit_of_measurement: 'W' })],
  [entry('device_tracker.car_gps', 'home', 55, { latitude: 31.221, longitude: 121.53 }),
    entry('device_tracker.car_gps', 'away', 53, { latitude: 31.224, longitude: 121.55 }),
    entry('device_tracker.car_gps', 'away', 50, { latitude: 31.228, longitude: 121.57 }),
    entry('device_tracker.car_gps', 'away', 47, { latitude: 31.234, longitude: 121.59 }),
    entry('device_tracker.car_gps', 'away', 44, { latitude: 31.24, longitude: 121.60 })],
];
const fixtureVin = 'LFB1A2B3C4D000001';
const secondVin = 'LFB1A2B3C4D000002';
const secondSoc = entry('sensor.fixture_second_battery', 19, 2);
const registry = [
  [fixtureVin, 'fixture-car', 'sensor.car_soc', 'battery'],
  [fixtureVin, 'fixture-car', 'sensor.car_range', 'range'],
  [fixtureVin, 'fixture-car', 'sensor.fixture_energy_rank', 'energy_rank'],
  [fixtureVin, 'fixture-car', 'sensor.fixture_rank_efficiency', 'hundred_km_ec'],
  [fixtureVin, 'fixture-car', 'sensor.car_odometer', 'total_mileage'],
  [fixtureVin, 'fixture-car', 'sensor.fixture_vehicle_state', 'vehicle_state'],
  [fixtureVin, 'fixture-car', 'device_tracker.car_gps', 'tracker'],
  [secondVin, 'fixture-second', secondSoc.entity_id, 'battery'],
].map(([vin, device_id, entity_id, key]) => ({
  device_id, entity_id, platform: 'leapmotor', unique_id: `${vin}_${key}`,
  translation_key: key === 'battery' ? null : key,
}));
const host = 'http://127.0.0.1:' + port;
const server = createServer(async (req, res) => {
  const url = new URL(req.url, host);
  const json = (value, status = 200) => {
    res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(value));
  };
  if (req.headers.origin === validApp) {
    res.setHeader('Access-Control-Allow-Origin', validApp);
    res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  }
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
  if (url.pathname === '/fixture-mode' && req.method === 'POST') {
    fail = url.searchParams.get('mode') || 'normal';
    if (fail === 'refresh' || fail === 'expired') bearer.clear();
    if (fail === 'normal') { bearer.add('local-manual-fixture'); bearer.add('mock-access-' + refreshed); }
    json(totals); return;
  }
  if (url.pathname === '/fixture-stats') { json(totals); return; }
  if (url.pathname === '/fixture-overlap' && req.method === 'POST') {
    const [tripStart, tripEnd, chargeStart, chargeEnd] = ['tripStart', 'tripEnd', 'chargeStart', 'chargeEnd']
      .map(key => Number(url.searchParams.get(key)) / 1000);
    overlapping = {
      trip: { id: 'same-drive', started_at: tripStart, ended_at: tripEnd, distance_km: 5, energy_kwh: 1.5, duration_min: 1, point_count: 2 },
      charge: { id: 'same-charge', started_at: chargeStart, ended_at: chargeEnd, charge_type: 'ac', kwh: .8 },
    };
    json({ ok: true }); return;
  }
  if (url.pathname === '/auth/authorize' && req.method === 'GET') {
    const p = url.searchParams;
    const callback = new URL(p.get('redirect_uri') ?? host);
    const webCallback = callback.origin === validApp && callback.pathname === '/ha-callback.html';
    const nativeCallback = allowNative && callback.protocol === 'http:' && callback.hostname === '127.0.0.1' &&
      Number(callback.port) > 1024 && callback.pathname === '/leapmore-ha';
    if (!(webCallback || nativeCallback) || new URL(p.get('client_id') ?? host).origin !== callback.origin ||
      p.get('response_type') !== 'code' || p.get('code_challenge_method') !== 'S256' || !p.get('code_challenge') || !p.get('state')) { json({}, 400); return; }
    const code = randomUUID();
    authCode.set(code, { redirect: callback.href, client: p.get('client_id'), challenge: p.get('code_challenge') });
    callback.search = '?'+new URLSearchParams({ code, state: fail === 'state' ? 'invalid-state' : p.get('state') });
    res.writeHead(303, { Location: callback.href, 'Cache-Control': 'no-store' }); res.end(); return;
  }
  if (url.pathname === '/auth/token' && req.method === 'POST') {
    let content = '';
    for await (const chunk of req) content += chunk;
    const p = new URLSearchParams(content);
    if (p.get('grant_type') === 'authorization_code') {
      const code = p.get('code');
      const expected = authCode.get(code);
      authCode.delete(code);
      const challenge = createHash('sha256').update(p.get('code_verifier') || '').digest('base64url');
      if (!expected || expected.challenge !== challenge || expected.client !== p.get('client_id') || expected.redirect !== p.get('redirect_uri')) { json({ error: 'invalid_grant' }, 400); return; }
    } else if (p.get('grant_type') === 'refresh_token') {
      totals.refresh++;
      if (fail === 'expired' || p.get('refresh_token') !== 'mock-refresh') { json({ error: 'invalid_grant' }, 400); return; }
    } else { json({}, 400); return; }
    const access = 'mock-access-' + ++refreshed;
    bearer.add(access);
    json({ access_token: access, refresh_token: 'mock-refresh', expires_in: 1800 });
    return;
  }
  totals.requests++;
  if (req.method !== 'GET') { json({}, 405); return; }
  if (fail === 'offline') { res.destroy(); return; }
  if (!bearer.has((req.headers.authorization ?? '').replace(/^Bearer /, ''))) { json({ message: 'intentionally redacted upstream detail' }, 401); return; }
  if (url.pathname === '/api/states') {
    const current = groups.map(g => g.at(-1));
    if (fail === 'active-ledger') {
      current[current.findIndex(e => e.entity_id === 'sensor.fixture_vehicle_state')] = entry('sensor.fixture_vehicle_state', 'driving', 0, { speed: 47 });
      current[current.findIndex(e => e.entity_id === 'sensor.car_odometer')] = entry('sensor.car_odometer', 12314.5);
    }
    json([...current, ...(fail === 'multi' ? [secondSoc] : [])]); return;
  }
  if (url.pathname.startsWith('/api/history/period/')) {
    totals.history++;
    const from = Date.parse(decodeURIComponent(url.pathname.split('/').at(-1))), to = Date.parse(url.searchParams.get('end_time'));
    const ids = (url.searchParams.get('filter_entity_id') ?? '').split(',');
    if (fail === 'history-gap') { json([]); return; }
    json(groups.filter(g => ids.includes(g[0].entity_id)).map(g => g.filter(e => Date.parse(e.last_updated) >= from && Date.parse(e.last_updated) <= to)));
    return;
  }
  json({}, 404);
});
const wss = new WebSocketServer({ server, path: '/api/websocket' });
const scope = { protocol_version: 1, source_id: 'source-1', dataset_id: 'dataset-1', vehicle_id: 'vehicle-1' };
const record = { record_id: 'fixture', kind: 'trip', phase: 'completed', revision: 1,
  membership_revision: 1, membership_coverage: 'complete', observation_count: 2,
  boundary_hint: { started_at_ms: at - 100 * minute, ended_at_ms: at - 90 * minute } };
const obs = [1, 2].map(i => ({
  vehicle_id: scope.vehicle_id, observation_id: 'point-' + i, origin: 'leapmotor_cloud', fidelity: 'native_raw',
  field_schema: 'leapmotor.raw.v1', layout: 'signal_map', coordinate_system: 'gcj02',
  received_at_ms: at - (101 - i) * minute, source_timestamps: {},
  signals_raw: { '2': 121.5 + .001 * i, '3': 31.2, '1318': 12290 + i, '1319': 24 },
}));
let reset = false;
wss.on('connection', socket => {
  if (fail === 'offline') { socket.close(); return; }
  let authorized = false;
  socket.send(JSON.stringify({ type: 'auth_required' }));
  socket.on('message', data => {
    const msg = JSON.parse(data.toString());
    const ok = (result) => socket.send(JSON.stringify({ id: msg.id, type: 'result', success: true, result }));
    const error = (code) => socket.send(JSON.stringify({ id: msg.id, type: 'result', success: false, error: { code, message: 'fixture error' } }));
    if (msg.type === 'auth') {
      authorized = bearer.has(msg.access_token);
      socket.send(JSON.stringify({ type: authorized ? 'auth_ok' : 'auth_invalid' }));
      return;
    }
    if (!authorized) return error('unauthorized');
    if (msg.type === 'config/entity_registry/list') {
      if (fail === 'limited') return error('unauthorized');
      return ok(fail === 'multi' ? registry : registry.filter(row => row.device_id === 'fixture-car'));
    }
    if (msg.type === 'leapmotor/vehicles/list') {
      if (fail === 'multi') return ok({ vehicles: [
        { device_id: 'fixture-car', vin: fixtureVin, name: '模拟主车' },
        { device_id: 'fixture-second', vin: secondVin, name: '模拟第二辆车' },
      ] });
      if (fail === 'limited' || fail === 'charge-unavailable') return ok({ vehicles: [{ device_id: 'fixture-car', vin: fixtureVin, name: '模拟主车' }] });
      return error('unknown_command');
    }
    if ((fail === 'limited' || fail === 'charge-unavailable') && msg.type.startsWith('leapmotor/sync/')) return error('unauthorized');
    if (msg.type === 'leapmotor/sync/v1/info') return ok({ ...scope, ready: true, membership_contract_version: 1 });
    if (msg.type === 'leapmotor/sync/v1/vehicles') return ok({ ...scope, vehicles: [{ vehicle_id: 'vehicle-1', name: '模拟档案车辆', vin: fixtureVin, migration_status: 'complete' }] });
    if (msg.vin === fixtureVin) {
      const vin = msg.vin;
      if (msg.type === 'leapmotor/trips/list') {
        totals.trips++;
        const active = fail === 'active-ledger' ? { id: 'active-trip', started_at: (at - 5 * minute) / 1000, start_odo: 12310, distance_km: 0 } : null;
        return ok({ vin, active, trips: tripDeleted || fail === 'empty-ledger' ? [] : [{ id: 'ledger-test', started_at: (at - 55 * minute) / 1000,
          ended_at: (at - 44 * minute) / 1000, distance_km: 10, energy_kwh: 2.5, efficiency: 25, duration_min: 11, avg_speed_kmh: 35, point_count: 2 },
          ...(overlapping ? [overlapping.trip] : [])] });
      }
      if (msg.type === 'leapmotor/trips/delete') {
        totals.deletes++;
        if (msg.trip_id !== 'ledger-test') return error('not_found');
        const deleted = !tripDeleted;
        tripDeleted = true;
        return ok({ vin, deleted });
      }
      if (msg.type === 'leapmotor/trips/track' && (msg.trip_id === 'ledger-test' || (msg.trip_id === 'active-trip' && fail === 'active-ledger'))) {
        const start = at - (msg.trip_id === 'active-trip' ? 5 : 55) * minute;
        const reply = () => ok({ vin, points: [[31.221, 121.53, 31, start / 1000, 62],
          [31.224, 121.534, 42, (start + minute) / 1000, 61], [31.228, 121.54, 68, (start + 2 * minute) / 1000, 60],
          [null, null, 52, (start + 3 * minute) / 1000, 59]] });
        if (fail === 'slow-track') return setTimeout(reply, 1400);
        return reply();
      }
      if (msg.type === 'leapmotor/charging/history') {
        totals.charges++;
        if (fail === 'charge-unavailable') return error('not_found');
        const active = fail === 'active-charge' ? [{ id: 'active-charge', started_at: (at - 7 * minute) / 1000,
          last_at: at / 1000, active: true, charge_type: 'ac', kwh: 4.2, soc_start: 54, soc_end: 61,
          power_samples: [[(at - 2 * minute) / 1000, 6.8], [at / 1000, 7.4]], soc_samples: [58, 61] }] : [];
        return ok({ vin, sessions: fail === 'empty-ledger' ? [] : [{ id: 'ledger-charge', started_at: (at - 30 * minute) / 1000,
          ended_at: (at - 3 * minute) / 1000, charge_type: 'ac', kwh: 16, official_energy_kwh: 16.2,
          power_samples: [[(at - 28 * minute) / 1000, 6.8], [(at - 19 * minute) / 1000, null], [(at - 10 * minute) / 1000, 7.1]],
          soc_samples: [43, 55, 67] }, ...active, ...(overlapping ? [overlapping.charge] : [])], official: { records: [
          { key: 'sampled', started_at: (at - 31 * minute) / 1000, ended_at: (at - 3 * minute) / 1000, charge_type: 'dc', energy_kwh: 22.8 },
          { key: 'official-only', started_at: (at - 180 * minute) / 1000, ended_at: (at - 155 * minute) / 1000, charge_type: 'dc', energy_kwh: 31.4 },
        ] } });
      }
      if (msg.type === 'leapmotor/energy/daily') {
        totals.energy++;
        return ok({ vin, pending: 0, days: [{ day: new Intl.DateTimeFormat('sv-SE').format(new Date(at)), km: 17.5, kwh: 4.2, drv: 3.1, ac: .9, oth: .2 }] });
      }
      if (msg.type === 'leapmotor/charging/records/v1') {
        if (fail === 'limited') return error('unauthorized');
        const start = at - 40 * 86_400_000;
        return ok({ ...scope, vin, contract_version: 1, snapshot_id: 'older-expenses', coverage: 'complete',
          requested_range: { from_ms: msg.from_ms, to_ms: msg.to_ms }, rows: [{ record_id: 'older-dc',
            phase: 'completed', started_at_ms: start, ended_at_ms: start + 40 * minute, charge_type: 'dc', energy: { kwh: 20 } }], has_more: false });
      }
    }
    if (msg.vin === secondVin && msg.type === 'leapmotor/trips/list') return ok({ vin: secondVin, trips: [{ id: 'second-trip',
      started_at: (at - 55 * minute) / 1000, ended_at: (at - 44 * minute) / 1000, distance_km: 77, duration_min: 11 }] });
    if (msg.vin === secondVin && msg.type === 'leapmotor/charging/history') return ok({ vin: secondVin, sessions: [] });
    if (msg.vehicle_id !== scope.vehicle_id) return error('vehicle_required');
    if (msg.type === 'leapmotor/sync/v1/bootstrap') {
      totals.bootstrap++;
      if (!msg.page_token) return ok({ ...scope, items: [{ entity_type: 'observation', data: obs[0] }], has_more: true, next_page_token: 'page-2' });
      if (msg.page_token !== 'page-2') return error('snapshot_expired');
      return ok({ ...scope, items: [{ entity_type: 'observation', data: obs[1] }, { entity_type: 'record', data: record }], has_more: false, cursor: 'cursor-1' });
    }
    if (msg.type === 'leapmotor/sync/v1/pull') {
      totals.pull++;
      if (fail === 'reset' && !reset) { reset = true; return error('reset_required'); }
      return ok({ ...scope, changes: [{ seq: 1, op: 'observation.upsert', entity_id: 'point-2', data: obs[1] }], has_more: false, next_cursor: 'cursor-2' });
    }
    if (msg.type === 'leapmotor/sync/v2/membership') {
      totals.membership++;
      return ok({ ...scope, protocol_version: 2, kind: 'trip', record_id: 'fixture', membership_revision: 1, coverage: 'complete',
        observation_ids: obs.map(o => o.observation_id), snapshot_id: 'fixture-membership', observation_count: 2, has_more: false });
    }
    return error('unknown_command');
  });
});
server.listen(port, '127.0.0.1', () => console.log('Mock HA listening on ' + host));
