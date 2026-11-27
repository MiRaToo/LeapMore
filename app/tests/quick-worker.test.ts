import { before, test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import type { CarState } from '../src/data/types.ts';
import type { Frame } from '../src/data/ha/measurements.ts';
import { buildQuickWorker } from '../scripts/quick-worker.mjs';

let js = '';
before(async () => { js = (await buildQuickWorker(false))[0].output[0].code; });

async function press(action: string, options: {mode?:string; confirm?:boolean; saved?:boolean; entered?:string; gear?:number; denied?:boolean; rebind?:boolean; vinChanged?:boolean; uncertain?:boolean; loggedOut?:boolean; expired?:boolean; on?:boolean} = {}) {
  const vin = 'FIXTURE00012345678';
  const first = action === 'prepare';
  const id = JSON.stringify(['cloud:test', 'car-a', vin, ...(first ? ['winter'] : [])]);
  const target = { id, preset: first, ...(first && {definition:{ id:'winter', name:'冬日温暖', temperature:26, fan:3,
    climate:true, climatePreset:'warm', seat:'none', steering:false, mirrors:false, destination:null }}) };
  const writes: URLSearchParams[] = [];
  let listReads = 0, verified = false;
  const token = 'fixture-token'.repeat(8);
  let session = { account:{userId:'test',token:'fixture',accountNumber:'12345',refreshToken:'sample-refresh',expiresAt:Date.now()+(options.expired ? -1000 : 600_000)}, car:{accessToken:token,hkdfKeyHex:'ab'.repeat(16),expiresAt:Date.now()+(options.expired ? -1000 : 600_000)}, deviceId:'device', vehicles:[] };
  let finish!: (message:string)=>void;
  let result = new Promise<string>(resolve => { finish = resolve; });
  const host = {
    enteredPin: () => options.entered ?? '',
    input: () => options.rebind && verified ? '' : JSON.stringify(target),
    vault: (key:string) => {
      if (key === 'leapmotor-session') return options.loggedOut && verified ? '' : JSON.stringify(session);
      if (key.includes(':mode:')) return JSON.stringify({ mode:options.mode ?? 'instant', saved:options.saved ?? true });
      if (key.includes(':pin:')) return JSON.stringify('654321');
      return '';
    },
    session: (previous:string,next:string) => {
      if(previous !== JSON.stringify(session)) return false;
      session=JSON.parse(next);
      return true;
    },
    http: (raw:string) => {
      const req=JSON.parse(raw), path=new URL(req.url).pathname;
      let data:unknown;
      if(path.endsWith('/getnewtoken')) data={token:'renewed-account',refreshToken:'next-refresh',tokenExpired:7200};
      else if(path.endsWith('/account/v1/login')) data={accessToken:'test.'+'a'.repeat(64)+'.'+Buffer.alloc(32,1).toString('base64url'),
        signParam:{r2:'AQEB',r3:'AgIC'},tokenExpireTime:7200};
      else if (path.endsWith('/vehicle/list')) {
        listReads++;
        data={bindcars:[{carId:'car-a',vin:options.vinChanged && listReads>1 ? 'DIFFERENT' : vin,seriesName:'C10',
          ...(options.denied && {rightList:'130'})}]};
      } else if (path.endsWith('/signal/info/query')) data={vin,signalMap:{sts:Date.now(),1010: options.gear ?? 0,1938:options.on == null ? undefined : +options.on}};
      else if (path.endsWith('/getCarRoute')) data={vin,appCenter:'https://appgateway.leapmotor.com'};
      else if (path.endsWith('/verifyoperatepwdnew')) { verified=true; data=true; }
      else if (path.endsWith('/appremotectl')) {
        writes.push(new URLSearchParams(req.body));
        if (options.uncertain) throw new Error('timeout');
        data='ack';
      } else if (path.endsWith('/appremotectl/query')) data={status:'success'};
      else throw new Error('unexpected endpoint');
      return JSON.stringify({status:200,body:JSON.stringify({code:0,data})});
    },
    finish: (message: string) => finish(message),
  };
  const context=vm.createContext({QuickHost:host, crypto, Uint8Array, Uint32Array, TextEncoder, URL, URLSearchParams, btoa, atob});
  vm.runInContext(js,context);
  context.LeapDirect.run(action,id);
  let message=await result;
  if (options.confirm && /^(pin|confirm):[a-f0-9]{64}$/.test(message)) {
    assert.equal(writes.length, 0);
    assert.equal(listReads, 0);
    result = new Promise(resolve => { finish = resolve; });
    context.LeapDirect.run(action, id, message);
    message = await result;
  }
  return {message,writes};
}

test('system buttons send the bound command and wait for the vehicle receipt',async () => {
  for(const [action,id] of [['lock-only','110'],['climate-on','170'],['climate-off','170'],['find','120'],['prepare','360'],['climate-heat','170'],['climate-cool','170'],['climate-vent','170'],['climate-def','170'],['window-close','230'],['window-vent','230']]) {
    const {message,writes}=await press(action);
    assert.equal(message,'车辆已确认',action);
    assert.equal(writes.length,1);
    assert.equal(writes[0].get('cmdid'),id);
    assert.equal(writes[0].get('carvin'),'FIXTURE00012345678');
    const state=JSON.parse(writes[0].get('state')!);
    if(action==='lock-only') assert.equal(state.value,'lock');
    if(action === 'window-close' || action === 'window-vent') assert.equal(state.value, action === 'window-close' ? '0' : '2');
    if(action === 'climate-def') assert.equal(state.wshld, '2');
    if(action==='climate-on'||action==='climate-off') assert.equal(state.operate,action==='climate-on'?'manual':'off');
    if(action==='prepare') assert.match(JSON.stringify(state),/26/);
  }
});

test('direct controls stop at revoked permission, changed bind, driving, or missing instant authorization',async () => {
  for(const options of [{mode:'verify'},{mode:'reuse'},{denied:true},{rebind:true},{gear:3},{vinChanged:true},{loggedOut:true}]) {
    const {message,writes}=await press('find',options);
    assert.equal(writes.length,0,JSON.stringify(options));
    assert.notEqual(message,'车辆已确认');
  }
  assert.match((await press('find',{mode:'reuse'})).message, /^confirm:/);
  assert.match((await press('find',{mode:'verify'})).message, /^pin:/);
  assert.equal((await press('find',{mode:'reuse',confirm:true})).writes.length, 1);
  assert.equal((await press('find',{mode:'verify',confirm:true,entered:'12345'})).writes.length, 1);
  assert.equal((await press('find',{mode:'verify',confirm:true})).writes.length, 0);
  assert.equal((await press('climate-on',{on:true})).message,'空调已开启');
  assert.equal((await press('find',{expired:true})).message,'车辆已确认');
  const uncertain=await press('find',{uncertain:true});
  assert.equal(uncertain.writes.length,1);
  assert.match(uncertain.message,/结果未知/);
});

test('iOS sampler verifies the bound vehicle, rejects stale reports and enforces location grants', async () => {
  const ios = (await buildQuickWorker(false, 'ios'))[0].output[0].code;
  const vin = 'FIXTUREVIN000001', vehicle = { carId: 'A', vin, seriesName: 'C10' };
  const creds = JSON.stringify({account:{userId:'owner',token:'sample',expiresAt:Date.now()+600000},
    car:{accessToken:'fixture'.repeat(12),hkdfKeyHex:'ab'.repeat(16),expiresAt:Date.now()+600000},deviceId:'fixture'});
  let stale = false, reply: { frame?: Frame | null; report?: CarState; interrupt?: string; delay?: number } = {};
  let reportTime = Date.now();
  let signals = { 1010:3, 1319:42, 1149:0 };
  let listed = vehicle;
  let collectionTimeOnly = false;
  const calls: string[] = [];
  const host = { finish: (_: string, raw: string) => { reply = JSON.parse(raw); }, http: (raw: string) => {
    const path = new URL(JSON.parse(raw).url).pathname;
    calls.push(path);
    const data = path.endsWith('/vehicle/list') ? { bindcars: [listed] } : { vin, collectTimeMs: Date.now(), signalMap: {
      sts: collectionTimeOnly ? undefined : reportTime - (stale ? 180000 : 0), ...signals, 3:31, 2:121,
    } };
    return JSON.stringify({ status:200, body:JSON.stringify({ code:0, data }) });
  } };
  const ctx = vm.createContext({QuickHost:host, crypto, Uint8Array, Uint32Array, TextEncoder, URL, URLSearchParams, btoa, atob});
  vm.runInContext(ios,ctx);
  const sampler = ctx.LeapDirect.tripSampler(creds,'owner','A',vin);
  await sampler(false); assert.equal(reply.frame?.data.position,null);
  assert.equal(reply.report?.latitude,null);
  assert.equal(reply.report?.speedKmh,reply.frame?.data.speed);
  assert.equal(calls.filter(path=>path.endsWith('/signal/info/query')).length,1);
  await sampler(true); assert.equal(reply.frame?.data.position?.lat,31);
  assert.equal(reply.report?.latitude,31);
  // The same recording session spans parking, charging, unplugging and the next drive.
  for (const [gear, speed, connection, motion, charge] of [
    [0, 0, 0, 'parked', 'unplugged'],
    [0, 0, 1, 'parked', 'charging'],
    [0, 0, 0, 'parked', 'unplugged'],
    [3, 35, 0, 'driving', 'unplugged'],
  ] as const) {
    reportTime += 1000;
    signals = { 1010:gear, 1319:speed, 1149:connection };
    await sampler(true);
    assert.equal(reply.frame?.data.motion, motion);
    assert.equal(reply.frame?.data.charge, charge);
    assert.equal(reply.interrupt, undefined);
    assert.ok(typeof reply.delay === 'number' && reply.delay > 0);
  }
  stale = true; await sampler(true); assert.equal(reply.frame,null);
  collectionTimeOnly = true;
  await sampler(true);
  assert.equal(reply.frame, null, 'standard models require the vehicle clock');
  listed = { ...vehicle, seriesName: 'T03' };
  await ctx.LeapDirect.tripSampler(creds,'owner','A',vin)(true);
  assert.equal(reply.report?.reportedAt, null);
  assert.ok(reply.frame?.at && reply.frame.at === reply.report?.recordingFallbackAt);
  listed = {...vehicle,vin:'CHANGED'};
  await ctx.LeapDirect.tripSampler(creds,'owner','A',vin)(true);
  assert.match(reply.interrupt ?? '',/授权/);
  assert.ok(calls.every(path => path.endsWith('/vehicle/list') || path.endsWith('/signal/info/query')));
  assert.equal(vm.runInNewContext(js+'; typeof LeapDirect.tripSampler', {URL, URLSearchParams}), 'undefined');
});
