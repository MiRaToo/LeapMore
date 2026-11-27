import assert from 'node:assert/strict';
import { createCipheriv, createHash, createHmac } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { zipSync } from 'fflate';
import { browser, wait } from './cdp.mjs';

const base = process.env.LEAPMORE_DEMO_ORIGIN ?? 'http://127.0.0.1:5175/';
const origin = new URL(base).origin;
const vehicle = { carId: 'fixture-car', vin: 'LFB1A2B3C4D000001', nickName: '本地验收车辆', seriesName: 'C10' };
const secondVehicle = { carId: 'fixture-second', vin: 'FIXTURE0054321', nickName: '第二辆验收车辆', seriesName: 'C11' };
const access = 'local-session-test-account';
const requests = { sms: 0, signIn: 0, exchange: 0 };
const verifiedPins = [];
const remoteWrites = [];
let pinCode = 0, commandStatus = 'pending', commandHttpStatus = 200, gear = 0;
let t03 = '', routeRequests = 0, regionReads = 0;
const carHosts = ['appuser.leapmotor.cn', 'app-gw-global-master.leapmotor.com', 'appgateway.leapmotor.com'];
const marketHosts = ['www-app.leapmotor.com', 'apptec.leapmotor.cn', 'ueapp.oss-cn-hangzhou.aliyuncs.com', 'carod-center.leapmotor.cn', 'ueapp-oss-static.leapmotor.com'];
let searchCity, searchLocation;
const amapAddress = '上海市浦东新区锦绣路100号验收车位';
const hybridHA = process.env.LEAPMORE_HYBRID_HA_TEST_ORIGIN;
const greenRender = 'https://ueapp-oss-static.leapmotor.com/fixture-green.png';
const blueRender = 'https://ueapp-oss-static.leapmotor.com/fixture-blue.png';
const whiteRender = 'https://ueapp-oss-static.leapmotor.com/fixture-white.png';
const ownerPicture = 'https://ueapp-oss-static.leapmotor.com/fixture-owner.png';
const marketReads = [];
const nonce = Buffer.alloc(16, 11).toString('base64url');
let moduleRights = '100,200,300,400';
let boundOwner = false, sentrySignal = 0;
let preparationPlans = [];
let includeSecondVehicle = false;
const viewer = new URL('../public/car3d-demo/', import.meta.url);
const assets = (directory, names) => Object.fromEntries(names.map(name => [name, readFileSync(new URL(name, directory))]));
const makeZip = files => Buffer.from(zipSync(files, { level: 0 })).toString('base64');
const zip = process.env.LEAPMORE_TEST_3D === '1' ? {
  viewer: makeZip({ ...assets(viewer, ['index.js', 'FBX.worker.js']),
    ...assets(viewer, ['textures/', 'models/'].flatMap(dir => readdirSync(new URL(dir, viewer), { recursive: true, withFileTypes: true })
      .filter(item => item.isFile()).map(item => relative(fileURLToPath(viewer), join(item.parentPath, item.name))))) }),
  model: makeZip(assets(viewer, readdirSync(new URL('C10_2026/', viewer)).map(name => 'C10_2026/' + name))),
} : null;
const ended = Date.now() - 300_000, started = ended - 3_600_000;
const energyDay = new Date(Date.now() + 8 * 3_600_000).toISOString().slice(0, 10);
let chargeRequests = 0;
const fuelRequests = [];
let soc = 73, reportedAt = Date.now() - 3_600_000, emptySignals = false, minExchange = 0, collectedAt = null;
let recordSignals = {};
let rejectSession = false;
let openings = { 1298: 0, 1281: 1, 1693: 2, 1694: 0, 1695: 0, 1696: 0, 1724: 100 };
const secondPreheat = { set_id: 'another-plan', on: '0', start_time: '2026-11-27 09:00:00', days: [], preserved: true };
let preheatPlans = [{ set_id: 'preheat-test', on: '1', start_time: '2026-11-26 07:00:00', days: [1] }, secondPreheat];
const carToken = count => 'eyJhbGciOiJub25lIn0.' + Buffer.from(JSON.stringify({ fixture: count, device: 'local-browser-test' })).toString('base64url') + '.' + nonce;
const expectedPin = token => {
  const middle = text => createHash('md5').update(text).digest('hex').slice(8, 24);
  const cipher = createCipheriv('aes-128-cbc', middle(token.slice(0, 32)), middle(token.slice(32, 64)));
  return Buffer.concat([cipher.update('654321'), cipher.final()]).toString('base64');
};

async function open() {
  const tab = await browser('about:blank');
  await tab.send('Page.addScriptToEvaluateOnNewDocument', { source: 'delete AbortSignal.prototype.throwIfAborted; delete AbortSignal.timeout;' });
  tab.on('Fetch.requestPaused', ({ request, requestId }) => {
    const url = new URL(request.url), path = url.pathname;
    const headers = Object.fromEntries(Object.entries(request.headers).map(([key, value]) => [key.toLowerCase(), value]));
    let data = {}, status = 200, code, binary, payload, contentType;
    if (request.method === 'OPTIONS') status = 204;
    else if (rejectSession && ['/signal/info/query', '/account/v1/login', '/appuseroperate/getnewtoken'].some(suffix => path.endsWith(suffix))) code = 302002004;
    else if (url.hostname === 'restapi.amap.com' && path.endsWith('/regeo')) payload = { status:'1', regeocode:{ formatted_address:amapAddress, addressComponent:{citycode:'021'} } };
    else if (url.hostname === 'restapi.amap.com' && path.endsWith('/around')) payload = {status:'1', pois:[{
      id:'nearby', name:'验收附近车站', cityname:'上海市', adname:'浦东新区', location:'121.471,31.231' }]};
    else if (url.hostname === 'restapi.amap.com' && path.endsWith('/inputtips')) {
      searchCity = url.searchParams.get('city');
      searchLocation = url.searchParams.get('location');
      payload = { status:'1', tips:[{
      id:'mock-library', name:'验收图书馆', district:'上海市浦东新区', address:'锦绣路200号', location:'121.471,31.231' }] };
    }
    else if (path.endsWith('/sendmessagecode')) requests.sms++;
    else if (path.endsWith('/check_login_with_phone')) {
      requests.signIn++;
      data = { appLoginVO: { token: access, accountId: 'fixture-account', expiresIn: 7200, refreshToken: 'fixture-refresh' } };
    } else if (path.endsWith('/account/v1/login')) {
      requests.exchange++;
      data = { accessToken: carToken(requests.exchange), signParam: { r2: nonce, r3: nonce }, tokenExpireTime: requests.exchange === 1 ? 1 : 7200 };
    } else if (path.endsWith('/v1/vehicle/list')) data = { [boundOwner ? 'bindcars' : 'sharedcars']: [
      { ...vehicle, ...(t03 ? { carType: 'T03', seriesName: 'T03' } : {}), moduleRights, rightList: '110,161,170,360,361,400' },
      ...(includeSecondVehicle ? [{ ...secondVehicle, moduleRights }] : []),
    ] };
    else if (path.endsWith('/v1/vehicle/getCarRoute')) {
      routeRequests++;
      const vin = url.searchParams.get('vin');
      assert.ok([vehicle.vin, secondVehicle.vin].includes(vin));
      data = { vin, appRegion: 'https://appgateway.leapmotor.com', appCenter: 'https://appgateway.leapmotor.com' };
    }
    else if (path.endsWith('/appremotectl/getappointment')) {
      assert.ok([vehicle.vin, secondVehicle.vin].includes(url.searchParams.get('carvin')));
      assert.ok(['161', '361'].includes(url.searchParams.get('cmdid')));
      const { signStr, ...query } = Object.fromEntries(url.searchParams);
      const signed = { ...query, token: headers.deviceid === 'fixture-device' ? 'fixture' : access };
      assert.equal(signStr, createHash('md5').update(Object.keys(signed).sort().map(key => signed[key]).join('')).digest('hex').slice(8, 24));
      data = JSON.stringify({ controls: url.searchParams.get('cmdid') === '361' ? preparationPlans : preheatPlans });
    }
    else if (path.endsWith('/signal/info/query')) {
      if (t03) {
        assert.equal(headers.cartype, 'T03');
        if (t03 === 'numbered') {
          data = { vin: vehicle.vin, collectTime: '2026-10-20 08:09:10',
            signalMap: { 1204: 62, 1298: true, 3724: 120.5, 3725: 30.25 } };
        } else if (headers['content-type'].includes('json')) {
          regionReads++;
          data = { vin: vehicle.vin, signal: { sts: Date.now(), soc: '61', expectedMileage: 172, 2188: 0, totalMileage: 2445,
            speed: 0, gearStatus: 0, driverDoorLockStatus: true, bbcmBackDoorStatus: 'false', leftFrontWindowPercent: '18',
            rightFrontWindowPercent: 0, leftRearWindowPercent: 0, rightRearWindowPercent: 0, leftFrontTirePressure: 239,
            acSwitch: 'false', chargeState: 5, minSingleTemp: -3.5 } };
        } else code = 100;
      } else if (minExchange && headers.token !== carToken(minExchange)) code = 302002004;
      else data = { collectTime: collectedAt ?? Date.now(), signalMap: emptySignals ? {} : { sts: reportedAt, 100003: soc, 2188: 312, 1010: gear, 3636: sentrySignal,
        2: 121.47, 3: 31.23, 2646: 234, 2653: 235, 2660: 231, 1182: 0, 1186: 1, ...openings, ...recordSignals } };
    } else if (path.endsWith('/verifyoperatepwdnew')) {
      const form = new URLSearchParams(request.postData);
      assert.equal(form.get('vin'), vehicle.vin);
      assert.equal(form.get('oprpwd'), expectedPin(headers.token));
      assert.equal(headers.carvin, vehicle.vin);
      assert.match(headers['content-type'], /application\/x-www-form-urlencoded/i);
      verifiedPins.push(form.get('oprpwd'));
      code = pinCode;
    } else if (path.endsWith('/appremotectl')) {
      const form = new URLSearchParams(request.postData);
      assert.equal(form.get('carvin'), vehicle.vin);
      assert.equal(form.get('oppwd'), verifiedPins.at(-1));
      assert.match(form.get('nonce'), /^\d{7}$/);
      const signedFields = Object.fromEntries(['acceptLanguage', 'channel', 'deviceType', 'source', 'timestamp', 'version', 'deviceId']
        .map(key => [key, headers[key.toLowerCase()]]));
      const fields = { ...Object.fromEntries(form), ...signedFields };
      const key = headers.deviceid === 'fixture-device' ? Buffer.from('ab'.repeat(16), 'hex') : Buffer.alloc(16, 11);
      const sign = createHmac('sha256', key).update(Object.keys(fields).sort().map(key => fields[key]).join('')).digest('hex');
      assert.equal(headers.sign, sign);
      assert.equal(headers.digest, sign);
      remoteWrites.push([form.get('cmdid'), JSON.parse(form.get('state'))]);
      if (form.get('cmdid') === '361') preparationPlans = JSON.parse(form.get('state')).controls;
      if (form.get('cmdid') === '161') preheatPlans = JSON.parse(form.get('state')).controls;
      data = 'mock-command-id';
      status = commandHttpStatus;
    } else if (path.endsWith('/healthyCharging/control')) {
      const form = new URLSearchParams(request.postData);
      assert.equal(form.get('carvin'), vehicle.vin);
      assert.equal(form.get('oppwd'), verifiedPins.at(-1));
      remoteWrites.push(['healthyCharging', form.get('state')]);
    } else if (path.endsWith('/appremotectl/query')) {
      assert.equal(url.searchParams.get('msgID'), 'mock-command-id');
      data = { status: commandStatus };
    }
    else if (path.endsWith('/charge/daily/detail/page')) {
      const payload = JSON.parse(request.postData);
      chargeRequests++;
      assert.match(headers['content-type'], /application\/json/i);
      if (payload.vin === secondVehicle.vin) data = { total: 0, list: [] };
      else {
        assert.equal(payload.vin, vehicle.vin);
        const row = { chargeGunStartTs: started, chargeGunEndTs: ended, chargeInEnergy: '23.50', chargeType: 'QUICK',
          chargeStartLatitude: '31.12345', chargeStartLongitude: '121.23456' };
        data = { total: 2, list: payload.pageNum === 1 ? [row] : [row, { ...row, chargeGunStartTs: started - 86_400_000, chargeGunEndTs: ended - 86_400_000, chargeType: 'SLOW' }] };
      }
    } else if (path.endsWith('/vehicleinfo/commonConfig')) data = { config: { 3: { percent: '80', isEnable: '1', circulation: '1', beginTime: '23:00', endTime: '06:00', cycles: '1,1,1,1,1,1,1', recharge: 1 } } };
    else if (path.endsWith('/mileage/energy/detail')) data = { deliveryDays: 436, totalmileage: 9598, totalAccumulatedMileage: 604,
      totalEnergy: Number(url.searchParams.get('begintime')) < Date.now() - 365 * 86_400_000 ? 1935 : 81,
      detail: [{ day: energyDay, accumulatedMileage: '40', accumulatedEnergyConsume: 0 }] };
    else if (path.endsWith('/getLastweekEC')) {
      assert.match(url.searchParams.get('begintime'), /^\d{10}$/);
      assert.match(url.searchParams.get('endtime'), /^\d{10}$/);
      data = { driverEC: '8.2', acEC: '1.2', otherEC: '.6' };
    }
    else if (path.endsWith('/getLastNweeks100kmECAndRank')) data = { rankResult: { rank: '8%', hundredKmEC: '21.3' } };
    else if (path.endsWith('/getPlugInLastNweeks100kmEC')) {
      fuelRequests.push(url.searchParams.get('carvin'));
      data = { oc100km: 6.2 };
    }
    else if (path.endsWith('/love_car_default_header.txt')) payload = { carIntroduction: [{ carName: 'C10',
      actionButtons: [{ jumpUrl: 'https://www-app.leapmotor.cn/configuration-v4.html?carCode=fixture-C10' }] }] };
    else if (path === '/mallResourceConfig/getByCode') {
      const code = url.searchParams.get('code');
      assert.ok(['fixture-C10', 'C11', '2021C10', '2022C10'].includes(code));
      data = code === '2021C10' ? null : { carType: code === '2022C10' ? 'historical-exact' : code === 'C11' ? 'c11-mall-type' : 'c10-mall-type' };
    }
    else if (path.endsWith('/resourceConfig/getByCode') || path.endsWith('/getSaleVehicleEdition') || path.endsWith('/getVehicleConfig')) data = null;
    else if (path.includes('/getVehicleModelSeatList') && url.searchParams.get('carType') === 'historical-exact') {
      data = path.endsWith('V4') ? { modelList: [
        { carModel: 'exact-only', vehicleYear: 2022, vehicleModel: '历史款', vehicleSpecs: '纯电', carTypeImgsDemo: whiteRender },
        { carModel: 'different-year', vehicleYear: 2025, vehicleModel: '其他年款', vehicleSpecs: '纯电' },
      ] } : [];
    }
    else if (path.includes('/getVehicleModelSeatList') && url.searchParams.get('carType') === 'c11-mall-type') data = [];
    else if (path.endsWith('/getVehicleModelSeatListV4')) {
      assert.equal(url.searchParams.get('carType'), 'c10-mall-type');
      assert.equal(url.searchParams.get('platform'), '3');
      data = { modelList: [
        { carModel: 'c10-bev', vehicleYear: 2026, vehicleModel: '测试长续航版', vehicleSpecs: '纯电' },
        { carModel: 'c10-reev', vehicleYear: 2026, vehicleModel: '测试长续航版', vehicleSpecs: '增程' },
      ] };
    }
    else if (path.endsWith('/getVehicleModelSeatList')) data = [{ pureModelList: [
      { carModel: 'c10-legacy', vehicleYear: 2024, vehicleModel: '测试舒享版' },
    ] }];
    else if (path.endsWith('/getVehicleProductConfigV4') || path.endsWith('/getVehicleProductConfig')) {
      const type = url.searchParams.get('carType');
      marketReads.push(type);
      if (type === 'c10-bev') data = { vehicleYear: 2026, vehicleModel: '测试长续航版', vehicleSpecs: '纯电',
        outColor: [{ color: '测试绿', appearanceCarImgs: greenRender }, { color: '测试蓝', slideshowImgsPc: blueRender },
          { color: '不可信图片', image: 'https://example.invalid/unsafe.png' }] };
      else if (type === 'c10-legacy' && path.endsWith('/getVehicleProductConfig')) data = { vehicleYear: 2024, vehicleModel: '测试舒享版',
        outColor: [{ color: '经典白', appearanceCarImgs: whiteRender }] };
    }
    else if (url.hostname === 'ueapp-oss-static.leapmotor.com') {
      binary = readFileSync(new URL('../public/assets/c10.png', import.meta.url)).toString('base64');
      contentType = 'image/png';
    }
    else if (path.endsWith('/carpicture/3d/key')) {
      if (!t03 && url.searchParams.get('vin') === vehicle.vin) assert.equal(headers.cartype, 'C10');
      assert.equal(url.searchParams.has('year'), false);
      data = zip
      ? { modelType: 3, h5Key: 'viewer', srcKey: 'model', modelParam: { carType: 'C10', year: 2026, carTypeCode: '605激光雷达版', colorCode: 2 } }
      : url.searchParams.has('deviceID') ? { modelParam: {}, h5Key: '', srcKey: '' } : { modelType: 2, modelVersion: '1.0', srcKey: '2d-only' };
    }
    else if (path.endsWith('/carpicture/key')) data = { picUrl: ownerPicture };
    else if (path.endsWith('/carpicture/key/package') && zip) binary = zip[url.searchParams.get('key')];
    else status = 404;
    const responseHeaders = [
      { name: 'Content-Type', value: contentType ?? (binary ? 'application/zip' : 'application/json') }, { name: 'Access-Control-Allow-Origin', value: origin },
      { name: 'Access-Control-Allow-Headers', value: headers['access-control-request-headers'] ?? '*' },
      { name: 'Access-Control-Allow-Methods', value: 'GET, POST, OPTIONS' },
    ];
    void tab.send('Fetch.fulfillRequest', { requestId, responseCode: status, responseHeaders,
      ...(status !== 204 ? { body: binary ?? Buffer.from(JSON.stringify(payload ?? { code: code ?? (status === 200 ? 0 : status), data })).toString('base64') } : {}),
    }).catch(error => {
      // Navigating away can cancel a paused request before CDP delivers the fixture.
      if (error.message !== 'Invalid InterceptionId.') tab.errors.push(error.message);
    });
  });
  await tab.send('Fetch.enable', { patterns: [...carHosts, ...marketHosts, 'restapi.amap.com'].map(host => ({ urlPattern: 'https://' + host + '/*' })) });
  return tab;
}

async function text(tab, pattern, timeoutMs = 7500) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const visible = await tab.run('document.body.innerText');
    if (pattern.test(visible)) return;
    await wait(125);
  }
  assert.fail('页面未显示 ' + pattern);
}
async function until(tab, expression) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (await tab.run(expression)) return;
    await wait(125);
  }
  assert.fail('页面条件未满足 ' + expression);
}
const click = (tab, caption) => tab.run(`Array.from(document.querySelectorAll('button,a')).find(b => b.textContent.trim() === ${JSON.stringify(caption)}).click()`);
const fill = (tab, label, value) => tab.run(`(() => {
  const input = document.querySelector('[aria-label=' + ${JSON.stringify(JSON.stringify(label))} + ']');
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, ${JSON.stringify(value)});
  input.dispatchEvent(new Event('input', { bubbles: true }));
})()`);
async function chooseC10Pack(tab) {
  await tab.click('.battery-picker-trigger');
  await until(tab, '!!document.querySelector(".battery-picker-options:not([hidden])")');
  await tab.run(`Array.from(document.querySelectorAll('.battery-picker-option')).find(option =>
    option.textContent.includes('67.0 kWh') && option.textContent.includes('可用容量')).click()`);
  await until(tab, 'document.querySelector(".battery-picker-trigger").getAttribute("aria-expanded") === "false"');
}

let tab = await open();
try {
  await tab.send('Storage.clearDataForOrigin', { origin, storageTypes: 'local_storage,indexeddb' });
  await tab.navigate(base + '#/login');
  await tab.run(`import('/src/data/cloud/cloud3d.ts').then(module => module.dropCloud3D('fixture-car'))`);
  await until(tab, '!!document.querySelector(\'[aria-label="同意条款"]\')');
  await click(tab, '故障诊断与导出');
  await click(tab, '检测网络与车辆');
  await text(tab, /跳过 · 未使用零跑账号登录/);
  assert.deepEqual(requests, { sms: 0, signIn: 0, exchange: 0 });
  await tab.run('location.hash="/login"');
  await until(tab, `!!document.querySelector('[aria-label="同意条款"]')`);
  await tab.click('[aria-label="同意条款"]');
  await fill(tab, '手机号', '13800001234');
  await click(tab, '获取验证码');
  await text(tab, /验证码已发送/);
  await fill(tab, '验证码', '654321');
  await click(tab, '登录');
  await text(tab, /本地验收车辆/);
  await click(tab, '进入车辆');
  await text(tab, /选择电池容量/);
  assert.equal(await tab.run('document.querySelectorAll(".vehicle-energy-sheet input").length'), 1);
  assert.equal(await tab.run('document.querySelectorAll(".vehicle-energy-sheet select").length'), 0);
  assert.doesNotMatch(await tab.run('document.querySelector(".battery-picker-options").textContent'), /海外/);
  await click(tab, '保存并进入');
  await text(tab, /请选择车型容量或手动填写/);
  await tab.reload();
  await text(tab, /选择电池容量/);
  await chooseC10Pack(tab);
  await click(tab, '保存并进入');
  await text(tab, /73%/);
  await tab.run('location.hash="/records-source"');
  await until(tab, 'document.querySelector(".source-opt.on b")?.textContent === "关闭记录"');
  assert.equal(chargeRequests, 0);
  await tab.click('.source-opt:first-of-type');
  await until(tab, 'document.querySelector(".source-opt.on b")?.textContent === "手机记录"');
  await tab.run('location.hash="/home"');
  await text(tab, /73%/);
  if (!zip) {
    await until(tab, `document.querySelector('.home-model[data-model-status="2d"] img')?.currentSrc === ${JSON.stringify(ownerPicture)}`);
    assert.equal(await tab.run('document.querySelectorAll(".home-model iframe").length'), 0);
    assert.notEqual(await tab.run('JSON.parse(localStorage.getItem("leapmore.visualMode"))'), '2d');
  }
  await click(tab, '胎压');
  await text(tab, /200–270 kPa/);
  await tab.click('dialog[open] [aria-label=关闭]');
  assert.doesNotMatch(await tab.run('document.body.innerText'), /数据可能过期|上次车况/);
  collectedAt = reportedAt;
  await tab.click('[aria-label="刷新"]');
  await text(tab, /上次车况/);
  collectedAt = null;
  await tab.click('[aria-label="刷新"]');
  await until(tab, 'document.querySelector(".hero-title .sub")?.textContent.startsWith("状态更新")');
  const quickStates = () => tab.run(`Array.from(document.querySelectorAll('.hero-actions .circ'), button =>
    [button.parentElement.hasAttribute('data-open'), button.getAttribute('aria-description'), button.disabled])`);
  assert.deepEqual(await quickStates(), [
    [true, '车门未锁', false], [true, '后备箱未关', false], [true, '未关，开度未知', false], [true, '遮阳帘未关', false],
  ]);
  const lockButton = '.hero-actions .circ:first-child';
  const confirmControl = async () => {
    await until(tab, '!!document.querySelector("dialog [aria-label=零跑操作密码]")');
    await fill(tab, '零跑操作密码', '654321');
    await click(tab, '确认发送');
  };
  await tab.click(lockButton);
  await text(tab, /零跑远程控车/);
  await until(tab, '!!document.querySelector("dialog [aria-label=零跑操作密码]")');
  assert.equal(await tab.run('document.querySelector("dialog .confirm-btns button:last-child").disabled'), true);
  assert.equal(remoteWrites.length, 0);
  pinCode = 4;
  await confirmControl();
  await text(tab, /零跑操作密码错误/);
  assert.equal(remoteWrites.length, 0);
  await click(tab, '关闭');
  pinCode = 0;
  gear = 1;
  await tab.click(lockButton);
  await confirmControl();
  await text(tab, /未确认车辆已驻车/);
  assert.equal(verifiedPins.length, 1);
  assert.equal(remoteWrites.length, 0);
  await click(tab, '关闭');
  gear = 0;
  await tab.click(lockButton);
  await confirmControl();
  await text(tab, /云端已受理/);
  assert.deepEqual(remoteWrites, [['110', { value: 'lock' }]]);
  await text(tab, /等待车辆确认/);
  commandStatus = 'success';
  await text(tab, /操作成功 · 车端已确认/);
  assert.equal(await tab.run('document.querySelector(".hero-lock .lock-state span").textContent'), '车门已锁');
  assert.equal(openings[1298], 0);
  commandStatus = 'pending';
  await until(tab, '!document.querySelector("dialog[open]")');
  openings[1298] = 1;
  reportedAt = Date.now() + 1;
  await tab.click('[aria-label="刷新"]');
  await until(tab, '!document.querySelector(".hero-tools button[aria-busy=true]")');
  openings[1298] = 0;
  reportedAt += 1;
  await tab.click('[aria-label="刷新"]');
  await until(tab, '!!document.querySelector(".lock-open-status")');
  commandHttpStatus = 503;
  await tab.click(lockButton);
  await text(tab, /使用本机保存的操作密码/);
  assert.equal(await tab.run('!!document.querySelector("dialog [aria-label=零跑操作密码]")'), false);
  assert.doesNotMatch(await tab.run('document.querySelector("dialog").innerText'), /改用操作密码/);
  await click(tab, '确认发送');
  await text(tab, /无法确认零跑是否收到操作/);
  assert.equal(remoteWrites.length, 2);
  await click(tab, '关闭');
  commandHttpStatus = 200;
  await text(tab, /73%/);
  await tab.click(lockButton);
  await text(tab, /使用本机保存的操作密码/);
  await click(tab, '取消');
  await tab.run('location.hash="/operation-pin"');
  await text(tab, /发送前验证/);
  assert.deepEqual(await tab.run('[...document.querySelectorAll(".source-opt b")].map(el=>el.textContent)'), ['直接确认', '每次验证', '发送前不确认']);
  await text(tab, /容易误触/);
  const warningColor = await tab.run('getComputedStyle(document.querySelector(".operation-warning")).color');
  const [wr, wg, wb] = warningColor.match(/\d+/g).map(Number);
  assert.ok(wr > wg + 40 && wr > wb + 40);
  await tab.click('.operation-warning');
  await until(tab, 'document.querySelector(".source-opt.on b")?.textContent === "发送前不确认"');
  await tab.reload();
  await until(tab, 'document.querySelector(".source-opt.on b")?.textContent === "发送前不确认"');
  async function quickAction(action, target) {
    const query = new URLSearchParams({ action, target: JSON.stringify(target) });
    await tab.run('location.hash=' + JSON.stringify('/quick-action?' + query));
  }
  const quickCar = ['cloud:fixture-account', vehicle.carId, vehicle.vin];
  const beforeInstant = remoteWrites.length;
  await quickAction('find', quickCar);
  await text(tab, /确认鸣笛寻车/);
  assert.equal(remoteWrites.length, beforeInstant);
  await click(tab, '取消');
  await quickAction('lock-only', ['cloud:different-account', vehicle.carId, vehicle.vin]);
  await text(tab, /绑定的车辆或预设已不可用/);
  assert.equal(remoteWrites.length, beforeInstant);
  await quickAction('prepare', [...quickCar, 'removed-preset']);
  await text(tab, /绑定的车辆或预设已不可用/);
  assert.equal(remoteWrites.length, beforeInstant);

  await tab.run('location.hash="/widget-action?action=find"');
  await text(tab, /使用本机保存的操作密码/);
  assert.equal(remoteWrites.length, beforeInstant);
  await click(tab, '取消');
  commandStatus = 'success';
  await tab.run(`(() => {
    const find = [...document.querySelectorAll('.home button')].find(b => b.textContent === '鸣笛寻车');
    find.click(); find.click();
  })()`);
  await text(tab, /操作成功 · 车端已确认/);
  assert.deepEqual(remoteWrites.slice(beforeInstant), [['120', { value: 'true' }]]);
  await until(tab, '!document.querySelector("dialog[open]")');
  gear = 1;
  await click(tab, '鸣笛寻车');
  await text(tab, /未确认车辆已驻车/);
  await click(tab, '关闭');
  gear = 0;
  pinCode = 4;
  await click(tab, '鸣笛寻车');
  await text(tab, /已保存的操作密码失效/);
  await click(tab, '关闭');
  pinCode = 0;
  await click(tab, '鸣笛寻车');
  await until(tab, '!!document.querySelector("dialog [aria-label=零跑操作密码]")');
  assert.equal(remoteWrites.length, beforeInstant + 1);
  await confirmControl();
  await text(tab, /操作成功 · 车端已确认/);
  await until(tab, '!document.querySelector("dialog[open]")');
  commandStatus = 'pending';
  await tab.run('location.hash="/operation-pin"');
  await until(tab, 'document.querySelector(".source-opt.on b")?.textContent === "发送前不确认"');
  await tab.click('.source-opt:first-of-type');
  await until(tab, 'document.querySelector(".source-opt.on b")?.textContent === "直接确认"');
  await tab.run('location.hash="/home"');
  await text(tab, /鸣笛寻车/);
  await click(tab, '鸣笛寻车');
  await text(tab, /使用本机保存的操作密码/);
  assert.equal(remoteWrites.length, beforeInstant + 2);
  await click(tab, '取消');
  await tab.run('location.hash="/operation-pin"');
  await text(tab, /发送前验证/);
  await tab.click('.source-opt:nth-of-type(2)');
  await until(tab, 'document.querySelector(".source-opt.on b")?.textContent === "每次验证"');
  await tab.run('location.hash="/home"');
  await until(tab, '!!document.querySelector(".home:not([hidden]) .hero-actions")');
  await tab.click(lockButton);
  await until(tab, '!!document.querySelector("dialog [aria-label=零跑操作密码]")');
  await click(tab, '取消');
  const [red, green, blue] = (await tab.run('getComputedStyle(document.querySelector(".lock-open-status")).color')).match(/\d+/g).map(Number);
  assert.ok(red > green + 40 && red > blue + 40);
  assert.deepEqual(await tab.run('Array.from(document.querySelectorAll(".home-entries .entry-title"),e=>e.textContent)'), ['充电', '胎压', '控制', '外观']);
  await tab.click('.home-entries a[href="#/control"]');
  await text(tab, /车辆控制/);
  assert.equal(await tab.run("document.querySelectorAll('.vehicle-controls button[aria-disabled=true]').length"), 4);
  await tab.click('[aria-label="哨兵模式"]');
  await text(tab, /正在施工/);
  await tab.run('location.hash="/control/straight"');
  await until(tab, "location.hash === '#/control'");
  const beforeSpecial = remoteWrites.length;
  const sentryAttempt = () => tab.run(`(async () => {
    const { loadCloudSession, cloudClient } = await import('/src/features/account/session.ts');
    const client = cloudClient(await loadCloudSession());
    try { await client.sendCommand('fixture-car', {kind:'sentry',on:true}, '654321', new AbortController().signal, () => {}); return 'ok'; }
    catch (error) { return error.message; }
  })()`);
  assert.match(await sentryAttempt(), /主账号/);
  assert.equal(remoteWrites.length, beforeSpecial);
  boundOwner = true;
  assert.equal(await sentryAttempt(), 'ok');
  assert.deepEqual(remoteWrites.at(-1), ['400', {value:'on'}]);
  boundOwner = false;
  commandStatus = 'success';
  await click(tab, '日常通勤');
  await until(tab, '!!document.querySelector("dialog [aria-label=零跑操作密码]")');
  await confirmControl();
  await text(tab, /车端已确认/);
  await until(tab, '!document.querySelector(".cmd-sheet")');
  assert.equal(remoteWrites.at(-1)[0], '360');
  assert.equal(remoteWrites.at(-1)[1].air_condition.temperature, '24');
  await quickAction('prepare', [...quickCar, 'winter']);
  await text(tab, /冬日温暖 · 空调 26℃/);
  await confirmControl();
  await text(tab, /车端已确认/);
  await until(tab, '!document.querySelector(".cmd-sheet")');
  assert.equal(remoteWrites.at(-1)[0], '360');
  assert.equal(remoteWrites.at(-1)[1].air_condition.temperature, '26');
  for (const [action, kind, expected] of [['lock-only','110','lock'], ['climate-on','170','manual'], ['climate-off','170','off']]) {
    recordSignals[1938] = action === 'climate-off' ? 1 : 0;
    recordSignals[1298] = 0;
    await quickAction(action, quickCar);
    await until(tab, '!!document.querySelector("dialog [aria-label=零跑操作密码]")');
    await confirmControl();
    await text(tab, /车端已确认/);
    await until(tab, '!document.querySelector(".cmd-sheet")');
    const [cmd, payload] = remoteWrites.at(-1);
    assert.equal(cmd, kind);
    assert.equal(kind === '110' ? payload.value : payload.operate, expected);
  }
  delete recordSignals[1938];
  delete recordSignals[1298];
  await tab.run('location.hash="/control"');
  await text(tab, /管理预设/);
  await click(tab, '冬日温暖');
  await tab.click('.schedule-entry button');
  await text(tab, /暂无预约备车/);
  await click(tab, '添加预约');
  await click(tab, '保存预约');
  await until(tab, '!!document.querySelector("dialog [aria-label=零跑操作密码]")');
  await confirmControl();
  await text(tab, /预约备车已更新/);
  await until(tab, '!document.querySelector(".cmd-sheet")');
  assert.equal(remoteWrites.at(-1)[0], '361');
  assert.equal(preparationPlans.length, 1);
  assert.equal(preparationPlans[0].datacontent.air_condition.temperature, '26');
  await tab.click('.prep-plan-details');
  await click(tab, '删除预约');
  await until(tab, '!!document.querySelector("dialog [aria-label=零跑操作密码]")');
  await confirmControl();
  await text(tab, /预约备车已更新/);
  await until(tab, '!document.querySelector(".cmd-sheet")');
  assert.equal(preparationPlans.length, 0);
  await until(tab, '!!document.querySelector(".prep-schedules")');
  await tab.click('.prep-schedules [aria-label=关闭]');
  commandStatus = 'pending';
  await tab.run('location.hash="/climate"');
  await until(tab, '!!document.querySelector(".climate-page")');
  const heaters = () => tab.run('[...document.querySelectorAll(".climate-page [role=switch]")].map(el => [el.getAttribute("aria-label"), el.getAttribute("aria-checked")])');
  assert.deepEqual(await heaters(), []);
  assert.equal(await tab.run('!!document.querySelector(".climate-seats")'), false);
  await tab.run('location.hash="/home"');
  await until(tab, '!!document.querySelector(".hero-tools button:not(:disabled)")');
  await tab.click('[aria-label="刷新"]');
  await text(tab, /车辆暂无新上报/);
  minExchange = 3; soc = 74; reportedAt += 1000;
  await tab.click('[aria-label="刷新"]');
  await text(tab, /74%/);
  await text(tab, /车况已更新/);
  emptySignals = true;
  await tab.click('[aria-label="刷新"]');
  await text(tab, /云端本次未返回车况，显示上次车况/);
  await text(tab, /74%/);
  emptySignals = false; soc = 73; reportedAt += 1000;
  openings = { 1298: 1, 1281: 0, 1693: 0, 1694: 0, 1695: 0, 1724: 0 };
  await tab.click('[aria-label="刷新"]');
  await text(tab, /73%/);
  assert.deepEqual(await quickStates(), [
    [false, '车门已锁', false], [false, '后备箱已关', false], [false, '车窗状态未知', false], [false, '遮阳帘已关', false],
  ]);
  assert.equal(await tab.run('document.querySelector(".lock-open-status")'), null);
  assert.deepEqual(await tab.run(`(() => {
    const card = document.querySelector('.map-card');
    return [card.querySelectorAll('.map-title').length, card.querySelectorAll('.map-pin,.amap-car').length,
      !!card.querySelector('.map-time'), card.querySelector('.amap-view').clientHeight === card.clientHeight];
  })()`), [0, 1, true, true]);
  await tab.run('location.hash="/records?tab=charges"');
  await text(tab, /23.5 kWh/);
  assert.equal(await tab.run('document.querySelectorAll(".record-panel .trip-row").length'), 2);
  assert.match(await tab.run('document.querySelector(".record-panel .trip-row .charge-place-value").textContent'), /31\.12345, 121\.23456/);
  assert.equal(chargeRequests, 4);
  await tab.click('.record-panel .trip-row');
  await text(tab, /充电详情/);
  await text(tab, /23\.5\s*kWh/);
  await text(tab, /电池最低温\s*—\s*暂无记录/);
  assert.doesNotMatch(await tab.run('document.body.innerText'), /充电功率|采样|—%/);
  await tab.run('location.hash="/energy"');
  await text(tab, /21.3/);
  await text(tab, /40.0/);
  assert.deepEqual(await tab.run(`['totalDays','totalKm','totalKwh','monthKm'].map(key =>
    document.querySelector('[data-energy-card="'+key+'"] strong').textContent.trim())`), ['436','9598','1935.0','604.0 km']);
  assert.equal(await tab.run('document.querySelectorAll(".energy-page > .hint").length'), 0);
  await tab.run('location.hash="/mine/appearance"');
  await text(tab, /浅色/);
  await click(tab, '深色');
  await tab.run('location.hash="/location"');
  await until(tab, '!!document.querySelector(".location-map .amap-view")');
  assert.equal(await tab.run('document.documentElement.dataset.theme'), 'dark');
  assert.equal(await tab.run('document.querySelector(".location-map .amap-view").dataset.mapStyle'), 'system');
  await tab.click('[aria-label="切换底图"]');
  await until(tab, '!!document.querySelector(\'.location-map .amap-view[data-map-style="vector"]\')');
  assert.equal(await tab.run('getComputedStyle(document.querySelector(".location-map .amap-tiles")).filter'), 'none');
  for (let i = 0; i < 2; i++) await tab.click('[aria-label="切换底图"]');
  await until(tab, '!!document.querySelector(".location-map .amap-view.is-dark")');
  for (let i = 0; i < 2; i++) await tab.click('[aria-label="切换底图"]');
  await until(tab, '!!document.querySelector(\'.location-map .amap-view[data-map-style="vector"]\')');
  await tab.run('location.hash="/charging"');
  await text(tab, /80%/);
  await text(tab, /电池最低温\s*0\.0\s*°C/);
  await text(tab, /上报时加热中/);
  assert.equal(await tab.run('document.querySelector(".schedule-grid [aria-label=开始]").textContent'), '23:00');
  await tab.click('.schedule-grid [aria-label=开始]');
  await until(tab, 'document.querySelectorAll(".time-columns .choice-list").length === 2');
  await tab.click('.time-columns > div:first-child [data-value="20"]');
  await tab.click('.time-columns > div:last-child [data-value="37"]');
  await tab.click('.choice-sheet .confirm-btns .ghost');
  assert.equal(await tab.run('document.querySelector(".schedule-grid [aria-label=开始]").textContent'), '23:00');
  if (zip) {
    if (process.env.LEAPMORE_TEST_3D_DEBUG) {
      await tab.send('Log.enable'); await tab.send('Network.enable');
      await tab.run(`window.testViewerEvents=[]; window.addEventListener('message',e=>{if(e.data?.t) testViewerEvents.push([e.origin,e.data.t,e.data.msg])});`);
      tab.on('Log.entryAdded', ({ entry }) => console.log(entry.level, entry.text.slice(0, 250)));
      tab.on('Network.responseReceived', ({ response }) => { if (response.url.includes('/viewer/cloud/')) console.log(response.status, response.url.split('/').at(-1)); });
      tab.on('Network.loadingFailed', data => console.log(data.errorText, data.blockedReason ?? '', data.corsErrorStatus?.corsError ?? ''));
    }
    await tab.run('location.hash="/appearance"');
    try { await until(tab, 'document.querySelector(".c3d-stage")?.dataset.modelStatus === "full"'); }
    catch (error) { if (process.env.LEAPMORE_TEST_3D_DEBUG) console.log(await tab.run('document.body.innerText'), await tab.run('testViewerEvents'), tab.errors); throw error; }
    assert.equal(await tab.run('document.querySelector(\'iframe[title="3D 车模"]\').sandbox.value'), 'allow-scripts');
    assert.equal(await tab.run('document.querySelector(".c3d-stage").dataset.modelStatus'), 'full');
    await tab.click('[aria-label="切换静态图"]');
    await tab.run('location.hash="/home"');
    await until(tab, 'document.querySelector(".home-model")?.dataset.modelStatus === "2d"');
    assert.equal(await tab.run('document.querySelectorAll(".home-model iframe").length'), 0);
    await tab.run('location.hash="/appearance"');
    await until(tab, '!!document.querySelector(\'[aria-label="切换静态图"]\')');
    await tab.click('[aria-label="切换静态图"]');
    await tab.run('location.hash="/home"');
    await until(tab, 'document.querySelector(".home-model")?.dataset.modelStatus === "full"');
    await wait(900);
    const box = await tab.run(`(() => { const r = document.querySelector('.home-model iframe').getBoundingClientRect();
      return { x: Math.round(r.left + r.width * .22), y: Math.round(r.top + r.height * .23),
        width: Math.round(r.width * .56), height: Math.round(r.height * .58), scale: 1 }; })()`);
    const before = await tab.send('Page.captureScreenshot', { format: 'png', clip: box });
    const x = box.x + Math.round(box.width * .35), y = box.y + Math.round(box.height * .53);
    assert.equal(await tab.run(`document.elementFromPoint(${x}, ${y})?.getAttribute('aria-label')`), '旋转首页车模');
    await tab.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
    for (const dx of [12, 30, 51, 70]) {
      await tab.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: x + dx, y }] });
      await wait(40);
    }
    await tab.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await wait(450);
    const after = await tab.send('Page.captureScreenshot', { format: 'png', clip: box });
    assert.ok(after.data !== before.data, '首页 3D 随触摸拖动旋转');
    const pair = distance => [{ x: x - distance, y, id: 1 }, { x: x + distance, y, id: 2 }];
    await tab.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: pair(14) });
    for (const distance of [20, 28, 38]) {
      await tab.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: pair(distance) });
      await wait(40);
    }
    await tab.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await wait(300);
    const zoomed = await tab.send('Page.captureScreenshot', { format: 'png', clip: box });
    assert.ok(zoomed.data !== after.data, '首页 3D 随双指手势缩放');
  }
  await tab.run('location.hash="/appearance"');
  await until(tab, '!!document.querySelector(".appearance-tools [aria-label=切换静态图]")');
  const toStatic = await tab.run(`JSON.parse(localStorage.getItem('leapmore.visualMode')) !== '2d'`);
  if (toStatic) await tab.click('.appearance-tools [aria-label=切换静态图]');
  await until(tab, 'document.querySelector(".market-line [aria-label=版本]")?.textContent.includes("测试长续航版")');
  await click(tab, '查询商城车模');
  await text(tab, /测试绿/);
  await click(tab, '测试蓝');
  await until(tab, `document.querySelector('.c3d-stage img.static3d')?.currentSrc === ${JSON.stringify(blueRender)}`);
  assert.doesNotMatch(await tab.run('document.body.innerText'), /不可信图片/);
  assert.deepEqual(marketReads, ['c10-bev']);
  async function enterYear(year) {
    await tab.click('[aria-label=年款]'); await fill(tab, '输入四位年份', year);
    await tab.click('.choice-entry .btn');
  }
  await enterYear('2021');
  await text(tab, /暂未查到 C10 2021 款的外观图/);
  assert.equal(await tab.run("document.querySelector('.market-line [aria-label=版本]').disabled"), true);
  assert.equal(await tab.run("document.querySelector('.c3d-stage img.static3d').currentSrc"), blueRender);
  await enterYear('2022');
  await text(tab, /历史款/);
  await click(tab, '查询商城车模');
  await text(tab, /车型外观/);
  await tab.click('[aria-label=年款]'); await tab.click('dialog[open] [data-value="2024"]');
  await click(tab, '查询商城车模');
  await text(tab, /经典白/);
  assert.deepEqual(marketReads, ['c10-bev', 'exact-only', 'exact-only', 'c10-legacy']);
  await tab.run('location.hash="/home"');
  await until(tab, `document.querySelector('.home-model img.static3d')?.currentSrc === ${JSON.stringify(whiteRender)}`);
  await tab.run('location.hash="/mine"');
  await text(tab, /车辆账号 · 138\*{4}1234/);
  assert.doesNotMatch(await tab.run('document.querySelector(".profile-name").innerText'), /13800001234/);
  await tab.run('location.hash="/home"');
  assert.ok(await tab.run(`(async () => {
    const {readLocalSecret} = await import('/src/platform/localVault.ts');
    return JSON.parse(await readLocalSecret('leapmotor-session')).account.token === ${JSON.stringify(access)} &&
      !JSON.stringify(localStorage).includes(${JSON.stringify(access)});
  })()`));
  await tab.reload();
  await text(tab, /73%/);
  assert.deepEqual(requests, { sms: 1, signIn: 1, exchange: 3 });
  assert.deepEqual(tab.errors, []);
  await tab.close();
  tab = await open();
  await tab.navigate(base + '#/home');
  await text(tab, /73%/);
  assert.deepEqual(requests, { sms: 1, signIn: 1, exchange: 3 });
  await tab.run('location.hash="/vehicle-access"');
  await text(tab, /刷新授权/);
  const badges = () => tab.run(`Array.from(document.querySelectorAll('.shared-grants .pill'), node => node.textContent)`);
  assert.deepEqual(await badges(), ['必选', '已授权', '已授权', '已授权']);
  moduleRights = [100, 300];
  await click(tab, '刷新授权');
  await text(tab, /授权已刷新/);
  assert.deepEqual(await badges(), ['必选', '未授权', '已授权', '未授权']);
  await tab.run('location.hash="/home"');
  await text(tab, /车辆控制未授权/);
  assert.deepEqual((await quickStates()).map(item => item[2]), [false, true, true, true]);
  await tab.run('location.hash="/vehicle-access"');
  await text(tab, /刷新授权/);
  moduleRights = '100,200,300,400';
  await click(tab, '刷新授权');
  await text(tab, /授权已刷新/);
  assert.deepEqual(await badges(), ['必选', '已授权', '已授权', '已授权']);
  await tab.run('location.hash="/mine"');
  await text(tab, /退出登录/);
  assert.doesNotMatch(await tab.run('document.body.innerText'), /切换账号/);
  await tab.run('location.hash="/login"');
  await text(tab, /使用演示账号/);
  await click(tab, '使用演示账号');
  await text(tab, /进入车辆/);
  await click(tab, '进入车辆');
  await text(tab, /42%/);
  await tab.run('location.hash="/mine"');
  await text(tab, /演示情景/);
  await click(tab, '演示情景');
  await tab.click('[aria-label="数据状态"]');
  await tab.click('dialog[open] [data-value=offline]');
  await tab.run('location.hash="/states"');
  await text(tab, /常见问题与处理/);
  await tab.click('.diagnostic-folds > details:first-child > summary');
  await click(tab, '重新登录');
  await text(tab, /使用演示账号/);
  await click(tab, '使用演示账号');
  await text(tab, /进入车辆/);
  await click(tab, '进入车辆');
  await text(tab, /42%/);
  await tab.run('location.hash="/mine"');
  await text(tab, /退出登录/);
  await click(tab, '退出登录');
  await tab.click('dialog[open] .confirm-btns button:last-child');
  await text(tab, /继续使用已登录账号/);
  await click(tab, '继续使用已登录账号');
  await text(tab, /进入车辆/);
  await click(tab, '进入车辆');
  await text(tab, /73%/);
  assert.deepEqual(requests, { sms: 1, signIn: 1, exchange: 3 });
  await tab.run('location.hash="/vehicle-manage?setting=energy"');
  await text(tab, /电池容量与充电效率/);
  await until(tab, 'document.querySelector(".vehicle-energy-sheet input").value === "67"');
  await tab.run(`(() => {
    const [, ac, dc] = document.querySelectorAll('.vehicle-energy-sheet input');
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    for (const [input, value] of [[ac,'80'], [dc,'75']]) {
      set.call(input, value);
      input.dispatchEvent(new Event('input', { bubbles:true }));
    }
  })()`);
  await click(tab, '保存设置');
  await text(tab, /67\.0 kWh 可用容量/);
  await tab.reload();
  await text(tab, /67\.0 kWh 可用容量/);
  await tab.run('location.hash="/vehicle-manage?setting=energy"');
  await until(tab, '!!document.querySelector("dialog[open] .vehicle-energy-sheet")');
  assert.deepEqual(await tab.run('[...document.querySelectorAll(".vehicle-energy-sheet input")].map(input => input.value)'), ['67', '80', '75']);
  assert.equal(await tab.run(`(() => {
    const sheet = document.querySelector('.vehicle-energy-sheet').getBoundingClientRect();
    return [...document.querySelectorAll('.vehicle-energy-sheet input, .battery-picker-trigger')].every(el => {
      const box = el.getBoundingClientRect();
      return box.left >= sheet.left && box.right <= sheet.right;
    });
  })()`), true);
  await tab.run('location.hash="/home"');
  await until(tab, '!!document.querySelector(".hero-tools button:not(:disabled)")');
  const sampleStart = Math.max(Date.now() - 10_000, reportedAt + 1000);
  for (const [second, battery, speed, mileage, charging] of [
    [0, 80, 0, 100, false], [6, 80, 35, 100, false], [12, 78, 40, 103, false], [18, 78, 0, 105, false],
    [28, 78, 0, 105, true], [44, 79, 0, 105, true], [50, 79, 0, 105, false],
  ]) {
    reportedAt = sampleStart + second * 1000;
    soc = battery;
    gear = charging ? null : speed ? 1 : 0;
    recordSignals = { 1318: mileage, 1319: charging ? null : speed, 1149: charging ? 1 : 0, 1197: 0, 47: charging ? 1 : 0,
      1177: 400, 1178: charging ? -16 : 0, 1182: charging ? -2.5 : -11 };
    await until(tab, '!!document.querySelector(".hero-tools button:not(:disabled)")');
    await tab.click('[aria-label="刷新"]');
    await until(tab, `(async () => {
      const { readDataset } = await import('/src/data/localDatabase.ts');
      return (await readDataset('cloud-frames:fixture-account:fixture-car'))?.at(-1)?.at === ${reportedAt};
    })()`);
    if ([6, 12, 28, 44].includes(second)) {
      const activeTab = charging ? 'charges' : 'trips';
      const otherTab = charging ? 'trips' : 'charges';
      await tab.run(`location.hash="/records?tab=${activeTab}"`);
      await until(tab, '!!document.querySelector(".record-panel .recording")');
      assert.equal(await tab.run('document.querySelector(".recording b").textContent'), charging ? '正在记录充电' : '正在记录行程');
      assert.deepEqual(await tab.run('[...document.querySelectorAll(".recording dd")].map(e => e.textContent)'),
        charging ? second === 28 ? ['78.0%', '0.0 kWh', '6.4 kW'] : ['79.0%', '0.7 kWh', '6.4 kW'] :
          second === 6 ? ['35 km/h', '0.0 km'] : ['40 km/h', '3.0 km']);
      await tab.run(`location.hash="/records?tab=${otherTab}"`);
      await until(tab, `document.querySelector('.record-panel')?.getAttribute('aria-labelledby') === 'record-tab-${charging ? 0 : 1}'`);
      assert.equal(await tab.run('document.querySelectorAll(".recording").length'), 0);
      await tab.run('location.hash="/home"');
    }
  }
  await tab.run('location.hash="/records?tab=charges"');
  await until(tab, 'document.querySelector(".record-panel")?.getAttribute("aria-labelledby") === "record-tab-1"');
  assert.equal(await tab.run('document.querySelectorAll(".recording").length'), 0);
  await tab.run('location.hash="/amap"');
  await until(tab, '!!document.querySelector("dialog input[type=password]")');
  assert.deepEqual(await tab.run("[...document.querySelectorAll('.amap-key-steps a')].map(a => a.href)"),
    ['https://lbs.amap.com/', 'https://console.amap.com/dev/key/app']);
  await fill(tab, '高德地图 Key', '0123456789abcdef0123456789abcdef');
  await click(tab, '保存');
  await tab.run('location.hash="/home"');
  await until(tab, `document.querySelector('.map-title')?.textContent === ${JSON.stringify('…' + amapAddress.slice(-8))}`);
  await tab.run('location.hash="/location"');
  await text(tab, new RegExp(amapAddress));
  await tab.run('window.open = url => { window.amapOpened = url; }');
  await click(tab, '导航');
  assert.match(await tab.run('window.amapOpened'), /^https:\/\/uri\.amap\.com\/navigation\?.*callnative=1/);
  await click(tab, '管理');
  await click(tab, '新增地址');
  await text(tab, /验收附近车站/);
  await fill(tab, '搜索地址', '图');
  await text(tab, /验收图书馆/);
  assert.equal(searchCity, '021');
  assert.match(searchLocation, /^121\.\d+,31\.\d+$/);
  await tab.click('[aria-label="选择验收图书馆"]');
  await fill(tab, '名称', '常去处');
  await click(tab, '保存地址');
  assert.deepEqual(await tab.run("Object.values(JSON.parse(localStorage.getItem('leapmore.favorites.v2')))[0].at(-1).point"),
    { lat:31.231, lon:121.471, poiId:'mock-library' });
  await click(tab, '完成');
  await tab.run(`location.hash="/trips/live-${sampleStart + 6000}"`);
  await text(tab, /估算耗电/);
  await text(tab, new RegExp(amapAddress));
  assert.equal(await tab.run(`document.querySelectorAll('.trip-leg small').length`), 2);
  await text(tab, /1\.3\s*kWh/);
  await text(tab, /80\.0% → 78\.0%/);
  assert.equal(await tab.run('document.querySelector(".appbar .src-badge").textContent'), '零跑云');
  assert.doesNotMatch(await tab.run('document.querySelector(".trip-info").innerText'), /零跑云车况采样|轨迹或采样有缺口/);
  await tab.run(`location.hash="/charges/sampled-charge-${sampleStart + 28000}"`);
  await text(tab, /估算充入电量/);
  await text(tab, /充电功率/);
  await text(tab, /估算取电\s*0\.8\s*kWh/);
  await text(tab, /电池最低温\s*-2\.5\s*°C/);
  await until(tab, `document.querySelector('.charge-place-value')?.textContent === ${JSON.stringify(amapAddress)}`);
  await tab.run(`location.hash="/charges/official-${started}-${ended}"`);
  await text(tab, /官方充入电量/);
  assert.equal(await tab.run('document.querySelector(".charge-place-value").textContent'), '31.12345, 121.23456');
  await text(tab, /估算取电\s*31\.3\s*kWh/);
  await tab.run('location.hash="/records-source"');
  await text(tab, /导出记录/);
  await tab.run(`(() => {
    const click = HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click = function () {
      if (!this.download.endsWith('.csv') && !this.download.endsWith('.txt')) return click.call(this);
      window.recordsCsv = fetch(this.href).then(response => response.text()).then(csv => ({name: this.download, csv}));
    };
  })()`);
  await tab.click('[aria-label="导出记录"]');
  await until(tab, '!!document.querySelector(".record-export-sheet")');
  await click(tab, '导出 CSV');
  const all = await tab.run('window.recordsCsv');
  assert.equal(all.name, 'leapmore-records-all.csv');
  const [csvHeader, ...allRows] = all.csv.trim().split(/\r?\n/);
  assert.equal(csvHeader, 'type,source,date,distance_km,energy_kwh,coverage');
  const tripDay = allRows.find(row => row.startsWith('trip,')).split(',')[2];
  assert.ok(allRows.some(row => row.startsWith('charge,') && row.split(',')[2] !== tripDay));
  await until(tab, '!document.querySelector(".record-export-sheet")');
  // A trusted gesture gives each nested native dialog its own browser close request.
  async function tapControl(selector) {
    const point = await tab.run(`(() => {
      const el = document.querySelector(${JSON.stringify(selector)}); el.scrollIntoView({ block: 'center' });
      const r = el.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    })()`);
    await tab.send('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', buttons: 1, clickCount: 1, ...point });
    await tab.send('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', buttons: 0, clickCount: 1, ...point });
    await wait(300);
  }
  await tab.send('Page.bringToFront');
  await tapControl('[aria-label="导出记录"]');
  await tapControl('.record-export-sheet [aria-label=导出范围] button:nth-child(2)');
  await tapControl('.record-export-dates [aria-label=开始日期]');
  await until(tab, 'document.querySelectorAll("dialog[open]").length === 2');
  await tab.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 });
  await tab.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await until(tab, '!!document.querySelector(".record-export-sheet") && !document.querySelector(".choice-sheet")');
  async function setDate(label, value) {
    await tab.click('.record-export-dates [aria-label="' + label + '"]');
    await fill(tab, '输入日期', value);
    await tab.click('.choice-sheet .confirm-btns .accent');
  }
  await setDate('开始日期', '1900-01-01');
  await setDate('结束日期', '1900-01-01');
  await text(tab, /此范围内没有可导出的记录/);
  assert.equal(await tab.run('document.querySelector(".record-export-sheet .confirm-btns .accent").disabled'), true);
  await setDate('结束日期', tripDay);
  await setDate('开始日期', tripDay);
  await until(tab, '!document.querySelector(".record-export-sheet .confirm-btns .accent").disabled');
  await click(tab, '导出 CSV');
  const ranged = await tab.run('window.recordsCsv');
  assert.equal(ranged.name, `leapmore-records-${tripDay}_${tripDay}.csv`);
  assert.deepEqual(ranged.csv.trim().split(/\r?\n/).slice(1), allRows.filter(row => row.split(',')[2] === tripDay));
  await tab.run('location.hash="/mine"');
  await click(tab, '故障诊断与导出');
  await text(tab, /3D 车模诊断/);
  await click(tab, '检测网络与车辆');
  await text(tab, /读取所选车辆车况\s+成功/);
  await click(tab, '检测本车 3D 车模');
  await until(tab, '!!document.querySelector(".diagnostic-preview")');
  await tab.run('document.querySelector(".diagnostic-preview").scrollIntoView({ block: "center" })');
  await until(tab, zip ? 'document.querySelector(".diagnostic-preview [data-model-status]")?.dataset.modelStatus === "full"' :
    'document.querySelector(".diagnostic-run summary")?.textContent.includes("仅返回 2D")');
  await click(tab, '导出 CSV');
  await text(tab, /诊断报告已导出/);
  const diagnostics = await tab.run('window.recordsCsv');
  assert.match(diagnostics.name, /^leapmore-diagnostics-\d+\.csv$/);
  assert.match(diagnostics.csv, zip ? /viewerSha256/ : /modelType""\s*:\s*2/);
  assert.match(diagnostics.csv, /"powertrainReason","no-fuel-range-evidence"/);
  if (!zip) assert.match(diagnostics.csv, /"fallback"/);
  assert.ok(diagnostics.csv.includes('"build","' + JSON.parse(readFileSync(new URL('../package.json', import.meta.url))).buildNumber + '"'));
  assert.match(diagnostics.csv, /"abortCheckFallback","true"/);
  assert.match(diagnostics.csv, /"check.account","[^\r\n]*404/);
  assert.match(diagnostics.csv, /"check.list","[^\r\n]*辆授权车辆/);
  assert.doesNotMatch(diagnostics.csv, /fixture-car|LFB1A2B3C4D000001|13800001234|private-model-url|fixture-device|local-session-test-account/);
  await click(tab, '导出 TXT');
  await until(tab, 'Promise.resolve(window.recordsCsv).then(r => r?.name.endsWith(".txt"))');
  const txt = await tab.run('window.recordsCsv');
  assert.match(txt.csv, /LeapMore 诊断报告/);
  assert.match(txt.csv, /设备与服务[\s\S]*check.list[\s\S]*车模检测/);
  assert.doesNotMatch(txt.csv, /fixture-car|LFB1A2B3C4D000001|13800001234|private-model-url|fixture-device|local-session-test-account/);
  await click(tab, '结束检测');
  await tab.run('location.hash="/records-source"');
  if (hybridHA) {
    const overlap = new URLSearchParams({ tripStart:sampleStart + 6000, tripEnd:sampleStart + 18_000,
      chargeStart:sampleStart + 28_000, chargeEnd:sampleStart + 44_000 });
    assert.ok((await fetch(hybridHA + '/fixture-overlap?' + overlap, { method:'POST' })).ok);
    await tab.run('location.hash="/records-source"');
    await text(tab, /手机记录 \+ HA 同步/);
    await tab.run("[...document.querySelectorAll('.source-opt')].find(b => b.querySelector('b')?.textContent === '手机记录 + HA 同步').click()");
    await text(tab, /手动输入长期访问令牌/);
    await click(tab, '手动输入长期访问令牌');
    await fill(tab, 'HA 地址', hybridHA);
    await fill(tab, '访问令牌', 'local-manual-fixture');
    await click(tab, '连接并测试');
    await text(tab, /已读取 2 条行程 · 2 条充电记录/);
    await tab.run('location.hash="/records"');
    await until(tab, 'document.querySelectorAll(".trip-row").length === 2');
    assert.equal(await tab.run('document.querySelectorAll(".trip-row[href*=same-drive]").length'), 1);
    const visibleRows = () => tab.run('[...document.querySelectorAll(".trip-row")].map(el => el.getAttribute("href")).sort()');
    const savedTrips = await visibleRows();
    await tab.run('location.hash="/records?tab=charges"');
    await until(tab, 'document.querySelectorAll(".trip-row[href*=same-charge]").length === 1');
    assert.equal(await tab.run('document.querySelectorAll(".trip-row[href*=sampled-charge]").length'), 0);
    const savedCharges = await visibleRows();
    await tab.run(`location.hash="/trips/live-${sampleStart + 6000}"`);
    await until(tab, 'document.querySelector(".appbar .src-badge")?.textContent === "HA"');
    await tab.run(`location.hash="/charges/sampled-charge-${sampleStart + 28000}"`);
    await until(tab, 'document.querySelector(".appbar .src-badge")?.textContent === "HA"');
    const setHA = mode => fetch(hybridHA + '/fixture-mode?mode=' + mode, { method:'POST' });
    const chooseSource = async label => {
      await tab.run('location.hash="/records-source"');
      await until(tab, '!!document.querySelector(".source-opt")');
      await tab.run(`[...document.querySelectorAll('.source-opt')].find(el => el.querySelector('b').textContent === ${JSON.stringify(label)}).click()`);
    };
    await chooseSource('HA 同步');
    await tab.run('location.hash="/records?tab=charges"');
    await until(tab, 'document.querySelectorAll(".trip-row").length === ' + savedCharges.length);
    assert.deepEqual(await visibleRows(), savedCharges);
    await chooseSource('关闭记录');
    const counters = async () => {
      const {trips, charges, history} = await (await fetch(hybridHA + '/fixture-stats')).json();
      return [trips, charges, history, chargeRequests];
    };
    const before = await counters();
    await tab.run('location.hash="/records"'); await tab.reload();
    await until(tab, 'document.querySelectorAll(".trip-row").length === ' + savedTrips.length);
    assert.deepEqual(await visibleRows(), savedTrips);
    await tab.run('location.hash="/records?tab=charges"');
    await until(tab, 'document.querySelectorAll(".trip-row").length === ' + savedCharges.length);
    assert.deepEqual(await visibleRows(), savedCharges);
    await tab.run(`location.hash="/trips/live-${sampleStart + 6000}"`);
    await until(tab, 'document.querySelector(".appbar .src-badge")?.textContent === "HA"');
    assert.deepEqual(await counters(), before, '只读历史不应触发行程、充电或采样同步');
    await chooseSource('手机记录 + HA 同步');
    await setHA('offline');
    await tab.run('location.hash="/ha"');
    await text(tab, /立即同步/);
    await click(tab, '立即同步');
    await text(tab, /连接中断|服务暂不可用|LeapToHA 行程和充电记录暂不可用/, 40_000);
    await tab.run('location.hash="/records"');
    await until(tab, 'document.querySelectorAll(".trip-row").length === 2');
    await setHA('normal');
    await tab.run('location.hash="/ha"');
    await text(tab, /立即同步/);
    await click(tab, '立即同步');
    await text(tab, /已读取 2 条行程 · 2 条充电记录/);
    assert.equal(await tab.run("JSON.parse(localStorage.getItem('leapmore.source'))"), 'hybrid');
    console.log('手机与 HA 断线重连、同车行程和充电去重通过。');
  }
  await tab.run('location.hash="/records"');
  const deleteRow = JSON.stringify(hybridHA ? '.trip-row[data-deletable][href*="ha-trip-same-drive"]' : '.trip-row[data-deletable]');
  await until(tab, `!!document.querySelector(${deleteRow})`);
  const rowPoint = await tab.run(`(() => {
    const row = document.querySelector(${deleteRow});
    row.closest('details').open = true;
    row.scrollIntoView({block:'center'});
    const {left, top, width, height} = row.getBoundingClientRect();
    return {x: left + width / 2, y: top + height / 2};
  })()`);
  const longPressTrip = async () => {
    await tab.send('Page.bringToFront');
    await tab.send('Input.dispatchTouchEvent', { type:'touchStart', touchPoints:[rowPoint] });
    await text(tab, /确认删除/);
    await tab.send('Input.dispatchTouchEvent', { type:'touchEnd', touchPoints:[] });
    assert.equal(await tab.run('location.hash'), '#/records');
  };
  await longPressTrip();
  await click(tab, '取消');
  assert.equal(await tab.run(`document.querySelectorAll(${deleteRow}).length`), 1);
  await longPressTrip();
  await click(tab, '确认删除');
  await text(tab, /已从本机删除行程/);
  if (hybridHA) {
    await tab.run('location.hash="/ha"');
    await text(tab, /立即同步/);
    await click(tab, '立即同步');
    await text(tab, /已读取 2 条行程 · 2 条充电记录/);
    assert.equal((await (await fetch(hybridHA + '/fixture-stats')).json()).deletes, 0);
    await tab.run('location.hash="/records"');
    await tab.reload();
    await until(tab, '!!document.querySelector(".trip-row[href*=ledger-test]")');
    assert.equal(await tab.run(`document.querySelectorAll(${deleteRow}).length`), 0);
    await tab.run('location.hash="/records-source"');
    await until(tab, '!!document.querySelector(".source-opt")');
    await tab.click('.source-opt:first-of-type');
    await tab.run('location.hash="/records"');
  }
  await tab.reload();
  if (hybridHA) {
    await until(tab, '!!document.querySelector(".trip-row[href*=ledger-test]")');
    assert.equal(await tab.run('document.querySelectorAll(".trip-row[href*=same-drive]").length'), 0);
  } else {
    await text(tab, /暂无行程记录/);
    assert.equal(await tab.run('document.querySelectorAll(".trip-row").length'), 0);
  }
  await tab.run('location.hash="/home"');
  await until(tab, '!!document.querySelector(".hero-tools button:not(:disabled)")');
  recordSignals = { ...recordSignals, 1816: 0, 1624: 15, 49: 0, 50: 1, 2100: 0, 1349: 31, 2183: 0, 2184: '23.5' };
  reportedAt += 1000;
  await tab.click('[aria-label="刷新"]');
  await text(tab, /车况已更新/);
  await until(tab, 'document.querySelector(".home .temp-target")?.textContent === "23.5℃"');
  await tab.run('location.hash="/climate"');
  await until(tab, 'document.querySelectorAll(".climate-page [role=switch]").length === 2');
  assert.deepEqual(await heaters(), [['方向盘加热', 'false'], ['后视镜加热', 'true']]);
  assert.equal(await tab.run('!!document.querySelector(".climate-seats [aria-label=通风]")'), false);
  for (const [label, expected, signalId, reading] of [
    ['方向盘加热', ['320', { level:'2' }], 1816, 2], ['后视镜加热', ['440', { value:'1' }], 50, 0],
  ]) {
    commandStatus = 'pending';
    await tab.click(`[role=switch][aria-label="${label}"]`);
    await confirmControl();
    await text(tab, /云端已受理/);
    assert.deepEqual(remoteWrites.at(-1), expected);
    recordSignals[signalId] = reading;
    reportedAt += 1000;
    commandStatus = 'success';
    await text(tab, /操作成功 · 车端已确认/);
    await until(tab, '!document.querySelector("dialog[open]")');
  }
  assert.deepEqual(await heaters(), [['方向盘加热', 'true'], ['后视镜加热', 'false']]);
  commandStatus = 'pending';
  assert.equal(await tab.run('document.querySelector(".climate-target").textContent'), '23.5℃');
  await tab.click('[aria-label="提高目标温度"]');
  await click(tab, '发送空调设置');
  await confirmControl();
  await text(tab, /云端已受理/);
  assert.equal(remoteWrites.at(-1)[1].temperature, '24.5');
  Object.assign(recordSignals, { 1938: 1, 2183: '24.5', 1941: 3 });
  reportedAt += 1000;
  commandStatus = 'success';
  await text(tab, /操作成功 · 车端已确认/);
  await until(tab, '!document.querySelector("dialog[open]")');
  await tab.run('location.hash="/home"');
  await until(tab, 'document.querySelector(".home .temp-target")?.textContent === "24.5℃"');
  commandStatus = 'pending';
  console.log('手机记录经模拟车况、SOC 采样和持久化生成行程与充电；容量和交流、直流效率按车保存，并回算费用。');
  if (!hybridHA) {
    await tab.run('location.hash="/records-source"');
    await until(tab, '!!document.querySelector(".source-opt")');
    await tab.run("Array.from(document.querySelectorAll('button.row')).find(el=>el.innerText.includes('清理本地记录')).click()");
    await fill(tab, '输入清除本地记录', '清除本地记录');
    await click(tab, '清除记录');
    await text(tab, /本车本地记录已清理/);
    assert.equal(await tab.run("JSON.parse(localStorage.getItem('leapmore.source'))"), 'off');
    const readFrames = "import('/src/data/localDatabase.ts').then(db=>db.readDataset('cloud-frames:fixture-account:fixture-car'))";
    assert.equal(await tab.run(readFrames + '.then(rows=>rows?.length ?? 0)'), 0);
    await tab.run("Array.from(document.querySelectorAll('.source-opt')).find(el=>el.querySelector('b')?.textContent==='手机记录').click()");
    await until(tab, "JSON.parse(localStorage.getItem('leapmore.source'))==='phone'");
    await tab.run('location.hash="/home"');
    reportedAt = Math.max(reportedAt + 1000, Date.now());
    const previousSignals = recordSignals;
    recordSignals = { ...recordSignals, 47: 1, 1149: 1, 1319: 0 };
    gear = 0;
    await until(tab, '!!document.querySelector(".hero-tools button:not(:disabled)")');
    await tab.click('[aria-label="刷新"]');
    await until(tab, readFrames + '.then(rows=>rows?.at(-1)?.at===' + reportedAt + ' && rows.at(-1).data.charge==="charging")');
    recordSignals = previousSignals;
    console.log('清理关闭手机记录，重选手机记录后新充电样本写入成功。');
  }
  await tab.run('location.hash="/control"');
  boundOwner = true;
  const writesBeforeCheck = remoteWrites.length;
  await tab.run(`localStorage.setItem('leapmore.always-sentry:cloud:fixture-account:' + ${JSON.stringify(vehicle.vin)}, 'true')`);
  await tab.reload();
  await until(tab, "document.querySelector('[aria-label=哨兵模式]')?.getAttribute('aria-disabled') === 'true'");
  await tab.click('[aria-label=哨兵模式]');
  await text(tab, /正在施工/);
  assert.equal(await tab.run("document.querySelectorAll('dialog[open]').length"), 0);
  assert.equal(remoteWrites.length, writesBeforeCheck);
  boundOwner = false;
  includeSecondVehicle = true;
  await tab.run('location.hash="/vehicle-access"');
  await text(tab, /刷新授权/);
  await click(tab, '刷新授权');
  await text(tab, /授权已刷新/);
  await tab.run('location.hash="/vehicles"');
  await text(tab, /第二辆验收车辆/);
  await tab.click('.vcard:nth-of-type(2)');
  await click(tab, '进入车辆');
  await text(tab, /选择电池容量/);
  await click(tab, '稍后设置');
  await until(tab, 'location.hash === "#/home"');
  await tab.reload();
  await until(tab, '!!document.querySelector(".home:not([hidden])")');
  await tab.run('location.hash="/vehicles"');
  await text(tab, /第二辆验收车辆/);
  await click(tab, '进入车辆');
  await until(tab, 'location.hash === "#/home"');
  assert.equal(await tab.run('!!document.querySelector(".vehicle-energy-sheet")'), false);
  recordSignals = { 2188: null, 3235: 80, 3261: 383 };
  const rememberedKey = 'leapmore.powertrain.knownReev:' + JSON.stringify(['fixture-account', secondVehicle.vin]);
  await tab.run('localStorage.setItem(' + JSON.stringify(rememberedKey) + ', "true")');
  await tab.reload();
  async function refreshFuel() {
    reportedAt += 1000;
    await until(tab, '!!document.querySelector(".hero-tools button:not(:disabled)")');
    await tab.click('[aria-label="刷新"]');
    await until(tab, '!document.querySelector(".hero-tools button[aria-busy=true]")');
  }
  await refreshFuel();
  const fuelBar = '!!document.querySelector(".soc-bar.fuel")';
  await until(tab, 'document.querySelector(".hero .energy-val")?.textContent === "383km"');
  assert.equal(await tab.run(fuelBar), false);
  await tab.run('location.hash="/states"');
  await until(tab, '!!document.querySelector(".card.diagnostic-fold > summary")');
  await tab.click('.card.diagnostic-fold > summary');
  await text(tab, /尚无燃油贡献续航的记录/);
  await text(tab, /综合续航 · 383 km/);
  await tab.run('location.hash="/widgets"');
  await text(tab, /桌面卡片预览/);
  await click(tab, '大 · 4×4');
  await until(tab, '!!document.querySelector(".widget-large .widget-level.battery")');
  assert.ok(await tab.run(`(async () => {
    const logo = document.querySelector('.widget-large .widget-logo');
    await logo.decode();
    return logo.currentSrc === document.querySelector('link[rel="icon"]').href;
  })()`));
  assert.equal(await tab.run('!!document.querySelector(".widget-level.fuel")'), false);
  assert.match(await tab.run('document.querySelector(".widget-range").innerText'), /383/);
  await tab.run('location.hash="/energy"');
  await text(tab, /21.3/);
  assert.doesNotMatch(await tab.run('document.body.innerText'), /平均油耗/);
  assert.ok(!fuelRequests.includes(secondVehicle.vin));
  await tab.run('location.hash="/home"');
  Object.assign(recordSignals, { 3259: 420, 3260: 150, 3261: 570 });
  await refreshFuel();
  await until(tab, fuelBar);
  assert.equal(await tab.run('JSON.parse(localStorage.getItem(' + JSON.stringify(rememberedKey) + '))'), 'fuel-range');
  assert.equal(await tab.run('document.querySelector(".hero .energy-val").textContent'), '570km');
  Object.assign(recordSignals, { 3259: 0, 3261: 150 });
  await tab.reload();
  await text(tab, new RegExp(soc + '%'));
  await until(tab, fuelBar);
  await tab.run('location.hash="/energy"');
  await text(tab, /平均油耗/);
  await text(tab, /6\.2/);
  assert.ok(fuelRequests.includes(secondVehicle.vin));
  await tab.run('location.hash="/states"');
  await until(tab, '!!document.querySelector(".card.diagnostic-fold > summary")');
  await tab.click('.card.diagnostic-fold > summary');
  await text(tab, /本车此前已识别为增程/);
  await click(tab, '管理本车动力类型');
  await tab.click('[aria-label="动力类型"] button:nth-child(2)');
  await tab.reload();
  await text(tab, /当前按纯电显示/);
  await tab.run('location.hash="/home"');
  await text(tab, new RegExp(soc + '%'));
  Object.assign(recordSignals, { 3259: 420, 3261: 570 });
  await refreshFuel();
  assert.equal(await tab.run('JSON.parse(localStorage.getItem(' + JSON.stringify(rememberedKey) + '))'), null);
  Object.assign(recordSignals, { 3259: 0, 3261: 150 });
  await refreshFuel();
  assert.equal(await tab.run(fuelBar), false);
  await tab.run('location.hash="/vehicle-manage"');
  await text(tab, /动力类型/);
  await tab.click('[aria-label="动力类型"] button:first-child');
  await text(tab, /当前按纯电显示/);
  await tab.click('.vcard');
  await text(tab, /当前按纯电显示/);
  console.log('C11 固定 80% 虚假油量、增程空油箱记忆、按车手动覆盖及车辆切换验收通过。');
  includeSecondVehicle = false;
  console.log('首次选车的容量引导可保存或稍后设置，刷新后保留选择。');
  await tab.run('location.hash="/home"');
  await until(tab, '!!document.querySelector(".hero-tools button:not(:disabled)")');
  rejectSession = true;
  await tab.click('[aria-label="刷新"]');
  await text(tab, /零跑账号登录已失效/);
  await tab.click('dialog[open] .confirm-btns button:last-child');
  assert.equal(await tab.run("location.hash"), '#/login');
  assert.equal(await tab.run("document.querySelectorAll('dialog[open]').length"), 0);
  rejectSession = false;
  await tab.click('[aria-label="同意条款"]');
  await fill(tab, '手机号', '13800001234');
  await click(tab, '获取验证码'); await text(tab, /验证码已发送/);
  await fill(tab, '验证码', '654321');
  await tab.click('.login form button[type=submit]');
  await text(tab, /本地验收车辆/);
  assert.equal(await tab.run("document.querySelectorAll('dialog[open]').length"), 0);
  await tab.run('location.hash="/mine"');
  await text(tab, /退出登录/);
  await click(tab, '退出登录');
  await tab.click('dialog[open] .confirm-btns button:last-child');
  await text(tab, /获取验证码/);
  assert.equal(await tab.run(`(async () => {
    const {readLocalSecret} = await import('/src/platform/localVault.ts');
    return (await readLocalSecret('leapmotor-session')) === undefined;
  })()`),true);
  assert.deepEqual(tab.errors, []);
  const beforeProtocolChecks = remoteWrites.length;
  commandStatus = 'success';
  assert.deepEqual(await tab.run(`(async () => {
    const { LiveVehicleClient } = await import('/src/data/cloud/LiveClient.ts');
    const client = new LiveVehicleClient({accessToken: ${JSON.stringify(carToken(3))}, hkdfKeyHex: 'ab'.repeat(16), expiresAt: Date.now()+60000},
      {token:'fixture',userId:'fixture-account',expiresAt:Date.now()+60000}, 'fixture-device');
    const commands = [
      {kind:'trunk',open:true}, {kind:'window',position:'vent'}, {kind:'shade',open:false},
      {kind:'climate',on:false,temp:26,fan:4,mode:'cool'}, {kind:'seat',feature:'vent',level:2},
      {kind:'find'}, {kind:'charge',health:false}, {kind:'charge',plan:{limit:85}},
      {kind:'navigation',destination:{name:'测试',address:'合成地址',lat:31.2,lon:121.4}},
    ];
    const result = [];
    for (const command of commands) {
      const receipt = await client.sendCommand('fixture-car', command, '654321', new AbortController().signal, () => {});
      result.push(await client.queryCommand(receipt));
    }
    return result;
  })()`), ['confirmed', 'confirmed', 'confirmed', 'confirmed', 'confirmed', 'confirmed', 'pending', 'confirmed', 'confirmed']);
  assert.deepEqual(remoteWrites.slice(beforeProtocolChecks), [
    ['130', { value: 'true' }], ['230', { value: '2' }], ['240', { value: '0' }],
    ['170', { operate: 'off', mode: 'nohotcold', circle: 'out', position: 'all', temperature: '26', windlevel: 4, wshld: '1' }],
    ['370', { position: 'driver', level: '2' }], ['120', { value: 'true' }], ['healthyCharging', '0'],
    ['190', { chargeEnable: 1, chargesoc: 85, circulation: 1, cycles: '1,1,1,1,1,1,1', endtime: '06:00', recharge: 1, starttime: '23:00' }],
    ['180', { addresskey: '', address: '合成地址', addressname: '测试', latitude: '31.2', longitude: '121.4', linenum: '0' }],
  ]);
  await tab.run(`(async () => {
    const { LiveVehicleClient } = await import('/src/data/cloud/LiveClient.ts');
    const client = new LiveVehicleClient({accessToken: ${JSON.stringify(carToken(3))}, hkdfKeyHex: 'ab'.repeat(16), expiresAt: Date.now()+60000},
      {token:'fixture',userId:'fixture-account',expiresAt:Date.now()+60000}, 'fixture-device');
    const [previous] = await client.getPreheatSchedules('fixture-car');
    await client.sendCommand('fixture-car', {kind:'preheat', edit:{previous, enabled:true, start:'06:30', days:[1,3]}}, '654321',
      new AbortController().signal, () => {});
  })()`);
  assert.equal(remoteWrites.at(-1)[0], '161');
  assert.match(preheatPlans[0].start_time, / 06:30:00$/);
  assert.deepEqual(preheatPlans[0].days, [1, 3]);
  assert.deepEqual(preheatPlans[1], secondPreheat);
  const beforeT03Routes = routeRequests;
  t03 = 'named';
  const t03States = await tab.run(`(async () => {
    const { LiveVehicleClient } = await import('/src/data/cloud/LiveClient.ts');
    const client = new LiveVehicleClient({accessToken: ${JSON.stringify(carToken(3))}, hkdfKeyHex: 'ab'.repeat(16), expiresAt: Date.now()+60000},
      {token:'fixture',userId:'fixture-account',expiresAt:Date.now()+60000}, 'fixture-device');
    const [vehicle] = await client.getVehicles();
    const frame = await client.getState(vehicle.id);
    const again = await client.getState(vehicle.id);
    return [vehicle.carType, frame.soc, frame.rangeKm, frame.odometer, frame.tirePressureKpa[0], frame.windowOpen, frame.locked,
      frame.trunkOpen, frame.isDriving, frame.charging, frame.seatHeat, again.soc, frame.batteryMinTempC];
  })()`);
  assert.deepEqual(t03States, ['T03', 61, 172, 2445, 239, true, true, false, false, 'unplugged', null, 61, -3.5]);
  assert.equal(routeRequests, beforeT03Routes + 1);
  assert.equal(regionReads, 2);
  t03 = 'numbered';
  assert.deepEqual(await tab.run(`(async () => {
    const { LiveVehicleClient } = await import('/src/data/cloud/LiveClient.ts');
    const client = new LiveVehicleClient({accessToken: ${JSON.stringify(carToken(3))}, hkdfKeyHex: 'ab'.repeat(16), expiresAt: Date.now()+60000},
      {token:'fixture',userId:'fixture-account',expiresAt:Date.now()+60000}, 'fixture-device');
    const [vehicle] = await client.getVehicles();
    const frame = await client.getState(vehicle.id);
    return [frame.soc, frame.locked, frame.latitude, frame.longitude, new Date(frame.updatedAt).toISOString()];
  })()`), [62, true, 30.25, 120.5, '2026-10-20T00:09:10.000Z']);
  assert.equal(routeRequests, beforeT03Routes + 1);
  assert.deepEqual(tab.errors, []);
  console.log('模拟零跑通过操作密码校验、驻车与授权限制、请求受理和车端回读。T03 具名字段与区域路由复用通过。');
  console.log('刷新时自动续期，授权失效弹窗后可重新短信登录。重开标签恢复车况，切换演示保留真实会话，退出真实账号清除会话。');
} finally {
  await tab.send('Storage.clearDataForOrigin', { origin, storageTypes: 'local_storage,indexeddb' }).catch(() => {});
  await tab.close();
}
