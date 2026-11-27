import { browser,wait } from './cdp.mjs';
import assert from 'node:assert/strict';
import {writeFile} from 'node:fs/promises';
import { join } from 'node:path';
const url=process.env.LEAPMORE_DEMO_ORIGIN ?? 'http://127.0.0.1:5175/';
const b=await browser('about:blank');
const states=[];
const find=(text,selector='button,a')=>`Array.from(document.querySelectorAll(${JSON.stringify(selector)})).find(e=>e.getClientRects().length&&e.textContent.trim()===${JSON.stringify(text)})`;
const click=async(text,selector)=>{await b.run(`(() => {const e=${find(text,selector)}; if (!e) throw Error('missing '+${JSON.stringify(text)});e.click()})()`);await wait(160);};
async function commandStatus(label) {
 const expression = `window.seenCommandStatus.some(step => step.includes(${JSON.stringify(label)}))`;
 const deadline = Date.now() + 6000;
 while (Date.now() < deadline) {
  if (await b.run(expression)) return;
  await wait(70);
 }
 assert.fail('缺少控车状态 '+label);
}
const page=async(path)=>{await b.run('location.hash='+JSON.stringify(path)); await wait(180); await measure(path);};
const slide=async(selector, maxHeight)=>{
 const box=await b.run(`(() => {const r=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();return {x:r.left+24,y:r.top+r.height/2,height:r.height};})()`);
 if(maxHeight) assert.ok(box.height<=maxHeight, '记录切换控件高度 '+box.height);
 await b.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x:box.x,y:box.y}]});
 await b.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x:box.x+115,y:box.y}]});
 await b.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
 await wait(240);
};
const measure=async(path)=>{
 const m=await b.run(`({width:document.querySelector('.view')?.clientWidth,scroll:document.querySelector('.view')?.scrollWidth,title:document.querySelector('.appbar .title')?.textContent, hash:location.hash})`);
 assert.ok(m.width>=300&&m.scroll<=m.width+1,JSON.stringify({path,m})); states.push([path,m.title??'']);
};
const cardSurfaces = selector => b.run(`Array.from(document.querySelectorAll(${JSON.stringify(selector)}), card => {
  const style = getComputedStyle(card);
  return [style.backgroundColor, style.borderRadius, style.borderWidth, style.boxShadow];
})`);
const surfaceRoutes = {
  '/control': '.sec', '/charging': '.charging-status', '/location': '.location-card',
  '/energy': '.energy-card .card', '/records': '.trip-row', '/mine': '.list-card', '/vehicle-manage': '.vcard:not(.selected)',
};
async function sameSurfaces(expected, selector) {
 const surfaces = await cardSurfaces(selector);
 assert.ok(surfaces.length > 0, selector);
 for (const surface of surfaces) assert.deepEqual(surface, expected, selector);
}
try{
 await b.send('Storage.clearDataForOrigin', { origin: new URL(url).origin, storageTypes: 'local_storage,indexeddb' });
 await b.navigate(url);
 await b.send('Page.bringToFront');
 await wait(800);
 assert.match(await b.run('document.body.innerText'),/欢迎使用 LeapMore/);
 await click('我知道了');
 await click('使用演示账号');
 await click('进入车辆');
 assert.match(await b.run('document.body.innerText'),/我的 C10/);
 assert.deepEqual(await b.run(`Array.from(document.querySelectorAll('.tabbar .tab'), button =>
   [button.textContent, button.getAttribute('aria-label'), !!button.querySelector('svg'), button.offsetHeight >= 44])`),
 [['', '车辆', true, true], ['', '记录', true, true], ['', '统计', true, true], ['', '我的', true, true]]);
 assert.deepEqual(await b.run(`Array.from(document.querySelectorAll('.home-entries .entry'), card => card.textContent)`),
 ['充电', '胎压', '控制', '外观']);
 assert.equal(await b.run(`new Set(Array.from(document.querySelectorAll('.home-entries .entry'), card => {
   const style = getComputedStyle(card);
   return [card.offsetHeight, style.borderWidth, style.borderRadius, style.backgroundColor, style.boxShadow].join(',');
 })).size`),1);
 const shot=async(name)=>{if (!process.env.LEAPMORE_SCREENSHOT_DIR) return; const s=await b.send('Page.captureScreenshot',{format:'png',fromSurface:true});await writeFile(join(process.env.LEAPMORE_SCREENSHOT_DIR,'leapmore-'+name+'.png'), Buffer.from(s.data,'base64'));};
 await shot('home-320');
 assert.ok((await cardSurfaces('.home-cards > .grid2 > .card, .home-entries > .entry')).every(surface => surface[1] === '12px'));
 await page('/records-source');
 const [lightSurface] = await cardSurfaces('.sec');
 await b.click('.source-opt:first-of-type');
 for(const path of ['/home','/control','/climate','/charging','/location','/appearance','/energy','/records','/trips/demo-trip-0','/charges/demo-charge-0','/records-source','/background-guide','/ha','/ha-mapping','/mine','/mine/appearance','/vehicle-manage','/operation-pin','/amap','/vehicle-access','/states','/widgets','/driving-lock','/subaccount']) {
   await page(path);
   if (surfaceRoutes[path]) await sameSurfaces(lightSurface, surfaceRoutes[path]);
 }
 await page('/mine/appearance'); await click('深色'); await page('/records-source');
 const [darkSurface] = await cardSurfaces('.sec');
 for (const [path, selector] of Object.entries(surfaceRoutes)) { await page(path); await sameSurfaces(darkSurface, selector); }
 await page('/mine/appearance'); await click('浅色');
 await page('/location');
 assert.equal(await b.run('document.querySelector(".location-map").getBoundingClientRect().height'),300);
 assert.equal(await b.run('document.querySelector(".appbar .title").textContent'),'车辆位置');
 const navigationWidths = await b.run('Array.from(document.querySelectorAll(".loc-actions .btn"), el => el.getBoundingClientRect().width)');
 assert.equal(navigationWidths[0],navigationWidths[1]);
 assert.equal(await b.run('document.querySelector(".amap-style").textContent.trim()'),'跟随');
 for (const label of ['日间', '卫星', '深色', '跟随']) {
   await b.click('[aria-label="切换底图"]'); await wait(80);
   assert.equal(await b.run('document.querySelector(".amap-style").textContent.trim()'),label);
 }
 const mapIsDark = () => b.run('document.querySelector(".location-map .amap-view").classList.contains("is-dark")');
 const waitMapTheme = async dark => {
   for (let attempt = 0; attempt < 30 && await mapIsDark() !== dark; attempt++) await wait(100);
   assert.equal(await mapIsDark(),dark);
 };
 await b.send('Emulation.setEmulatedMedia',{features:[{name:'prefers-color-scheme',value:'dark'}]});
 await waitMapTheme(true);
 assert.equal(await b.run('document.documentElement.dataset.theme'),'light');
 await b.send('Emulation.setEmulatedMedia',{features:[{name:'prefers-color-scheme',value:'light'}]});
 await waitMapTheme(false);
 await b.send('Emulation.setEmulatedMedia',{features:[]});
 await page('/records');
 assert.deepEqual(await b.run('[...document.querySelectorAll(".records-actions button,.records-actions a")].map(el=>el.ariaLabel)'),
   ['行程时间范围，本月','行程显示','记录设置']);
 assert.ok(await b.run('document.querySelector(".appbar .record-tabs") && [...document.querySelectorAll(".records-actions .icon-action")].every(el=>!el.textContent.trim())'));
 assert.doesNotMatch(await b.run('document.body.innerText'),/记录说明/);
 await page('/charging');
 await b.click('[aria-label="预约充电"]');
 await b.click('[aria-label="充电重复日期"] [aria-label="周一"]');
 assert.equal(await b.run('!!document.querySelector("dialog[open]")'),false);
 await click('保存预约'); assert.match(await b.run('document.querySelector("dialog[open]").innerText'),/22:00–06:00/);
 await click('确认发送'); await wait(3100);
 await page('/home'); assert.ok(await b.run('!!document.querySelector(".entry[data-scheduled]")'));
 await page('/charging');
 assert.equal(await b.run('document.querySelector(\'[aria-label="充电重复日期"] [aria-label="周一"]\').getAttribute("aria-pressed")'),'false');
 await b.click('[aria-label="预约充电"]'); await click('保存预约'); await click('确认发送'); await wait(3100);
 await b.click('[aria-label="电池预热预约"]'); await wait(120);
 assert.match(await b.run('document.querySelector(".schedule-readonly").innerText'),/结束时间[\s\S]*车辆自动结束/);
 await b.click('[aria-label="周一"]'); await b.click('[aria-label="周三"]');
 await click('保存预热预约'); assert.match(await b.run('document.querySelector("dialog[open]").innerText'),/07:00 · 周一、周三/);
 await click('确认发送');
 await wait(2400); assert.match(await b.run('document.querySelector(".cmd-status")?.textContent ?? ""'),/云端预热预约已更新/);
 await wait(900);
 await page('/home'); assert.ok(await b.run('!!document.querySelector(".entry[data-scheduled]")'));
 await page('/charging');
 assert.equal(await b.run('document.querySelector(\'[aria-label="电池预热预约"]\').getAttribute("aria-checked")'),'true');
 assert.deepEqual(await b.run('[...document.querySelectorAll(".preheat-week [aria-pressed=true]")].map(el=>el.getAttribute("aria-label"))'),['周一','周三']);
 await b.click('[aria-label="电池预热预约"]'); await click('保存预热预约'); assert.match(await b.run('document.querySelector("dialog[open]").innerText'),/关闭电池预热预约/);
 await click('确认发送'); await wait(3100);
 assert.equal(await b.run('document.querySelector(\'[aria-label="电池预热预约"]\').getAttribute("aria-checked")'),'false');
 await page('/home');
 assert.equal(await b.run('!!document.querySelector(".entry[data-scheduled]")'),false);
 await page('/mine');
 await b.click('[aria-label="编辑个人资料"]');
 await b.run(`(async () => {
   const input = document.querySelector('[aria-label="昵称"]');
   Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,'测试昵称');
   input.dispatchEvent(new Event('input',{bubbles:true}));
   const canvas = document.createElement('canvas'); canvas.width=canvas.height=16;
   const data = new DataTransfer();
   data.items.add(new File([await new Promise(resolve=>canvas.toBlob(resolve))],'avatar.png',{type:'image/png'}));
   const photo = document.querySelector('dialog input[type=file]'); photo.files=data.files;
   photo.dispatchEvent(new Event('change',{bubbles:true}));
 })()`); await wait(200);
 await click('保存资料'); await page('/home'); await page('/mine');
 assert.equal(await b.run('document.querySelector(".profile-name b").textContent'),'测试昵称');
 assert.ok(await b.run('document.querySelector(".profile .avatar img")?.src.startsWith("data:image/jpeg")'));
 await page('/home');
 await b.click('[aria-label="空调预设"]');
 await wait(220);
 assert.ok(Math.abs(await b.run(`(() => {
   const bubble = document.querySelector('.preset-bubble'), opener = document.querySelector('[aria-label="空调预设"]');
   const rect = opener.getBoundingClientRect();
   return bubble.getBoundingClientRect().left + parseFloat(getComputedStyle(bubble, '::after').left) - (rect.left + rect.width / 2);
 })()`)) < 2);
 await b.click('[aria-label="座椅与加热"]');
 assert.equal(await b.run('!!document.querySelector(".preset-bubble")'),false);
 assert.ok(await b.run(`Array.from(document.querySelectorAll('.seat-option .seg')).every(el => {
   const label=el.previousElementSibling, r=label.getBoundingClientRect();
   return r.height <= parseFloat(getComputedStyle(label).lineHeight) + 1 && r.right + 4 <= el.getBoundingClientRect().left;
 })`));
 await b.click('dialog[open] [aria-label="关闭"]');
 await page('/widgets'); assert.ok(await b.run(`${find('寻车')}.getAttribute('aria-label') === '鸣笛寻车'`));
 assert.equal(await b.run("document.querySelectorAll('.widget-medium .widget-stat').length"), 2);
 assert.ok(await b.run("!!document.querySelector('.widget-brand-status .widget-charge-state')"));
 await click('小 · 2×2'); assert.equal(await b.run(`!!${find('寻车')}`),false);
 await click('大 · 4×4'); assert.equal(await b.run(`!!${find('寻车')}`),true); await shot('widget-320');

 async function openDemoSettings() {
   await page('/mine');
   if (!await b.run('!!document.querySelector(".demo-settings-sheet")')) await click('演示情景');
 }
 const grantSelectors=['.debug-grants label:nth-of-type(2) input','.debug-grants label:nth-of-type(3) input','.debug-grants label:nth-of-type(4) input'];
 for(let mask=0;mask<8;mask++) {
  await openDemoSettings();
  for(let i=0;i<3;i++) {
   const s=grantSelectors[i], wanted=!!(mask & (1<<i));
   const checked=await b.run('document.querySelector('+JSON.stringify(s)+').checked');
   if(checked!==wanted) await b.click(s);
  }
  await page('/home');
  assert.equal(await b.run('document.querySelector(".hero-actions [aria-label=解锁车门]").disabled'),false);
  assert.equal(await b.run('document.querySelector(".hero-actions [aria-label=车窗]").disabled'),!(mask&1));
  assert.equal(await b.run('document.body.innerText.includes("车辆定位未授权")'),!(mask&2));
  await page('/energy');
  assert.equal(await b.run('document.body.innerText.includes("里程能耗未授权")'),!(mask&4));
  if (mask === 4 || mask === 6) {
    for (const path of ['/records?tab=charges', '/charges/demo-charge-0']) {
      await page(path);
      assert.equal(await b.run('!!document.querySelector(".charge-place")'), !!(mask & 2));
      if (path.startsWith('/charges/')) assert.equal(await b.run('!!document.querySelector(".amap-record")'), !!(mask & 2));
    }
  }
 }
 await openDemoSettings(); await b.run("Array.from(document.querySelectorAll('.debug-grants input:not(:disabled)')).forEach(x=>x.click())"); await page('/home');
 assert.equal(await b.run('document.querySelector(".hero-actions [aria-label=解锁车门]").disabled'),false);
 assert.equal(await b.run('document.querySelector(".hero-actions [aria-label=车窗]").disabled'),true);
 assert.match(await b.run('document.body.innerText'),/车辆定位未授权/);
 await b.run(`(() => {
   window.seenCommandStatus = [];
   const observer = new MutationObserver(() => {
     const label = document.querySelector('.cmd-status')?.textContent;
     if (label && window.seenCommandStatus.at(-1) !== label) window.seenCommandStatus.push(label);
   });
   observer.observe(document.getElementById('root'), { childList: true, characterData: true, subtree: true });
 })()`);
 const lockAppearance = () => b.run(`(() => {
   const button = document.querySelector('.hero-actions .circ'), label = button.nextElementSibling;
   const style = getComputedStyle(button), dot = getComputedStyle(label, '::after');
   return [style.color, style.backgroundColor, dot.content !== 'none'];
 })()`);
 const closedLock = await lockAppearance();
 assert.equal(closedLock[2],false);
 await b.click('.hero-actions [aria-label=解锁车门]'); await click('确认发送');
 await commandStatus('已受理');
 await commandStatus('车端已确认');
 await wait(1000); assert.equal(await b.run('!!document.querySelector("dialog[open]")'),false);
 assert.equal(await b.run('document.querySelector(".hero-actions [aria-label=上锁车门]").disabled'),false);
 assert.deepEqual(await lockAppearance(),[...closedLock.slice(0,2), true]);
 await page('/energy'); assert.match(await b.run('document.body.innerText'),/里程能耗未授权/);
 await openDemoSettings();
 await b.click('[aria-label=模拟行驶]'); await page('/home'); assert.match(await b.run('document.body.innerText'),/停车挂 P/);
 assert.equal(await b.run('document.querySelector(".hero-actions [aria-label=上锁车门]").disabled'),true);
 await openDemoSettings(); await b.click('[aria-label=模拟行驶]');
 await b.click('[aria-label=数据状态]'); await b.click('dialog[open] [data-value=pending]');
 await page('/home');await b.click('.hero-actions [aria-label=上锁车门]');await click('确认发送');
 await commandStatus('车辆未确认');await click('关闭');
 await openDemoSettings();
 await b.click('[aria-label=数据状态]'); await b.click('dialog[open] [data-value=normal]');
 await openDemoSettings(); await b.run("Array.from(document.querySelectorAll('.debug-grants input:not(:disabled)')).forEach(x=>x.click())");
 await page('/energy'); let rect=await b.run('(()=>{const r=document.querySelector(".energy-plot").getBoundingClientRect();return {x:r.left+30,y:r.top+50,width:r.width}})()');
 await b.send('Input.dispatchMouseEvent',{type:'mousePressed',x:rect.x,y:rect.y,button:'left',buttons:1,clickCount:1});
 await b.send('Input.dispatchMouseEvent',{type:'mouseMoved',x:rect.x+rect.width/2,y:rect.y,button:'left',buttons:1});
 await b.send('Input.dispatchMouseEvent',{type:'mouseReleased',x:rect.x+rect.width/2,y:rect.y,button:'left',clickCount:1});
 assert.equal(await b.run('document.querySelector(".energy-plot").classList.contains("show-guide")'),true);
 const reading=await b.run('document.querySelector("#energy-day-reading").textContent');
 const outside=await b.run('(()=>{const r=document.querySelector(".trend-card h3").getBoundingClientRect();return {x:r.left+20,y:r.top+r.height/2};})()');
 await b.send('Input.dispatchMouseEvent',{type:'mousePressed',...outside,button:'left',buttons:1,clickCount:1});
 await b.send('Input.dispatchMouseEvent',{type:'mouseReleased',...outside,button:'left',clickCount:1});
 assert.equal(await b.run('document.querySelector(".energy-plot").classList.contains("show-guide")'),false);
 assert.equal(await b.run('document.querySelector("#energy-day-reading").textContent'),reading);
 await click('月'); await click('耗电'); await click('折线');
 assert.match(await b.run('document.querySelector("#energy-day-reading").textContent'),/kWh/); await shot('energy-320');
 await page('/home');
 await slide('[aria-label="主导航"]');
 assert.match(await b.run('location.hash'), /^#\/records/);
 await slide('[aria-label="记录类型"]', 42);
 assert.match(await b.run('location.hash'), /tab=charges/);
 assert.ok(await b.run(`(() => {
   const summary = document.querySelector('.trip-sum'), record = summary.nextElementSibling;
   return record.getBoundingClientRect().top - summary.getBoundingClientRect().bottom >= 10;
 })()`));
 await page('/records-source');
 await b.run("[...document.querySelectorAll('button.row')].find(e=>e.innerText.startsWith('电价设置')).click()");
 for (let i=0; i<30 && !await b.run("!!document.querySelector('dialog[open] .tariff-sheet')"); i++) await wait(80);
 assert.match(await b.run('document.querySelector(".tariff-sheet").innerText'),/直流快充/);
 assert.ok(await b.run(`(() => {
   const sheet = document.querySelector('.tariff-sheet'), edge = sheet.getBoundingClientRect().right;
   return Array.from(sheet.querySelectorAll('input')).every(input => input.getBoundingClientRect().right <= edge - 10);
 })()`));
 await click('取消'); await page('/records-source');
 await b.run("[...document.querySelectorAll('button.row')].find(e=>e.innerText.startsWith('清理本地记录')).click()");
 assert.ok(!(await b.run('document.body.innerText')).includes('建议每辆车选择一个记录来源'));
 assert.equal(await b.run(`${find('清除记录')}.disabled`),true);
 assert.equal(b.errors.length,0,JSON.stringify(b.errors));
 console.log(JSON.stringify({states, command:'accepted/confirmed/dismiss',grants:'all 8 combinations',chart:'horizontal/outside retains reading',swipe:'bottom navigation and record tabs',widgets:'2×2/4×2/4×4',errors:b.errors}));
} catch(error){console.error(error.message); console.error(await b.run('document.body.innerText.slice(0,1400)')); console.error(b.errors); process.exitCode=1;}
finally{await b.close();}
