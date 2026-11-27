import { strict as assert } from 'node:assert';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { checkInSigned, performCheckIn, type PageStep } from '../src/data/cloud/checkIn.ts';

function scenario(steps: PageStep[], states: boolean[]) {
  const calls: string[] = [];
  const io = { active: () => true, pause: async () => {},
    signed: async () => { calls.push('status'); return states.shift()!; },
    open: async () => { calls.push('open'); }, close: async () => { calls.push('close'); },
    beforeSubmit: async () => { calls.push('claim'); },
    step: async (submit: boolean) => { calls.push(submit ? 'submit' : 'inspect'); return steps.shift() ?? 'waiting'; } };
  return { calls, io };
}

test('uses account signInState, including 0, and rejects an invalid or expired response', () => {
  assert.equal(checkInSigned({ _status: 200, code: 200, data: { signInState: 0 } }), false);
  assert.equal(checkInSigned({ _status: 200, code: '200', data: { signInState: '1' } }), true);
  for (const data of [{}, { signInState: null }, { signInState: 'fail' }]) {
    assert.throws(() => checkInSigned({ _status: 200, code: 200, data }));
  }
  assert.throws(() => checkInSigned({ _status: 401 }), /login/);
});

test('signed accounts skip the page, and a new check-in uses the page once and confirms with the account service', async () => {
  const done = scenario([], [true]);
  assert.equal(await performCheckIn(done.io), 'done');
  assert.deepEqual(done.calls, ['status']);
  const first = scenario(['waiting', 'ready', 'submitted', 'signed'], [false, true]);
  assert.equal(await performCheckIn(first.io), 'done');
  assert.deepEqual(first.calls, ['status','open','inspect','inspect','claim','submit','inspect','status','close']);
});

test('verification, ambiguous outcomes and turning off never cause a second click', async () => {
  for (const steps of [['manual'], ['ready','submitted','manual'], ['ready','submitted','signed']] as PageStep[][]) {
    const { io, calls } = scenario(steps, [false,false]);
    assert.equal(await performCheckIn(io), 'manual');
    assert.ok(calls.filter(x => x === 'submit').length <= 1);
    assert.equal(calls.at(-1), 'close');
  }
  const { io, calls } = scenario(['ready'], [false]);
  io.beforeSubmit = async () => { io.active = () => false; };
  await assert.rejects(performCheckIn(io), /cancelled/);
  assert.ok(!calls.includes('submit'));
  assert.equal(calls.at(-1), 'close');
});

test('page adapter only clicks the official daily button in the trusted top-level page', () => {
  const source = readFileSync(new URL('../public/checkin-page.js', import.meta.url), 'utf8');
  let clicks = 0, challenge = false, ready = true;
  const window = { top: null as unknown, SMSdk: { getDeviceId() {} }, LMGetID1: undefined as undefined | (() => unknown) };
  window.top = window;
  const location = { origin: 'https://example.org', pathname: '/lpv/user-level/my-level.html' };
  const size = () => ({ height: 30 });
  const button = { textContent: '签到', getBoundingClientRect: size, click: () => { clicks++; } };
  const document = { querySelector: (selector: string) => selector.includes('geetest') && challenge ? { getBoundingClientRect: size } :
      selector === '.sign .task-btn-sign' && ready ? button : null };
  const step = runInNewContext(source, { window, location, document });
  assert.equal(step({}, true), 'waiting');
  assert.equal(window.LMGetID1, undefined);
  location.origin = 'https://apptec.leapmotor.com';
  ready = false;
  assert.equal(step({}, true), 'waiting');
  ready = true;
  assert.equal(step({}, false), 'ready');
  challenge = true;
  assert.equal(step({}, true), 'manual');
  challenge = false;
  button.textContent = '补签';
  assert.equal(step({}, true), 'waiting');
  button.textContent = '签到';
  assert.equal(step({}, true), 'submitted');
  assert.equal(clicks, 1);
});
