import assert from 'node:assert/strict';
import { browser, wait } from './cdp.mjs';

const origin = process.env.LEAPMORE_DEMO_ORIGIN ?? 'http://127.0.0.1:5175/';

function installBridge(platform) {
  if (platform === 'ios') window.webkit = { messageHandlers: { bridge: {} } };
  else if (platform === 'android') window.androidBridge = {};
  else window.CapacitorCustomPlatform = { name: platform };
  localStorage.setItem('leapmore.mode', JSON.stringify('demo'));
  localStorage.setItem('leapmore.activeVehicle', JSON.stringify('demo-c10'));
  let pending = { action: 'find' };
  window.widgetPress = request => { pending = request; };
  const plugins = {
    App: ['getLaunchUrl', 'getInfo', 'addListener'],
    LeapWidget: ['update', 'clear', 'take', 'takeDemo', 'publishQuick'],
    LeapVault: ['get'],
  };
  window.Capacitor = {
    PluginHeaders: Object.entries(plugins).map(([name, methods]) => ({
      name, methods: methods.map(name => ({ name, rtype: 'promise' })),
    })),
    nativeCallback: () => 'fixture',
    nativePromise: async (plugin, op) => {
      if (plugin === 'LeapWidget' && op === 'take') {
        const result = pending;
        pending = {};
        return result;
      }
      if (op === 'takeDemo') {
        const effects = sessionStorage.getItem('widget-test-effects') ?? '[]';
        sessionStorage.removeItem('widget-test-effects');
        return { effects };
      }
      return {};
    },
  };
}

async function confirmTitle(page, title) {
  const expected = 'document.querySelector(".confirm-sheet")?.textContent.includes(' + JSON.stringify(title) + ')';
  for (let i = 0; i < 80; i++) {
    if (await page.run(expected)) return;
    await wait(100);
  }
  assert.fail('未显示确认框 ' + title);
}
const cancel = page => page.run('[...document.querySelectorAll(".confirm-sheet button")].find(b => b.textContent === "取消").click()');

for (const platform of ['ios', 'openharmony', 'android']) {
  const page = await browser('about:blank', 390, 844);
  try {
    await page.send('Page.addScriptToEvaluateOnNewDocument', { source: '(' + installBridge + ')(' + JSON.stringify(platform) + ')' });
    await page.navigate(origin);
    if (platform === 'android') {
      await page.run(`localStorage.removeItem('leapmore.native-demo-controls');
        sessionStorage.setItem('widget-test-effects', JSON.stringify([{vehicleId:'demo-c10', action:'climate-heat'}]))`);
      await page.navigate(new URL('?widget-control=climate&vehicle=demo:demo-c10', origin).href);
      await confirmTitle(page, '关闭空调');
      await page.reload();
      await confirmTitle(page, '关闭空调');
    } else {
      await confirmTitle(page, '鸣笛寻车');
      await cancel(page);
      await page.run('window.widgetPress({action:"climate"})');
      await confirmTitle(page, '空调');
      await cancel(page);
      if (platform === 'ios') {
        await page.run('window.widgetPress({action:"climate-heat",target:JSON.stringify(["demo","demo-c10","DEMO••8821"])})');
        await confirmTitle(page, '极速升温');
      }
    }
    console.log(platform + ' 桌面控车确认通过');
  } finally { await page.close(); }
}
