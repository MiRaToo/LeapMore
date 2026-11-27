import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { browser, wait } from './cdp.mjs';

const url = process.env.LEAPMORE_DEMO_ORIGIN ?? 'http://127.0.0.1:5175/';
function installFixture() {
  const vehicle = { id: 'review-c10', vin: 'REVIEWVIN00000001', nickname: '我的 C10', model: 'C10', source: 'live' };
  const second = { ...vehicle, id:'review-b10', vin:'REVIEWVIN00000002', nickname:'家里的 B10', model:'B10' };
  const cars = [vehicle, second];
  const account = sessionStorage.getItem('trip-fixture-account') ?? crypto.randomUUID();
  sessionStorage.setItem('trip-fixture-account', account);
  const scope = JSON.stringify([account, vehicle.id, vehicle.vin]);
  for (const [key, value] of Object.entries({ mode: 'cloud', activeVehicle: vehicle.id, ...(!sessionStorage.getItem('android') && {source:'phone'}), theme: 'light', recordListViews: { trips: 'simple', charges: 'simple' } })) {
    localStorage.setItem('leapmore.' + key, JSON.stringify(value));
  }
  const creds = { account: { userId: account, token: 'fixture', expiresAt: Date.now() + 86400000 },
    car: { accessToken: 'fixture'.repeat(12), hkdfKeyHex: 'ab'.repeat(16), expiresAt: Date.now() + 86400000 },
    deviceId: 'fixture', vehicles: cars };
  let status = JSON.parse(sessionStorage.getItem('trip-fixture-state') ?? 'null') ?? {
    scope, vehicleId:vehicle.id, vehicle: vehicle.nickname, phase: 'idle', lastSample: 0, note: '',
  };
  let sampling = sessionStorage.getItem('trip-fixture-report') ? JSON.parse(sessionStorage.getItem('trip-fixture-report')) : undefined;
  const counts = () => JSON.parse(sessionStorage.getItem('trip-fixture-counts') ?? '{"web":{},"native":0,"start":0}');
  function count(fn) { const values = counts(); fn(values); sessionStorage.setItem('trip-fixture-counts',JSON.stringify(values)); }
  window.tripCounts = counts;
  window.tripActivity = 'charge';
  const store = () => sessionStorage.setItem('trip-fixture-state', JSON.stringify(status));
  let seq = 0, active = false;
  const pending = [];
  function frame(at, motion, odometer, speed) {
    pending.push({ seq: ++seq, frame: { at, data: { motion, odometer, speed, soc: 80, charge: 'unplugged' },
      changed: ['motion', 'odometer', 'speed', 'soc', 'charge'] } });
  }
  if (!sessionStorage.getItem('trip-fixture-history')) {
    const t = Date.now() - 18 * 60000;
    frame(t, 'parked', 12080, 0);
    for (let i = 0; i <= 12; i++) frame(t + (i + 1) * 60000, 'driving', 12080 + i * .8, 48);
    frame(t + 14 * 60000, 'parked', 12090.4, 0);
  }
  const methods = { LeapTrip: ['configure','reading','state','start','stop','batch','ack','clear','pendingShortcut','applyShortcut','addListener','removeListener'], LeapVault: ['get','set','remove'],
    CapacitorHttp: ['request'], LeapWidget: ['configure','update','consumeDemo'], App: ['addListener','removeListener','getLaunchUrl','getInfo'],
    Browser: ['addListener','removeListener','close'] };
  window.webkit = { messageHandlers: { bridge: {} } };
  if (sessionStorage.getItem('older-ios')) delete methods.LeapTrip;
  const listeners = new Map();
  if (sessionStorage.getItem('android')) {
    window.androidBridge = {};
    methods.LeapRecorder = ['addListener','removeListener','getDiagnostics','start','stop','setDelay'];
  }
  const emitNative = (event, payload) => {
    for (const listener of listeners.values()) if (listener.event === event) listener.cb(payload);
  };
  let shortcut;
  window.requestRecordingShortcut = (index, start) => {
    const car = cars[index];
    shortcut = { id: crypto.randomUUID(), target: JSON.stringify(['cloud:' + account, car.id, car.vin]), start };
    window.shortcutResult = null;
    emitNative('recordingShortcut', {});
  };
  window.androidTick = km => {
    window.androidOdometer = km;
    emitNative('appStateChange', {isActive:false});
    emitNative('poll', {scope:sessionStorage.getItem('android-running')});
  };
  window.androidForeground = () => emitNative('appStateChange', {isActive:true});
  window.Capacitor = {
    PluginHeaders: Object.entries(methods).map(([name, list]) => ({ name, methods: list.map(name => ({ name, rtype: name === 'addListener' ? 'callback' : 'promise' })) })),
    nativeCallback: (plugin, method, opts, cb) => {
      const id = crypto.randomUUID();
      if (['LeapRecorder','LeapTrip','App'].includes(plugin)) listeners.set(id, { event: opts.eventName, cb });
      return id;
    }, nativePromise: async (plugin, method, opts) => {
      if (plugin === 'LeapRecorder') {
        const scope = sessionStorage.getItem('android-running');
        if (method === 'getDiagnostics') return { running: !!scope && scope === opts.scope,
          sessions: JSON.parse(sessionStorage.getItem('android-sessions-' + opts.scope) ?? '[]') };
        if (method === 'removeListener') listeners.delete(opts.callbackId);
        if (method === 'start' || method === 'stop') {
          const running = method === 'start', reason = running ? '' : opts?.reason || 'user';
          if (running) {
            sessionStorage.setItem('android-running', opts.scope);
            sessionStorage.setItem('android-starts', 1 + Number(sessionStorage.getItem('android-starts')));
          } else {
            sessionStorage.removeItem('android-running');
            sessionStorage.setItem('android-sessions-' + scope, JSON.stringify([{reason}]));
          }
          emitNative('status', {running,reason,scope: running ? opts.scope : scope});
        }
        return {};
      }
      if (plugin === 'App' && method === 'removeListener') listeners.delete(opts.callbackId);
      if (plugin === 'LeapVault') return method === 'get' && opts.key === 'leapmotor-session' ? { value: JSON.stringify(creds) } : {};
      if (plugin === 'CapacitorHttp') {
        const path = new URL(opts.url).pathname;
        let data = [];
        if (path.endsWith('/vehicle/list')) data = { bindcars: cars.map(c=>({carId:c.id,vin:c.vin,nickName:c.nickname,seriesName:c.model})) };
        if (path.endsWith('/signal/info/query')) {
          const car = cars.find(c => c.vin === opts.headers.carvin) ?? vehicle;
          count(v => v.web[car.id] = (v.web[car.id] ?? 0) + 1);
          if (window.holdTripQuery) await new Promise(resolve => { window.releaseTripQuery = () => { window.holdTripQuery = false; resolve(); }; });
          data = {vin:car.vin,signalMap:{sts:Date.now(),1010:0,100003:car === second ? 34 : 65}};
          if (window.androidOdometer) Object.assign(data.signalMap, {1318:window.androidOdometer,1010:1,1319:45});
        }
        return {status:200, data:{code:0,data}};
      }
      if (plugin !== 'LeapTrip') return {};
      if (method === 'removeListener') { listeners.delete(opts.callbackId); return {}; }
      if (method === 'pendingShortcut') return shortcut ?? {};
      if (method === 'applyShortcut') {
        if (!shortcut || opts.id !== shortcut.id) throw Error('快捷指令已失效');
        const requested = shortcut; shortcut = undefined;
        window.shortcutResult = opts.issue ?? 'ok';
        if (opts.issue) throw Error(opts.issue);
        if (requested.start !== (status.phase === 'recording')) {
          await window.Capacitor.nativePromise('LeapTrip', requested.start ? 'start' : 'stop', {account, id:vehicle.id, vin:vehicle.vin});
        }
        return {};
      }
      if (method === 'configure') { active = opts.account === account && opts.cars.some(c => c.id === vehicle.id); return {}; }
      if (opts.account !== account || !cars.some(c => c.id === opts.id && c.vin === opts.vin)) throw Error('车辆未绑定');
      if (method === 'start') {
        if (!active || opts.id !== vehicle.id) throw Error('车辆未授权');
        if (window.denyNextTripStart) { window.denyNextTripStart = false; throw Error('系统暂未允许后台记录，请稍后重试'); }
        const previousSample = status.lastSample;
        const lastSample = Math.max(Date.now(), previousSample + 2), charging = window.tripActivity === 'charge';
        count(v=>{ v.start++; v.native++; });
        status = {...status, phase:'recording', lastSample, note:''};
        sampling = {vehicleId:vehicle.id,updatedAt:lastSample,reportedAt:lastSample,soc:73,locked:true,charging:charging?'charging':'unplugged',
          chargeType:'ac',chargingPowerKw:charging?7.2:null,isDriving:!charging,parked:charging,speedKmh:charging?0:42,tirePressureKpa:[null,null,null,null]};
        sessionStorage.setItem('trip-fixture-report',JSON.stringify(sampling));
        if (charging) {
          pending.push({seq:++seq,frame:{at:lastSample,data:{motion:'parked',soc:73,charge:'charging',chargeType:'ac',power:7.2},
            changed:['motion','soc','charge','chargeType','power']}});
        } else {
          frame(Math.max(lastSample-1000, previousSample+1), 'driving', 12091, 36);
          frame(lastSample, 'driving', 12091.7, 42);
        }
        store();
      }
      if (method === 'stop') { status = {...status, phase:'ended', note:''}; store(); }
      const ownsSampling = opts.id === vehicle.id && status.phase === 'recording';
      const reading = ownsSampling ? { ownsSampling, report:sampling, reportVersion:status.lastSample } : { ownsSampling };
      if (method === 'reading') return reading;
      if (method === 'batch') return opts.id === vehicle.id ? {cursor:pending.at(-1)?.seq ?? 0, frames:pending.map(s=>s.frame)} : {cursor:0,frames:[]};
      if (method === 'ack') { while (pending[0]?.seq <= opts.cursor) pending.shift(); sessionStorage.setItem('trip-fixture-history','1'); return {}; }
      return { ...status, ...reading };
    }
  };
  window.publishChargeFixture = () => {
    const at = Math.max(Date.now(), status.lastSample + 1);
    count(v => v.native++);
    status = {...status, lastSample:at};
    sampling = {...sampling, reportedAt:at, updatedAt:at, soc:74};
    pending.push({ seq:++seq, frame:{at,data:{motion:'parked',soc:74,charge:'charging',chargeType:'ac',power:7.2},
      changed:['motion','soc','charge','chargeType','power']} });
    sessionStorage.setItem('trip-fixture-report',JSON.stringify(sampling));
    store();
    document.dispatchEvent(new Event('visibilitychange'));
  };
  window.interruptTripFixture = () => {
    status = {...status, phase:'interrupted', note:'已保留中断前的采样'};
    pending.push({seq:++seq, frame:{at:status.lastSample+1,data:{},changed:[],tripBoundary:'interrupted'}});
    store();
    document.dispatchEvent(new Event('visibilitychange'));
  };
}
const b = await browser('about:blank', 390, 844);
async function until(check) {
  for (let i=0;i<100;i++) { if (await b.run(check)) return; await wait(100); }
  throw Error('未达到 ' + check + '\n' + await b.run('document.body.innerText') + '\n' + b.errors.join('\n'));
}
async function phase(value) {
  await until('document.querySelector(".manual-trip")?.dataset.phase === '+JSON.stringify(value)+' && !document.querySelector(".manual-trip button")?.disabled');
}
async function capture(name) {
  if (!process.env.LEAP_TRIP_SCREENSHOTS) return;
  await until('!document.querySelector(".toast")?.innerText');
  await b.run('document.fonts.ready.then(()=>true)');
  const {data} = await b.send('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});
  await writeFile(join(process.env.LEAP_TRIP_SCREENSHOTS, name+'.png'),Buffer.from(data,'base64'));
}
try {
  await b.send('Page.addScriptToEvaluateOnNewDocument',{source:'('+ installFixture.toString() +')()'});
  await b.navigate(url+'#/records');
  await phase('idle'); await until('document.body.innerText.includes("10.4 km")');
  assert.ok(await b.run('document.querySelector(".manual-trip").getBoundingClientRect().height <= 72'), '待记录控件应保持紧凑');
  assert.ok(await b.run('document.querySelector(".manual-trip button").getBoundingClientRect().height >= 44'), '缩小记录卡后仍应保留按钮的触控区域');
  await capture('trip-idle');
  const route = async path => { await b.run('location.hash=' + JSON.stringify(path)); };
  await route('/home'); await until(`!!document.querySelector('.hero-tools button[aria-label="刷新"]:not(:disabled)')`);
  await b.run('window.holdTripQuery = true'); await b.click('.hero-tools [aria-label="刷新"]');
  await until('typeof window.releaseTripQuery === "function"');
  await route('/charging'); await phase('idle');
  await capture('charging-idle');
  const startReads = await b.run('tripCounts().web["review-c10"]');
  await b.click('.manual-trip button');
  await wait(120);
  assert.equal(await b.run('tripCounts().start'),0,'启动应等待在途的同车查询结束');
  await b.run('releaseTripQuery()'); await phase('recording');
  await until('document.querySelector(".charging-status")?.innerText.includes("73%")');
  await capture('charging-recording');
  const stamp = await b.run('document.querySelector(".manual-trip time").dateTime');
  await route('/records?tab=charges'); await phase('recording');
  await until('document.body.innerText.includes("7.2 kW")');
  await capture('charging-history-recording');
  await b.run('publishChargeFixture()');
  await until('document.querySelector(".manual-trip-metrics")?.innerText.includes("74.0%")');
  await route('/charging'); await until('document.querySelector(".charging-status")?.innerText.includes("74%")');
  const updatedStamp = await b.run('document.querySelector(".manual-trip time").dateTime');
  assert.notEqual(updatedStamp,stamp);
  await route('/records'); await phase('recording');
  assert.equal(await b.run('document.querySelector(".manual-trip time").dateTime'),updatedStamp);
  await route('/home'); await until(`!!document.querySelector('.hero-tools button[aria-label="刷新"]:not(:disabled)')`);
  await b.click('.hero-tools [aria-label="刷新"]');
  await route('/charging'); await b.reload(); await phase('recording');
  await until('document.querySelector(".charging-status")?.innerText.includes("74%")');
  await route('/vehicle-manage'); await until('document.querySelectorAll(".vcard").length === 2');
  await b.click('.vcard:nth-of-type(2)'); await route('/charging');
  await until('document.querySelector(".charging-status")?.innerText.includes("34%")');
  assert.ok(await b.run('tripCounts().web["review-b10"] >= 1'));
  await route('/vehicle-manage'); await until('document.querySelectorAll(".vcard").length === 2');
  await b.click('.vcard'); await route('/records?tab=charges'); await phase('recording');
  assert.equal(await b.run('tripCounts().web["review-c10"]'),startReads,'记录页切换、手动刷新、切车、重开均应复用原生采样');
  assert.equal(await b.run('tripCounts().native'),2);
  await route('/records'); await phase('recording'); await b.click('.manual-trip button'); await phase('ended');
  await until('tripCounts().web["review-c10"] > '+startReads);
  await route('/charging'); await phase('ended');
  await b.run("window.tripActivity = 'drive'"); await route('/records'); await phase('ended');
  await b.click('.manual-trip button'); await phase('recording');
  assert.match(await b.run('document.querySelector(".manual-trip time").innerText'),/\d{2}:\d{2}:\d{2}/);
  await until("document.querySelector('.manual-trip-metrics')?.innerText.includes('0.7 km')");
  await capture('trip-recording');
  await b.run('interruptTripFixture()'); await phase('interrupted');
  const timestamp = await b.run('document.querySelector(".manual-trip time").dateTime');
  await until('document.querySelector(".manual-trip-note")?.textContent.includes("中断")');
  await capture('trip-interrupted');
  await b.reload(); await phase('interrupted');
  assert.equal(await b.run('document.querySelector(".manual-trip time").dateTime'),timestamp);
  await b.click('.manual-trip button'); await phase('recording');
  await b.click('.manual-trip button'); await phase('ended');
  const selectSource = async label => {
    await route('/records-source'); await until('!!document.querySelector(".source-opt")');
    await b.run(`[...document.querySelectorAll('.source-opt')].find(el => el.querySelector('b').textContent === ${JSON.stringify(label)}).click()`);
  };
  const starts = await b.run('tripCounts().start');
  await selectSource('关闭记录');
  await route('/records'); await until('document.body.innerText.includes("10.4 km")');
  assert.equal(await b.run('!!document.querySelector(".manual-trip,.recording")'), false);
  await b.run('requestRecordingShortcut(0, true)'); await until('window.shortcutResult?.includes("启用手机记录")');
  await selectSource('手机记录');
  await until('tripCounts().start === ' + (starts + 1));
  await phase('recording');
  assert.equal(await b.run("document.querySelector('.manual-trip-name b').textContent"),'后台记录');
  await selectSource('手机记录');
  await route('/records'); await phase('recording');
  assert.equal(await b.run('tripCounts().start'), starts + 1);
  await b.click('.manual-trip button'); await phase('ended');
  await route('/records-source'); await phase('ended');
  await b.run('window.denyNextTripStart = true');
  await selectSource('手机记录');
  await until('document.querySelector(".manual-trip-note")?.textContent.includes("系统暂未允许")');
  assert.equal(await b.run('document.querySelector(".manual-trip button").textContent'),'开始记录');
  await b.click('.manual-trip button'); await phase('recording');
  await route('/records?tab=charges'); await phase('recording');
  await b.click('.manual-trip button'); await phase('ended');
  const shortcutStarts = await b.run('tripCounts().start');
  await b.run('requestRecordingShortcut(0, true)'); await phase('recording');
  await b.run('requestRecordingShortcut(0, true)'); await until('window.shortcutResult === "ok"');
  assert.equal(await b.run('tripCounts().start'), shortcutStarts + 1);
  await b.run('requestRecordingShortcut(1, false)'); await until('window.shortcutResult?.includes("另一辆车")');
  await b.run('requestRecordingShortcut(0, false)'); await phase('ended');
  await b.run('requestRecordingShortcut(0, false)'); await until('window.shortcutResult === "ok"');
  await b.run("sessionStorage.setItem('older-ios','1')"); await b.reload();
  await until('!!document.querySelector(".period-summary")'); assert.equal(await b.run('!!document.querySelector(".manual-trip")'),false);
  await route('/charging'); await until('!!document.querySelector(".charging-status")');
  assert.equal(await b.run('!!document.querySelector(".manual-trip")'),false);
  await route('/records?tab=charges'); await until('!!document.querySelector(".period-summary")');
  assert.equal(await b.run('!!document.querySelector(".manual-trip")'),false);
  await b.run("sessionStorage.removeItem('older-ios');sessionStorage.setItem('android','1');localStorage.removeItem('leapmore.source');localStorage.removeItem('leapmore.chosePhoneRecording')"); await b.reload();
  await until('!!document.querySelector(".period-summary")');
  assert.equal(await b.run("sessionStorage.getItem('android-starts')"), null);
  // Older releases wrote their hybrid default even before the first source selection.
  await b.run("localStorage.setItem('leapmore.source', JSON.stringify('hybrid'))"); await b.reload();
  await until('document.body.innerText.includes("开启后台记录")');
  assert.equal(await b.run("sessionStorage.getItem('android-starts')"), null);
  await selectSource('手机记录');
  await until('document.body.innerText.includes("手机后台记录已启动")');
  await b.run('androidTick(5101)');
  await until(`import('/src/data/localDatabase.ts').then(async db => (await db.readDataset('cloud-frames:' +
    sessionStorage.getItem('trip-fixture-account') + ':review-c10'))?.some(frame => frame.data.odometer === 5101))`);
  await b.run('androidForeground()');
  await selectSource('手机记录');
  await route('/records'); await b.reload();
  await until('!!document.querySelector(".period-summary")');
  assert.equal(await b.run("Number(sessionStorage.getItem('android-starts'))"), 1);
  await route('/background-guide');
  await until('[...document.querySelectorAll("button")].some(el => el.textContent === "停止后台记录")');
  await b.run('[...document.querySelectorAll("button")].find(el => el.textContent === "停止后台记录").click()');
  await route('/records'); await b.reload();
  await until('document.body.innerText.includes("开启后台记录")');
  assert.equal(await b.run("sessionStorage.getItem('android-running')"), null);
  await selectSource('手机记录 + HA 同步');
  await until('location.hash === "#/ha" && !!sessionStorage.getItem("android-running")');
  await selectSource('HA 同步');
  await until('!sessionStorage.getItem("android-running")');
  await selectSource('手机记录');
  await until('!!sessionStorage.getItem("android-running")');
  await selectSource('关闭记录');
  await until('!sessionStorage.getItem("android-running")');
  await selectSource('手机记录');
  await route('/records');
  await until('!!document.querySelector(".period-summary")'); assert.equal(await b.run('!!document.querySelector(".manual-trip")'),false);
  await route('/charging'); await until('!!document.querySelector(".charging-status")');
  assert.equal(await b.run('!!document.querySelector(".manual-trip")'),false);
  await route('/records?tab=charges'); await until('!!document.querySelector(".period-summary")');
  assert.equal(await b.run('!!document.querySelector(".manual-trip")'),false);
  // Reopen an Android store written by the version that persisted a gap after 90 s.
  await b.run(`(async () => {
    const { saveDataset } = await import('/src/data/localDatabase.ts');
    const at = Date.now() - 29 * 60000;
    const samples = [[0,0],[20,0],[420,4],[460,5],[720,8],[760,9],[1260,14],[1280,14],[1300,14]];
    const frames = samples.flatMap(([s, km], i) => {
      const row = { at: at + s * 1000, changed: ['motion', 'odometer'],
        data: { motion: i === samples.length - 1 ? 'parked' : 'driving', odometer: 5000 + km } };
      return [1,3,5].includes(i) ? [row, { at: row.at + 1, changed: [], data: {} }] : [row];
    });
    await saveDataset('cloud-frames:' + sessionStorage.getItem('trip-fixture-account') + ':review-c10', frames);
  })()`);
  await route('/records?tab=trips'); await b.reload();
  await until('document.querySelector(".record-total")?.textContent === "1 段 · 14.0 km"');
  assert.equal(await b.run('document.querySelectorAll(".trip-row").length'), 1);
  await b.click('.trip-row');
  await until('document.querySelector(".trip-info")?.innerText.includes("14.0")');
  const detailHash = await b.run('location.hash');
  await selectSource('关闭记录');
  await until('!sessionStorage.getItem("android-running")');
  await route('/records'); await b.reload();
  await until('document.querySelector(".record-total")?.textContent === "1 段 · 14.0 km"');
  assert.equal(await b.run('!!document.querySelector(".recording,.manual-trip")'), false);
  assert.equal(await b.run('!!document.querySelector(".record-range-toggle")'), true);
  await b.click('.trip-row'); await until('document.querySelector(".trip-info")?.innerText.includes("14.0")');
  assert.equal(await b.run('location.hash'), detailHash);
  assert.deepEqual(b.errors,[]);
  console.log('通过：行程与充电同步、在途交接、同车零额外车况请求、换车隔离、停止恢复、中断续录及平台隔离');
} finally { await b.close(); }
