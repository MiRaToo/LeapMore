import { browser, wait } from './cdp.mjs';
import assert from 'node:assert/strict';

const app = process.env.LEAPMORE_DEMO_ORIGIN ?? 'http://127.0.0.1:5175/';
const b = await browser('about:blank', 390, 844);
const route = async path => { await b.run('location.hash=' + JSON.stringify(path)); await wait(200); };
const touch = (type, point) => b.send('Input.dispatchTouchEvent', { type, touchPoints: point ? [point] : [] });
async function swipe(from, to, beforeEnd) {
  await touch('touchStart', from);
  for (const fraction of [.25, .5, .75, 1]) {
    await touch('touchMove', { x: from.x + (to.x - from.x) * fraction, y: from.y + (to.y - from.y) * fraction });
    await wait(25);
  }
  if (beforeEnd) await beforeEnd();
  await touch('touchEnd');
}

try {
  await b.send('Storage.clearDataForOrigin', { origin: new URL(app).origin, storageTypes: 'local_storage,indexeddb' });
  await b.navigate(app);
  for (let i = 0; i < 50 && !await b.run('!!document.querySelector(".app-view")'); i++) await wait(100);
  await b.run(`localStorage.setItem('leapmore.mode', '"demo"'); localStorage.setItem('leapmore.activeVehicle', '"demo-c10"');`);
  await b.reload();
  await route('/records-source');
  assert.equal(await b.run("document.querySelector('.source-opt.on b')?.textContent"), '关闭记录');
  await b.click('.source-opt:first-of-type');
  await route('/energy');
  for (let i = 0; i < 50 && !await b.run('!!document.querySelector("[data-energy-card]")'); i++) await wait(100);
  assert.deepEqual(await b.run('[...document.querySelectorAll("[data-energy-card]")].map(card => card.dataset.energyCard)'),
    ['monthKm','weekKm','efficiency','rank','trend','totalDays','totalKm','totalKwh','breakdown','cost']);
  assert.equal(await b.run('document.querySelectorAll(".compact-metric .metric-label > svg").length'), 6);
  await b.run(`localStorage.setItem('leapmore.energyCards', JSON.stringify({'demo-c10':['stats','rank','trend','breakdown']}))`);
  await b.reload();
  await route('/energy');
  assert.equal(await b.run("JSON.parse(localStorage.getItem('leapmore.theme'))"), 'system');
  assert.equal(await b.run("JSON.parse(localStorage.getItem('leapmore.source'))"), 'phone');
  assert.ok(await b.run(`(() => {
    const series = document.querySelector('.trend-card .plot-series');
    return series && getComputedStyle(series).animationName === 'plot-reveal';
  })()`));
  await b.click('[aria-label="编辑"]');
  const order = () => b.run('[...document.querySelectorAll(".energy-card")].map(card => card.dataset.energyCard)');
  const beforeOrder = await order();
  assert.deepEqual(beforeOrder, ['weekKm', 'efficiency', 'rank', 'totalDays', 'totalKm', 'totalKwh', 'monthKm', 'trend', 'breakdown', 'cost']);
  assert.ok(await b.run(`(() => {
    const grid = document.querySelector('.energy-grid');
    const gap = parseFloat(getComputedStyle(grid).columnGap);
    const tiles = [...grid.children].slice(0,3).map(el => el.getBoundingClientRect());
    return tiles.every(tile => tile.top === tiles[0].top && Math.abs(3 * tile.width + 2 * gap - grid.clientWidth) < 1);
  })()`));
  const cardPoint = key => b.run(`(() => {
    const rect = document.querySelector('[data-energy-card="${key}"]').getBoundingClientRect();
    return { x: rect.left + 36, y: rect.top + 46 };
  })()`);
  const rankPoint = await cardPoint('rank');
  await swipe(rankPoint, { x:rankPoint.x, y:rankPoint.y - 140 });
  await wait(120);
  assert.ok(await b.run('document.querySelector(".app-view").scrollTop > 50'));
  assert.deepEqual(await order(), beforeOrder);
  await b.run('document.querySelector(".app-view").scrollTop=0');
  const fromCard = await cardPoint('weekKm'), toCard = await cardPoint('rank');
  await touch('touchStart', fromCard);
  await wait(280);
  assert.ok(await b.run('!!document.querySelector("[data-energy-card=weekKm][data-dragging]")'));
  await touch('touchMove', toCard);
  await touch('touchEnd');
  assert.deepEqual((await order()).slice(0, 3), ['efficiency', 'rank', 'weekKm']);
  await b.run(`document.querySelector('[data-energy-card=cost] h3').scrollIntoView({block:'center'})`);
  const costPoint = await b.run(`(() => {
    const r = document.querySelector('[data-energy-card=cost] h3').getBoundingClientRect();
    return {x:r.left + 12, y:r.top + r.height / 2};
  })()`);
  await touch('touchStart', costPoint);
  await wait(280);
  assert.ok(await b.run('!!document.querySelector("[data-energy-card=cost][data-dragging]")'));
  const aboveCost = await b.run(`(() => {
    const r = document.querySelector('[data-energy-card=breakdown]').getBoundingClientRect();
    return {x:r.left + 25, y:r.bottom - 10};
  })()`);
  await touch('touchMove', aboveCost);
  await touch('touchEnd');
  assert.equal((await order()).at(-2), 'cost');
  await b.click('[aria-label="完成"]');
  await b.reload();
  await wait(250);
  assert.equal((await order()).at(-2), 'cost');
  await b.click('[aria-label="编辑"]');
  await b.click('[aria-label="删除充电费用估算"]');
  await b.reload();
  await wait(250);
  assert.ok(!(await order()).includes('cost'));
  await route('/records?tab=cost');
  assert.ok(await b.run('!!document.querySelector("dialog[open] #expense-statistics")'));
  await b.click('dialog[open] [aria-label=关闭]');
  assert.ok(!(await order()).includes('cost'));
  await b.click('[aria-label="编辑"]');
  await b.run(`[...document.querySelectorAll('.energy-page button')].find(b=>b.textContent==='+ 添加卡片').click()`);
  await b.run(`[...document.querySelectorAll('dialog[open] button')].find(b=>b.textContent==='充电费用估算').click()`);
  assert.equal((await order()).at(-1), 'cost');
  await b.click('[aria-label="完成"]');
  await b.click('[aria-label="时间范围"] button:nth-child(2)');
  await b.click('[aria-label="图表类型"] button:nth-child(2)');
  await b.click('[aria-label="趋势指标"] button:nth-child(2)');
  await b.click('[aria-label="费用统计范围"] button:nth-child(3)');
  await b.run(`document.querySelector('.trend-card .energy-plot').dispatchEvent(new KeyboardEvent('keydown', {key:'ArrowLeft',bubbles:true}));
    document.querySelector('.app-view').scrollTop=220;`);
  await wait(50);
  const energyView = () => b.run(`({
    options: [...document.querySelectorAll('.energy-screen [aria-pressed="true"]')].map(option => option.textContent.trim()),
    top: document.querySelector('.app-view').scrollTop,
    reading: document.querySelector('#energy-day-reading').textContent
  })`);
  const energyBefore = await energyView();
  assert.deepEqual(energyBefore.options, ['月', '折线', '耗电', '90 天']);
  assert.ok(energyBefore.top > 0);
  await route('/home');
  assert.equal(await b.run("document.querySelector('.energy-screen').hidden"), true);
  await route('/energy');
  assert.deepEqual(await energyView(), energyBefore);
  assert.equal(await b.run("getComputedStyle(document.querySelector('.trend-card .plot-series')).animationName"), 'none');
  await route('/home');
  assert.ok(await b.run(`(() => {
    const color = selector => getComputedStyle(document.querySelector(selector)).color;
    return color('.temp-target') === color('.temp-label') && color('.temp-main') !== color('.temp-target');
  })()`));
  await route('/climate');
  assert.ok(await b.run(`(() => {
    const target = getComputedStyle(document.querySelector('.climate-target'));
    const cabin = getComputedStyle(document.querySelector('.climate-status b'));
    return target.color === getComputedStyle(document.querySelector('.climate-stepper .muted')).color &&
      cabin.color !== target.color && parseFloat(cabin.fontSize) > parseFloat(target.fontSize);
  })()`));
  await route('/records');
  assert.equal(await b.run("document.querySelector('[aria-label=行程显示]').title"),'缩略图');
  const period = async (kind, text) => {
    await b.click('.record-range-toggle');
    await b.run(`[...document.querySelectorAll('[aria-label=${kind}时间范围] button')].find(el=>el.textContent===${JSON.stringify(text)}).click()`);
  };
  assert.equal(await b.run("document.querySelector('.records-actions .record-range-toggle').getAttribute('aria-expanded')"),'false');
  await b.click('#record-tab-1');
  assert.ok(await b.run(`(() => {
    const charge = document.querySelector('#record-tab-1'), trip = document.querySelector('#record-tab-0');
    return charge.getAttribute('aria-selected') === 'true' && parseFloat(getComputedStyle(charge).fontSize) > parseFloat(getComputedStyle(trip).fontSize) &&
      location.hash.includes('tab=charges') && !!document.querySelector('.records-actions [aria-label="充电显示"]');
  })()`));
  await b.run("document.querySelector('#record-tab-1').dispatchEvent(new KeyboardEvent('keydown',{key:'Home',bubbles:true}))");
  assert.equal(await b.run("document.activeElement.id"),'record-tab-0');
  await b.click('.record-range-toggle');
  assert.deepEqual(await b.run("[...document.querySelectorAll('[aria-label=行程时间范围] button')].map(button=>button.textContent)"), ['最近','本周','本月','全部']);
  await b.click('.record-range-toggle');
  await period('行程','最近');
  assert.ok(await b.run("!!document.querySelector('.record-meta time') && !document.querySelector('.record-panel h2')"));
  assert.equal(await b.run("document.querySelectorAll('.amap-trip .amap-route').length"),1);
  assert.equal(await b.run("document.querySelectorAll('.sample-soc-path').length"),1);
  assert.equal(await b.run("document.querySelectorAll('.trip-row,.amap-bar').length"),0);
  assert.equal(await b.run("document.querySelector('.range-menu')"),null);
  assert.ok(await b.run("!!document.querySelector('.sample-curves .sample-temp-path') && !document.querySelector('.sample-card h3 svg')"));
  await b.run("document.querySelector('.sample-timeline').dispatchEvent(new KeyboardEvent('keydown',{key:'Home',bubbles:true}))");
  assert.equal(await b.run("document.querySelector('.sample-readout dl > div:nth-child(4) dd').textContent"), '15.5 °C');
  assert.equal(await b.run("document.querySelectorAll('.sample-lane .chart-svg').length"), 3);
  assert.ok(await b.run("document.querySelector('.trip-info').lastElementChild.matches('.trip-metrics-handle') && !document.querySelector('.trip-metrics-handle svg')"));
  const handle = await b.run(`(() => {
    const button = document.querySelector('.trip-metrics-handle');
    button.scrollIntoView({block:'center'});
    const rect = button.getBoundingClientRect();
    return {x:rect.left + rect.width / 2,y:rect.top + rect.height / 2};
  })()`);
  await swipe(handle, {x:handle.x,y:handle.y+55});
  assert.equal(await b.run("document.querySelector('.trip-metrics-handle').getAttribute('aria-expanded')"),'true');
  const rows = () => b.run("Number(document.querySelector('.trip-metrics-extra').dataset.rows)");
  assert.equal(await rows(),1);
  assert.match(await b.run("document.querySelector('.trip-metrics-row[aria-hidden=false]').textContent"),/起始表显续航.*结束表显续航.*续航达成率/);
  assert.ok(await b.run("document.querySelector('.trip-info > dl').nextElementSibling.matches('.trip-metrics-extra')"));
  await b.click('.trip-metrics-handle');
  assert.equal(await rows(),2);
  assert.match(await b.run("document.querySelector('.trip-metrics-row:last-child').textContent"),/最高速度.*0 速时长/);
  await b.click('[aria-label=地图设置]');
  await b.run(`(() => { const input=document.querySelector('.amap-opacity input');
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,'52');
    input.dispatchEvent(new Event('input',{bubbles:true}));
  })()`);
  assert.equal(await b.run("document.querySelector('.amap-opacity output').textContent"),'52%');
  await route('/trips/demo-trip-1');
  assert.equal(await b.run("document.querySelector('.trip-metrics-handle').getAttribute('aria-expanded')"),'true');
  assert.equal(await b.run("document.querySelector('.amap-trip').style.getPropertyValue('--map-control-opacity')"),'0.52');
  for (const path of ['/records?tab=charges','/charges/demo-charge-0']) {
    await route(path);
    assert.ok(await b.run("document.querySelector('.charge-info').firstElementChild.matches('dl') && !document.querySelector('.charge-info .pill')"));
    assert.ok(await b.run(`(() => {
      const map = document.querySelector('.record-detail-content .amap-record');
      return map?.style.getPropertyValue('--map-control-opacity') === '0.52' &&
        !!map.querySelector('[aria-label=充电位置]') && !map.querySelector('.amap-bar,.amap-route,.amap-tools-panel') &&
        map.querySelectorAll('.amap-ctl > button').length === 2;
    })()`));
    await b.click('[aria-label=地图设置]');
    assert.equal(await b.run("document.querySelector('.amap-opacity output').textContent"),'52%');
    await b.click('[aria-label=放大]');
    assert.equal(await b.run("document.querySelector('.amap-record').dataset.mapZoom"),'17.000');
    await b.click('[aria-label=回到充电位置]');
    assert.equal(await b.run("document.querySelector('.amap-record').dataset.mapZoom"),'16.000');
  }
  await route('/mine');
  await b.run("[...document.querySelectorAll('button')].find(button=>button.textContent.trim()==='演示情景').click()");
  await b.click('[aria-label=模拟行驶]');
  await route('/records');
  assert.match(await b.run("document.querySelector('.record-meta-status').textContent"),/正在记录行程/);
  assert.match(await b.run("document.querySelector('.record-detail-content').textContent"),/实时车速48 km\/h/);
  await route('/mine');
  await b.run("[...document.querySelectorAll('button')].find(button=>button.textContent.trim()==='演示情景').click()");
  await b.click('[aria-label=模拟行驶]');
  await b.click('[aria-label=充电情景]');
  await b.click('dialog[open] [data-value=charging]');
  await route('/records?tab=charges');
  assert.match(await b.run("document.querySelector('.record-meta-status').textContent"),/正在记录充电/);
  assert.equal(await b.run("document.querySelectorAll('.record-detail-content .amap-view').length"),1);
  assert.equal(await b.run("document.querySelectorAll('.record-detail-content .sample-timeline').length"),1);
  assert.ok(await b.run("document.querySelectorAll('.charge-info').length === 1 && document.querySelectorAll('.record-detail-content .trip-info').length === 1 && !!document.querySelector('.charge-info .charge-place-detail')"));
  assert.equal(await b.run("document.querySelectorAll('.sample-lane .chart-svg').length"),3);
  await route('/records');
  await period('行程','全部');
  await wait(100);
  assert.match(await b.run("document.querySelector('.record-total').textContent"), /^6 段/);
  assert.ok(await b.run(`(() => {
    const months = [...document.querySelectorAll('.record-month')];
    const titles = months.map(el => el.querySelector('.month-title').textContent);
    return months.length > 1 && months.every(el => el.querySelector('button').getAttribute('aria-expanded') === 'false') && new Set(titles).size === months.length &&
      months.reduce((n, el) => n + parseInt(el.querySelector('button > span').textContent), 0) === 6 &&
      !document.querySelector('.record-day');
  })()`));
  await b.click('.record-month > button');
  await b.click('.record-month .record-day > summary');
  assert.ok(await b.run("!!document.querySelector('.record-month .record-day[open] a[href*=trips]')"));
  await swipe({x:270,y:243},{x:80,y:243});
  await wait(150);
  assert.equal(await b.run("document.querySelector('.record-range-toggle').textContent"),'全部');
  await b.click('.record-month > button');
  assert.ok(await b.run(`(() => {
    const month = document.querySelector('.record-month');
    const links = [...month.querySelectorAll('a[href*="/charges/"]')];
    return links.length === parseInt(month.querySelector('button > span').textContent) &&
      links.every(link => link.checkVisibility() && link.querySelector('.charge-thumbnail')) && !month.querySelector('.record-day summary');
  })()`));
  await period('充电','全部');
  await wait(100);
  assert.match(await b.run("document.querySelector('.record-total').textContent"), /^5 次/);
  for (const range of ['本周', '本月']) {
    await period('充电', range);
    await wait(100);
    assert.ok(await b.run(`(() => {
      const links = [...document.querySelectorAll('.record-day a[href*="/charges/"]')];
      return links.length > 0 && links.length === parseInt(document.querySelector('.record-total').textContent) &&
        links.every(link => link.checkVisibility()) && !document.querySelector('.record-month, .record-day summary');
    })()`));
  }
  await swipe({x:80,y:250},{x:270,y:250});
  await wait(150);
  for (const range of ['本周', '本月']) {
    await period('行程', range);
    await wait(100);
    assert.ok(await b.run(`(() => {
      const days = [...document.querySelectorAll('.record-day')];
      return days[0]?.open && days.slice(1).every(day => !day.open) && days[0].querySelector('a[href*=trips]').checkVisibility();
    })()`));
    await b.click('.record-day summary');
    assert.equal(await b.run("document.querySelector('.record-day').open"), false);
  }
  assert.equal(await b.run("document.querySelectorAll('.record-month').length"), 0);
  const daySummary = await b.run(`(() => {
    const summary = document.querySelector('.record-day summary');
    summary.dispatchEvent(new MouseEvent('click',{bubbles:true,cancelable:true,detail:1}));
    return summary.parentElement.querySelector('.record-day-items').getAnimations().length;
  })()`);
  assert.equal(daySummary, 1);
  await wait(250);
  assert.ok(await b.run('document.querySelector(".record-day").open'));
  await b.run(`document.querySelector('.record-day summary').dispatchEvent(new MouseEvent('click',{bubbles:true,cancelable:true,detail:1}))`);
  await wait(250);
  assert.equal(await b.run('document.querySelector(".record-day").open'), false);
  await b.send('Emulation.setDeviceMetricsOverride',{width:390,height:420,deviceScaleFactor:1,mobile:true});
  const headingTop = () => b.run('document.querySelector(".appbar, .hero-top").getBoundingClientRect().top');
  const recordsHeading = await headingTop();
  await b.run("document.querySelectorAll('.record-day').forEach(day => day.open = true)");
  const viewport = '.app-view';
  const navVisible = () => b.run('!document.querySelector(".tabbar").classList.contains("nav-concealed")');
  await b.run(`document.querySelector('${viewport}').scrollTop=130`);
  await wait(100);
  assert.equal(await navVisible(), false);
  assert.equal(await headingTop(), recordsHeading);
  await b.run(`document.querySelector('${viewport}').scrollTop=45`);
  await wait(100);
  assert.equal(await navVisible(), true);
  await b.run(`document.querySelector('${viewport}').scrollTop=0`);
  await swipe({ x:175, y:205 }, { x:175, y:288 }, async () => {
    assert.match(await b.run("getComputedStyle(document.querySelector('.app-scroll-content > .page')).translate"), /^0px [1-9]/);
    assert.equal(await headingTop(), recordsHeading);
  });
  await wait(280);
  assert.equal(await b.run("getComputedStyle(document.querySelector('.app-scroll-content > .page')).translate"), 'none');
  await b.run(`const view = document.querySelector('${viewport}'); view.scrollTop=view.scrollHeight`);
  await swipe({ x:175, y:265 }, { x:175, y:180 }, async () => {
    assert.match(await b.run("getComputedStyle(document.querySelector('.app-scroll-content > .page')).translate"), /^0px -[1-9]/);
    assert.equal(await headingTop(), recordsHeading);
  });
  for (const path of ['/mine', '/home']) {
    await route(path);
    const top = await headingTop();
    await b.run(`document.querySelector('${viewport}').scrollTop=200`);
    await wait(80);
    const scrolled = await b.run(`document.querySelector('${viewport}').scrollTop > 100`);
    assert.ok(scrolled, path + ' scrolls independently of its header');
    if (path === '/home') assert.ok(await headingTop() < top - 100);
    else assert.equal(await headingTop(), top);
  }
  const homeNotPulling = async () => {
    assert.equal(await b.run("document.querySelector('.app-scroll-content').style.getPropertyValue('--page-pull')"), '');
    assert.equal(await b.run("getComputedStyle(document.querySelector('.home .hero')).translate"), 'none');
  };
  await b.run(`document.querySelector('${viewport}').scrollTop=0`);
  await swipe({ x:175, y:205 }, { x:175, y:288 }, homeNotPulling);
  await b.run(`const homeView=document.querySelector('${viewport}'); homeView.scrollTop=homeView.scrollHeight`);
  await swipe({ x:175, y:265 }, { x:175, y:180 }, homeNotPulling);
  await b.send('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:1,mobile:true});
  await route('/records-source');
  const defaultOption = () => b.run(`[...document.querySelectorAll('.source-opt')].filter(b => b.querySelector('.pill')?.textContent === '默认')
    .map(b => [b.querySelector('b').textContent, b.getAttribute('aria-pressed')])`);
  assert.deepEqual(await defaultOption(), [['关闭记录', 'false']]);
  await b.run(`[...document.querySelectorAll('.source-opt')].find(b => b.querySelector('b').textContent === '手机记录').click()`);
  await b.reload();
  assert.deepEqual(await defaultOption(), [['关闭记录', 'false']]);
  assert.equal(await b.run("document.querySelector('.source-opt[aria-pressed=true] b').textContent"), '手机记录');
  assert.deepEqual(b.errors, []);
  console.log('统计卡长按、普通滚动、图表入场、每日展开收起、导航隐藏和列表两端回弹通过。');
} finally {
  await b.close();
}
