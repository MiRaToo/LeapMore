import { browser, wait } from './cdp.mjs';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const origin = process.env.LEAPMORE_DEMO_ORIGIN ?? 'http://127.0.0.1:5175/';
const b = await browser('about:blank', 390, 844);
const match = async (pattern, timeout = 6500) => {
  let body = '';
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    body = await b.run('document.body.innerText');
    if (pattern.test(body)) return;
    await wait(100);
  }
  throw new Error('未找到 ' + pattern + '\n' + body.slice(0, 800));
};
const click = async (label, selector = 'button,a') => {
  await b.run(`(() => {
    const element = Array.from(document.querySelectorAll(${JSON.stringify(selector)})).find(e=>e.getClientRects().length&&e.textContent.trim()===${JSON.stringify(label)});
    if (!element) throw Error(${JSON.stringify(label)});
    element.click();
  })()`);
  await wait(145);
};
const route = async (path) => { await b.run('location.hash=' + JSON.stringify(path)); await wait(190); };
const fill = async (label, value) => {
  await b.run(`(() => {
    const i = document.querySelector('[aria-label='+CSS.escape(${JSON.stringify(label)})+']') ?? [...document.querySelectorAll('input')].find(el=>el.labels?.[0]?.textContent.trim() === ${JSON.stringify(label)});
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(i,${JSON.stringify(value)});
    i.dispatchEvent(new Event('input',{bubbles:true}));
  })()`);
};
try {
  await b.send('Storage.clearDataForOrigin', { origin: new URL(origin).origin, storageTypes: 'local_storage,indexeddb' });
  await b.navigate(origin);
  await match(/欢迎回来|驻车照片|使用演示账号/);
  if (process.env.LEAPMORE_TEST_3D === '1') await b.run(`localStorage.setItem('leapmore.wrap',JSON.stringify({
    'demo-c10': { rear: {kind:'stripe',color:'#102938',x:50,y:50,rotation:15,scale:100,opacity:75} }
  }))`);
  if ((await b.run('document.body.innerText')).includes('欢迎使用 LeapMore')) await click('我知道了');
  const session = await b.run("localStorage.getItem('leapmore.mode')");
  if (session !== '"demo"') {
    await route('/login');
    await match(/使用演示账号/);
    await click('使用演示账号');
    await click('进入车辆');
  }
  await route('/quick-controls');
  assert.deepEqual(await b.run('[...document.querySelectorAll(".page .secH")].map(el => el.textContent)'), ['备车','空调','车窗','车锁与寻车']);
  assert.equal(await b.run('document.querySelectorAll(".page .sec button.row").length'), 12);
  const quick = (action, key) => route('/quick-action?' + new URLSearchParams({ action, target: JSON.stringify(key) }));
  await quick('find', ['demo', 'demo-b10', 'DEMO••3106']);
  await match(/确认鸣笛寻车/);
  assert.match(await b.run("document.querySelector('.confirm-sheet .sub').textContent"), /家里的 B10/);
  await click('取消');
  await quick('prepare', ['demo', 'demo-c10', 'DEMO••8821', 'winter']);
  await match(/确认立即备车/);
  assert.match(await b.run("document.querySelector('.confirm-sheet').textContent"), /我的 C10.*冬日温暖/);
  await click('取消');
  await route('/home');
  await match(/驻车照片/);
  assert.equal(await b.run("document.querySelector('.map-card .map-title')"), null);
  for (const [x, y] of [[.07, .15], [.12, .6], [.1, .9], [.9, .95]]) {
    await b.run(`(() => {
      const card = document.querySelector('.map-card');
      card.scrollIntoView({ block: 'center' });
      const r = card.getBoundingClientRect();
      const point = document.elementFromPoint(r.x + r.width * ${x}, r.y + r.height * ${y});
      if (point?.closest('a') !== card.querySelector('.home-map-link')) throw Error('地图存在点击空区');
      point.click();
    })()`);
    await match(/车辆位置/);
    await b.click('.appbar [aria-label=返回]');
    await match(/驻车照片/);
  }
  await click('驻车照片');
  assert.equal(await b.run("document.querySelector('dialog[open] h2')?.textContent"), '驻车照片');
  assert.equal(await b.run("location.hash"), '#/home');
  await click('关闭', 'dialog[open] button');
  await click('鸣笛寻车', '.map-pills button');
  await match(/确认鸣笛寻车/);
  await click('取消');
  if (process.env.LEAPMORE_TEST_3D === '1') {
    await b.run(`new Promise((resolve, reject) => {
      const stop = Date.now() + 19000;
      function check() {
        if (document.querySelector('.home-model')?.dataset.modelStatus === 'full') { resolve(); return; }
        if (Date.now() > stop) { reject(new Error('首页 3D 未加载')); return; }
        setTimeout(check, 100);
      }
      check();
    })`);
    await b.run("window.checkedHomeViewer = document.querySelector('.home-model iframe'); window.checkedHomeViewerLoads = 0; window.checkedHomeViewer.addEventListener('load', () => window.checkedHomeViewerLoads++);");
    const drag = await b.run(`new Promise(resolve => {
      const frame = window.checkedHomeViewer.contentWindow;
      const startingAngle = frame.viewer.controls.getAzimuthalAngle();
      frame.addEventListener('message', function check(event) {
        if (event.data?.t !== 'test-orbit-check') return;
        frame.removeEventListener('message', check);
        const difference = frame.viewer.controls.getAzimuthalAngle() - startingAngle;
        resolve(Math.atan2(Math.sin(difference),Math.cos(difference)));
        frame.postMessage({t:'orbit-reset', animate:false}, location.origin);
      });
      frame.postMessage({t:'orbit', azimuth:.22, pitch:0, zoom:1}, location.origin);
      frame.postMessage({t:'test-orbit-check'}, location.origin);
    })`);
    assert.ok(Math.abs(drag - .22) < .03, '触摸消息到达时应直接更新镜头');
    await route('/energy');
    assert.equal(await b.run(`(() => {
      const {renderer, scene, camera} = window.checkedHomeViewer.contentWindow.viewer;
      const frame = renderer.info.render.frame;
      renderer.render(scene, camera);
      return renderer.info.render.frame === frame;
    })()`), true);
    await route('/mine');
    await route('/home');
    assert.equal(await b.run("window.checkedHomeViewer === document.querySelector('.home-model iframe') && window.checkedHomeViewerLoads === 0"), true);
  }
  await click('胎压');
  await click('设置范围');
  await fill('最低胎压（kPa）','235');
  await fill('最高胎压（kPa）','245');
  await click('保存范围');
  await match(/235–245 kPa/);
  assert.equal(await b.run("document.querySelectorAll('.tire-diagram .tire[data-pressure-alert]').length"), 2);
  await b.click('dialog[open] [aria-label=关闭]');
  assert.equal(await b.run("document.querySelector('.home-entries button').getAttribute('aria-description')"), '胎压异常');
  assert.equal(await b.run("getComputedStyle(document.querySelector('.home-entries button .entry-ic'), '::after').backgroundColor"), 'rgb(219, 68, 55)');
  await b.run(`(() => {
    const car = JSON.parse(localStorage.getItem('leapmore.activeVehicle'));
    const config = { climate: true, temperature: 21, fan: 2, seat: 'none', steering: false, mirrors: false, destination: null };
    const presets = [{ ...config, id: 'commute', name: '日常通勤' }, { ...config, id: 'my-trip', name: '我的旧预设' }];
    localStorage.setItem('leapmore.preparation-presets:demo:' + car, JSON.stringify({presets, selected: 'my-trip'}));
    localStorage.setItem('leapmore.always-sentry:demo:DEMO••8821', 'true');
  })()`);
  await b.click('.home-entries a[href="#/control"]');
  await match(/一键备车/);
  assert.equal(await b.run("document.querySelectorAll('.vehicle-controls .tpms, .vehicle-controls .tire').length"), 0);
  for (const label of ['哨兵模式','手机遥控器','直进直出','泊车辅助']) {
    await click(label);
    await match(/正在施工/);
    assert.equal(await b.run("location.hash"), '#/control');
    assert.equal(await b.run("document.querySelectorAll('dialog[open]').length"), 0);
  }
  for (const feature of ['remote','straight','parking']) {
    await route('/control/' + feature);
    assert.equal(await b.run("location.hash"), '#/control');
  }
  assert.ok(await b.run("document.querySelector('.construction-sentry').closest('.sec').contains(document.querySelector('.proximity-controls'))"));
  assert.ok(await b.run("[...document.querySelectorAll('.prepare-options button')].some(e => e.textContent === '我的旧预设')"));
  await click('冬日温暖');
  await match(/冬日温暖 · 空调 26℃ · 风量 3 档/);
  await click('取消');
  await click('管理预设');
  await b.click('[aria-label="编辑冬日温暖"]');
  await click('删除预设');
  await click('确认删除预设');
  await b.reload();
  await match(/一键备车/);
  assert.equal(await b.run("[...document.querySelectorAll('.prepare-options button')].some(e => e.textContent === '冬日温暖')"), false);
  await click('管理预设');
  await b.click('[aria-label="编辑日常通勤"]');
  await match(/编辑备车预设/);
  await b.click('.prep-editor [aria-label="关闭"]');
  await click('新建预设');
  assert.equal(await b.run("document.querySelectorAll('[aria-label=备车空调预设] button').length"), 4);
  await click('风挡除霜');
  await fill('预设名称', '测试出发');
  await b.click('.prep-editor button.row');
  await match(/附近地点/);
  await fill('搜索目的地', '图');
  await match(/上海图书馆东馆/);
  await fill('搜索目的地', '家');
  await b.click('[aria-label="选择家"]');
  await b.click('[aria-label="预设座椅"] button:nth-child(2)');
  await b.click('[aria-label="方向盘加热"]');
  await b.click('[aria-label="后视镜加热"]');
  await click('保存预设');
  await click('测试出发');
  await match(/测试出发 · 家、风挡除霜、主驾座椅加热、方向盘加热、后视镜加热/);
  await click('确认发送');
  await match(/车端已确认/);
  await wait(1000);
  await b.click('.schedule-entry button');
  await click('添加预约');
  await b.click('[aria-label="备车重复日期"] [aria-label="周一"]');
  await click('保存预约');
  await click('确认发送');
  await match(/预约备车已更新/);
  await wait(1000);
  await match(/周一/);
  assert.equal(await b.run("document.querySelector('.prep-plan-details span').textContent"), '测试出发');
  await b.click('.prep-plan-details');
  await click('删除预约');
  await click('确认发送');
  await match(/预约备车已更新/);
  await wait(1000);
  await match(/暂无预约备车/);
  await click('添加预约');
  await click('自定义', '[aria-label="预约配置方式"] button');
  assert.equal(await b.run('document.querySelectorAll("dialog[open]").length'), 1);
  await b.click('[aria-label="预设空调"]');
  await b.click('[aria-label="风量"]');
  await click('5 档', 'dialog[open] button');
  assert.match(await b.run('document.querySelector("[aria-label=风量]").textContent'), /5 档/);
  await click('使用预设', '[aria-label="预约配置方式"] button');
  await click('自定义', '[aria-label="预约配置方式"] button');
  assert.match(await b.run('document.querySelector("[aria-label=风量]").textContent'), /5 档/);
  await click('保存预约');
  await click('确认发送');
  await match(/预约备车已更新/);
  await wait(1000);
  assert.equal(await b.run("document.querySelector('.prep-plan-details span').textContent"), '自定义备车');
  await b.click('dialog[open] [aria-label="关闭"]');
  await route('/home');
  await route('/control');
  await click('测试出发');
  await match(/确认立即备车/);
  await click('取消');
  await route('/home');
  await b.click('[aria-label=车窗]');
  await click('开一条缝');
  await match(/确认车窗开一条缝/);
  await click('取消');
  await b.click('[aria-label=空调预设]');
  await click('极速降温');
  await click('确认发送');
  await match(/车端已确认/);
  await wait(1050);
  await match(/18.0/);
  await b.click('[aria-label="座椅与加热"]');
  await match(/主驾座椅加热/);
  await b.run("document.querySelector('dialog[open]').dispatchEvent(new Event('cancel',{cancelable:true}))");
  await route('/location');
  await match(/车辆位置/);
  const marker = await b.run(`(() => {
    const map = document.querySelector('.location-map .amap-view').getBoundingClientRect();
    const button = document.querySelector('.location-map .amap-car');
    const pin = button.getBoundingClientRect(), icon = button.querySelector('svg').getBoundingClientRect();
    const center = rect => [rect.x + rect.width / 2, rect.y + rect.height / 2];
    return { width: pin.width, pin: center(pin), map: center(map), icon: center(icon) };
  })()`);
  assert.equal(marker.width, 26);
  assert.ok(marker.pin.every((value, i)=>Math.abs(value-marker.map[i])<1 && Math.abs(value-marker.icon[i])<1));
  assert.equal(await b.run(`document.querySelector('.location-page .hint').classList.contains('warn')`),false);
  await click('去配置');
  await match(/Web 服务 Key/);
  await click('取消','dialog button');
  await click('管理');
  assert.equal(await b.run('document.querySelectorAll(".favorite-delete").length'), 3);
  await click('新增地址');
  await match(/附近地点/);
  await fill('搜索地址','模拟车位 A');
  await click('使用输入的地址');
  await fill('名称','测试车位');
  await click('保存地址');
  await match(/模拟车位 A/);
  await click('完成');
  await b.click('[aria-label="发送导航到测试车位"]');
  await match(/确认发送导航到测试车位/);
  await click('取消');
  await click('管理');
  await b.click('[aria-label="删除测试车位"]');
  await click('删除', 'dialog button');
  assert.ok(!(await b.run('document.body.innerText')).includes('模拟车位 A'));
  await click('完成');
  await route('/records-source');
  await b.click('.source-opt:first-of-type');
  await route('/trips/demo-trip-0');
  const mapZoom = () => b.run("Number(document.querySelector('.amap-trip').dataset.mapZoom)");
  const originalZoom = await mapZoom();
  await b.click('[aria-label=地图设置]');
  await b.click('[aria-label=放大]');
  assert.ok(await mapZoom() > originalZoom);
  await b.click('[aria-label=回到路线]');
  await b.click('[aria-label=地图设置]');
  await b.click('[aria-label=切换底图]');
  await match(/日间/);
  await b.click('[aria-label=切换底图]');
  await match(/卫星/);
  await route('/appearance');
  if (process.env.LEAPMORE_TEST_3D === '1') {
    await match(/本地样例/,23000);
    assert.equal(await b.run("document.querySelector('[aria-label=\"3D 设置\"]').getAttribute('aria-expanded')"),'true');
    assert.ok(await b.run(`(() => {
      const preview=document.querySelector('.appearance-preview').getBoundingClientRect();
      const settings=document.querySelector('.appearance-controls').getBoundingClientRect();
      window.appearanceFrame=document.querySelector('.c3d-stage iframe');
      return preview.height >= 190 && settings.top >= preview.bottom && !document.querySelector('dialog[open]');
    })()`));
    await click('夜间','[aria-label="背景"] button');
    for(let attempt=0;attempt<15;attempt++){
      if(await b.run(`(() => {const node=window.appearanceFrame.contentWindow.__api?.skyNode(), u=node?.material.uniforms;
        return u?.dayOrNight?.value===1&&u.nightTexture.value.image.dataset?.source==='procedural-night';})()`)) break;
      await wait(140);
    }
    assert.equal(await b.run(`(() => {const node=window.appearanceFrame.contentWindow.__api?.skyNode(), u=node?.material.uniforms;
      const sky=u?.nightTexture?.value?.image;
      if(u?.dayOrNight?.value!==1||sky?.dataset?.source!=='procedural-night')return false;
      const pixel=sky.getContext('2d').getImageData(0,sky.height-1,1,1).data;
      const floor=getComputedStyle(document.documentElement).getPropertyValue('--bg').trim();
      const expected=[1,3,5].map(offset=>Number.parseInt(floor.slice(offset,offset+2),16));
      return expected.every((value,i)=>pixel[i]===value);
    })()`),true);
    await b.click('[aria-label=冰川蓝]');
    await match(/冰川蓝/);
    await b.click('[aria-label=自定义车漆]');
    await match(/色相/);
    assert.equal(await b.run("window.appearanceFrame===document.querySelector('.c3d-stage iframe') && !!document.querySelector('.model-orbit') && !document.querySelector('dialog[open]')"),true);
    await click('完成');
    await click('自定义车衣');
    await click('车尾', '.wrap-faces button');
    assert.match(await b.run("document.querySelector('[aria-label=自定义车衣颜色]').textContent"), /#102938/);
    await click('车头', '.wrap-faces button');
    await click('条纹');
    await b.click('[aria-label=自定义车衣颜色]');
    await fill('十六进制颜色', '#13579B');
    await click('确定', '.choice-sheet button');
    assert.match(await b.run("document.querySelector('[aria-label=自定义车衣颜色]').textContent"), /#13579B/);
    await b.click('.wrap-palette [aria-label=珊瑚红]');
    assert.equal(await b.run("document.querySelector('.wrap-adjustments').open"), false);
    await b.click('.wrap-adjustments summary');
    await match(/不透明度/);
    await fill('旋转', '45');
    await match(/45°/);
    await click('左侧', '.wrap-faces button');
    await click('渐变');
    await b.click('.wrap-palette [aria-label=冰川蓝]');
    await b.click('[aria-label=渐变结束色]');
    await fill('十六进制颜色', '#FF1122');
    await click('确定', '.choice-sheet button');
    await b.click('[aria-label="槽位 2"]');
    await click('纯色');
    await b.click('.wrap-palette [aria-label=琥珀黄]');
    await fill('缩放', '20'); await fill('不透明度', '100');
    const centerPixel = () => b.run(`(() => {
      const u = window.appearanceFrame.contentWindow.car.carPaint_CarPaintMaterial.uniforms;
      const canvas = u.haWrapTexture?.value?.image, r = u.haWrapLeftRect?.value;
      if (!canvas || !r?.[2]) return [];
      return [...canvas.getContext('2d').getImageData((r[0]+r[2]/2)*canvas.width,(1-r[1]-r[3]/2)*canvas.height,1,1).data];
    })()`);
    async function waitForPixel(accept, message) {
      const deadline = Date.now() + 6500;
      let pixel;
      do {
        pixel = await centerPixel();
        if (accept(pixel)) return;
        await wait(100);
      } while (Date.now() < deadline);
      assert.fail(message + '，实际像素 ' + pixel.join(','));
    }
    await waitForPixel(([r,g,b,a]) => r === 219 && g === 168 && b === 72 && a === 255, '上层槽位应覆盖其下的渐变');
    await fill('水平移动', '180'); await fill('垂直移动', '-60');
    await waitForPixel(([r,g,b,a]) => r > g && b > g && a > 200 && a < 230, '平移后应露出下层渐变');
    await wait(300);
    const leftAngle = await b.run("window.appearanceFrame.contentWindow.viewer.controls.getAzimuthalAngle()");
    await click('右侧', '.wrap-faces button');
    await wait(300);
    const rightAngle = await b.run("window.appearanceFrame.contentWindow.viewer.controls.getAzimuthalAngle()");
    assert.ok(Math.cos(leftAngle - rightAngle) < -.95, '左右车身预览应朝向相反的两侧');
    assert.equal(await b.run("document.querySelector('.wrap-clear button').disabled"), true);
    await click('车头', '.wrap-faces button');
    assert.equal(await b.run("document.querySelector('.wrap-materials [aria-pressed=true]').innerText.trim()"), '条纹');
    await match(/45°/);
    await click('清除本面');
    await click('完成');
    await click('自定义车衣');
    await click('左侧', '.wrap-faces button');
    assert.equal(await b.run("document.querySelector('.wrap-materials [aria-pressed=true]').innerText.trim()"), '渐变');
    assert.equal(await b.run("document.querySelector('.wrap-palette [aria-pressed=true]').ariaLabel"), '冰川蓝');
    await click('车顶', '.wrap-faces button');
    await click('条纹');
    await click('位置与透明度', 'summary');
    await fill('缩放','180');
    await wait(400);
    assert.ok(await b.run(`(() => {
      const car = window.appearanceFrame.contentWindow.car;
      const top = car.carPaint_CarPaintMaterial.uniforms;
      const roof = car.getObjectByName('body_m_glass_os')?.material.uniforms;
      const frontGlass = car.getObjectByName('body_m_glass')?.material.uniforms;
      return top.haWrapTopSize?.value[1] > 4.7 && roof?.haWrapTopOpacity?.value > 0 && !frontGlass?.haWrapTopOpacity;
    })()`), 'C10 车顶应完整覆盖，前挡风玻璃应保留原材质');
    await click('右侧', '.wrap-faces button');
    const uploadDecal = color => b.run(`(async () => {
      const canvas=document.createElement('canvas');
      canvas.width=8; canvas.height=4;
      canvas.getContext('2d').fillStyle=${JSON.stringify(color)};
      canvas.getContext('2d').fillRect(0,0,4,4);
      const file=new File([await new Promise(resolve=>canvas.toBlob(resolve,'image/png'))], 'decal.png', {type:'image/png'});
      const transfer=new DataTransfer(); transfer.items.add(file);
      const input=document.querySelector('.wrap-upload input'); input.files=transfer.files; input.dispatchEvent(new Event('change',{bubbles:true}));
    })()`);
    await uploadDecal('#215081');
    await match(/碳纤维\s+图片/);
    await b.click('[aria-label="槽位 3"]');
    await uploadDecal('#891fa2');
    await match(/碳纤维\s+图片/);
    await click('预设');
    await fill('预设名称','车顶条纹');
    await click('保存','dialog button');
    await match(/已保存「车顶条纹」/);
    await b.click('dialog[open] [aria-label=关闭]');
    await click('清除全部');
    await b.reload();
    await route('/appearance');
    await match(/本地样例/,23000);
    await click('自定义车衣');
    await click('预设');
    await match(/车顶条纹/);
    await b.click('[aria-label=应用预设车顶条纹]');
    await click('右侧', '.wrap-faces button');
    assert.equal(await b.run("document.querySelector('.wrap-materials [aria-pressed=true]').innerText.trim()"),'图片');
    await b.click('[aria-label="槽位 3"]');
    assert.equal(await b.run("document.querySelector('.wrap-materials [aria-pressed=true]').innerText.trim()"),'图片');
    assert.equal(await b.run("document.querySelector('[aria-label=\"槽位 1\"] i').style.backgroundImage !== document.querySelector('[aria-label=\"槽位 3\"] i').style.backgroundImage"), true);
    await click('车顶', '.wrap-faces button');
    assert.equal(await b.run("document.querySelector('.wrap-slider input[aria-label=缩放]').value"),'180');
    await click('左侧', '.wrap-faces button');
    assert.equal(await b.run("document.querySelector('.wrap-palette [aria-pressed=true]').ariaLabel"), '冰川蓝');
    assert.match(await b.run("document.querySelector('[aria-label=渐变结束色]').textContent"), /#FF1122/);
    await b.click('[aria-label="槽位 2"]');
    assert.deepEqual(await b.run("[...document.querySelectorAll('[aria-label=水平移动],[aria-label=垂直移动]')].map(el => el.value)"), ['180','-60']);
    await click('清除本槽');
    await b.click('[aria-label="槽位 1"]');
    assert.match(await b.run("document.querySelector('[aria-label=渐变结束色]').textContent"), /#FF1122/);
    await b.send('Emulation.setDeviceMetricsOverride',{width:320,height:568,deviceScaleFactor:1,mobile:true});
    assert.ok(await b.run("document.querySelector('.wrap-body').scrollWidth===document.querySelector('.wrap-body').clientWidth && document.querySelector('.wrap-header .btn').getBoundingClientRect().right<=innerWidth"));
    await b.send('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:1,mobile:true});
    await click('预设');
    await b.click('[aria-label=删除预设车顶条纹]');
    await click('确认删除','dialog button');
    await match(/已删除「车顶条纹」/);
    await b.click('dialog[open] [aria-label=关闭]');
    await click('清除全部');
    await click('完成');
  }
  b.on('Fetch.requestPaused', ({ requestId, request }) => {
    const path = new URL(request.url).pathname;
    const payload = path.endsWith('love_car_default_header.txt') ? { carIntroduction: [] } :
      { data: path.endsWith('getByCode') ? { carType: 'demo-b10' } :
        path.endsWith('getVehicleModelSeatListV4') ? { modelList: [{ carModel: 'demo-edition', vehicleYear: 2025, vehicleModel: '测试版', vehicleSpecs: '纯电' }] } :
        path.endsWith('getVehicleProductConfigV4') ? { outColor: [{ color: '测试白', image: 'https://lpmall-dop-prod.oss-cn-hangzhou.aliyuncs.com/test.png' }] } : [] };
    void b.send('Fetch.fulfillRequest', { requestId, responseCode: 200,
      responseHeaders: [{ name: 'Access-Control-Allow-Origin', value: '*' }, { name: 'Content-Type', value: 'application/json' }],
      body: Buffer.from(JSON.stringify(payload)).toString('base64') }).catch(() => {});
  });
  await b.send('Fetch.enable', { patterns: ['ueapp.oss-cn-hangzhou.aliyuncs.com', 'carod-center.leapmotor.cn'].map(host => ({ urlPattern: 'https://' + host + '/*' })) });
  await click('仅 2D'); await b.click('.market-line [aria-label=车型]');
  await click('B10', 'dialog button'); await match(/测试版/);
  await click('查询商城车模'); await match(/测试白/);
  await b.send('Fetch.disable');
  await click('完成');
  await match(/B10 · 2D 车模/);
  await route('/home');
  assert.equal(await b.run("document.querySelector('.home-model')?.dataset.modelStatus"), '2d');
  await route('/energy');
  await b.click('[aria-label="编辑"]');
  await b.click('[aria-label="删除近 6 周能耗排名"]');
  await click('+ 添加卡片');
  await click('近 6 周能耗排名','dialog button');
  await b.click('[aria-label="完成"]');
  await route('/operation-pin');
  await fill('设置操作密码','5566');
  await fill('确认操作密码','5566');
  await click('保存操作密码');
  await match(/已加密保存/);
  await route('/mine');
  await b.click('.settings-page a[href="#/mine/experiments"]');
  const checkIn = '[role=switch][aria-label=自动签到]';
  assert.equal(await b.run(`document.querySelector('${checkIn}').getAttribute('aria-checked')`), 'false');
  await b.click(checkIn);
  await match(/演示 · 今日已签到/);
  await b.reload();
  await match(/演示 · 今日已签到/);
  await b.click(checkIn);
  assert.equal(await b.run(`document.querySelector('${checkIn}').getAttribute('aria-checked')`), 'false');
  await b.click('.appbar [aria-label=返回]');
  await b.click('.settings-page a[href="#/mine/appearance"]');
  await match(/主题色/);
  await click('深色');
  assert.equal(await b.run('document.documentElement.dataset.theme'),'dark');
  assert.ok(await b.run(`(() => {
    const group = document.querySelector('[aria-label="主题"]');
    const [light,dark,system] = group.children;
    return light.offsetWidth === dark.offsetWidth && system.getBoundingClientRect().right <= group.getBoundingClientRect().right &&
      dark.getAttribute('aria-pressed') === 'true' && !['切换账号', '单位与格式'].some(label => document.body.innerText.includes(label));
  })()`));
  await route('/home');
  assert.equal(await b.run('getComputedStyle(document.querySelector(".hero-actions .circ svg")).stroke'),'rgb(139, 201, 236)');
  await route('/mine/appearance');
  await click('紫色');
  const accent = () => b.run('getComputedStyle(document.documentElement).getPropertyValue("--accent").trim()');
  assert.equal(await accent(), '#bc9cfa');
  await route('/home');
  assert.equal(await b.run('getComputedStyle(document.querySelector(".hero-actions .circ svg")).stroke'),'rgb(188, 156, 250)');
  await route('/mine/appearance');
  const systemColor = value => b.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value }] });
  await systemColor('light');
  await click('跟随系统');
  assert.equal(await b.run('document.documentElement.dataset.theme'),'light');
  assert.equal(await accent(), '#6e4bb4');
  await systemColor('dark');
  await wait(180);
  assert.equal(await b.run('document.documentElement.dataset.theme'),'dark');
  await b.reload();
  await match(/主题色/);
  assert.equal(await accent(), '#bc9cfa');
  assert.equal(await b.run('document.querySelector(".theme-swatches [aria-pressed=true]").textContent'),'紫色');
  await click('默认蓝');
  assert.equal(await accent(), '#03a9f4');
  await click('浅色');
  assert.equal(await b.run('document.documentElement.dataset.theme'),'light');
  await systemColor('light');
  await b.click('.appbar [aria-label="返回"]');
  assert.equal(await b.run("[...document.querySelectorAll('.list-card button.list-row')].filter(row => row.textContent === '退出登录').length"), 1);
  await click('退出登录');
  await match(/退出登录？/);
  assert.equal(await b.run("!!document.querySelector('dialog[open] .btn.danger')"), false);
  await click('取消');
  assert.equal(await b.run(`[...document.querySelectorAll('.list-row')].find(row => row.textContent.trim() === '关于 LeapMore')
    ?.nextElementSibling?.textContent.trim()`), '赞赏作者');
  await click('赞赏作者');
  assert.equal(await b.run("document.querySelector('.reward-sheet a[target=_blank]').href"), 'https://afdian.com/a/mirato');
  await b.click('.reward-wechat summary');
  assert.deepEqual(await b.run(`(async () => {
    const image = document.querySelector('.reward-wechat img');
    await image.decode();
    const download = document.querySelector('.reward-download');
    return [image.naturalWidth > 0, download.href === image.src, download.download];
  })()`), [true, true, 'LeapMore-微信赞赏码.png']);
  await b.click('dialog[open] [aria-label=关闭]');
  await click('关于 LeapMore');
  const packageVersion = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
  assert.ok((await b.run('document.querySelector("dialog[open] .sub").textContent')).includes(packageVersion));
  await b.send('Emulation.setDeviceMetricsOverride', { width: 320, height: 700, deviceScaleFactor: 1, mobile: true });
  assert.ok(await b.run(`(() => {
    const links = [...document.querySelectorAll('.about-channels a')];
    return links.length === 3 && links.every(link => link.checkVisibility() && !link.closest('details'));
  })()`));
  const destinations = await b.run(`[...document.querySelectorAll('dialog[open] a')].map(link =>
    ({ href: link.href, label: link.textContent.trim(), button: link.classList.contains('btn'), fits: link.clientWidth >= link.scrollWidth }))`);
  assert.equal(destinations.length, 5);
  assert.equal(new Set(destinations.map(link => link.href)).size, destinations.length);
  assert.ok(destinations.every(link => link.button && link.fits));
  assert.deepEqual(destinations.slice(1).map(link => link.href), [
    'https://github.com/MiRaToo/LeapMore/releases', 'https://gitcode.com/MiraRato/LeapMore/releases',
    'https://pan.quark.cn/s/9e6168a73f21', 'https://leapmore.mirato66.cloud/',
  ]);
  assert.equal(await b.run(`!!document.querySelector('dialog [aria-label="首选更新源"]')`), false);
  await b.run(`const originalFetch = window.fetch;
    window.fetch = (url, options) => String(url).startsWith('https://api.gitcode.com/') ? Promise.resolve(Response.json([])) :
      String(url).startsWith('https://api.github.com/') ? Promise.resolve(Response.json([{
        tag_name:'v0.2.0', html_url:'https://github.com/MiRaToo/LeapMore/releases/tag/v0.2.0',
        assets:[{name:'test.apk',browser_download_url:'https://github.com/MiRaToo/LeapMore/releases/download/v0.2.0/test.apk'}]
      }])) : originalFetch(url, options);`);
  await click('检查更新');
  await match(/下载 v0\.2\.0 · APK/);
  assert.equal(await b.run("document.querySelector('dialog a.btn.accent').href"), 'https://github.com/MiRaToo/LeapMore/releases/download/v0.2.0/test.apk');
  await b.click('dialog[open] .about-license summary');
  assert.doesNotMatch(await b.run("document.querySelector('.about-license').innerText"), /版权所有/);
  assert.match(await b.run("document.querySelector('dialog[open] details[open] .about-license-text').innerText"), /GNU GENERAL PUBLIC LICENSE/);
  assert.equal(b.errors.length, 0, JSON.stringify(b.errors));
  // The iOS build exposes the same Capacitor platform name to the shared UI.
  await b.run("window.Capacitor.getPlatform = () => 'ios'");
  await route('/records-source');
  await click('查看 iPhone 后台记录指南');
  await match(/iPhone 记录方式/);
  assert.equal(await b.run("!!document.querySelector('.background-check')"), false);
  await click('连接 Home Assistant');
  await match(/HA 同步设置/);
  await route('/background-guide');
  await click('选择记录数据源');
  await match(/选择数据源/);
  console.log('控车弹层、空调预设、常用地址导航、路线地图、车型、能源卡片、操作密码、主题和预发布检查通过。');
} finally {
  await b.close();
}
