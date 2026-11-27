import { CapacitorPlugin, PluginCall } from 'harmony-capacitor';
import { bundleManager, common, ConfigurationConstant } from '@kit.AbilityKit';
import { util, url } from '@kit.ArkTS';
import { BusinessError, deviceInfo } from '@kit.BasicServicesKit';
import { asset } from '@kit.AssetStoreKit';
import { connection, http, socket } from '@kit.NetworkKit';
import { preferences } from '@kit.ArkData';
import { formBindingData, formProvider } from '@kit.FormKit';
import { fileIo, picker } from '@kit.CoreFileKit';
import { userAuth } from '@kit.UserAuthenticationKit';
import { cryptoFramework } from '@kit.CryptoArchitectureKit';

function reject(call: PluginCall, message: string): void { call.rejectMessage('LEAPMORE', message); }
const utf8 = new util.TextEncoder();
const decoder = util.TextDecoder.create('utf-8');
interface SaveResult { saved: boolean }
interface DiagnosticEnvironment {
  os: string; sdk: number; activeNetwork?: boolean; wifi?: boolean; cellular?: boolean; ethernet?: boolean;
  vpn?: boolean; validated?: boolean; networkInfoError?: number;
}
interface AppIconStatus { icon: string; canChange: boolean; }

export class LeapSettings extends CapacitorPlugin {
  private readonly context: common.UIAbilityContext;
  constructor(context: common.UIAbilityContext) {
    super();
    this.context = context;
    this.registerMethod('diagnosticEnvironment', call => { this.diagnosticEnvironment(call); });
    this.registerMethod('saveCsv', call => { this.saveText(call); });
    this.registerMethod('saveText', call => { this.saveText(call); });
    this.registerMethod('saveRewardImage', call => {
      this.saveDocument(call, 'LeapMore-微信赞赏码.png', () =>
        this.context.resourceManager.getRawFileContentSync('www/assets/wechat-reward-qr.png'));
    });
    this.registerMethod('openAmap', call => { this.openAmap(call); });
    this.registerMethod('openRelease', call => {
      const address = call.getString('url');
      const isReleaseSite = /^https:\/\/(github\.com|gitcode\.com)\//.test(address);
      if (!isReleaseSite && address !== 'https://leapmore.mirato66.cloud/' && address !== 'https://pan.quark.cn/s/9e6168a73f21' &&
          address !== 'https://afdian.com/a/mirato' && address !== 'https://lbs.amap.com/' &&
          address !== 'https://console.amap.com/dev/key/app') {
        reject(call, '无效外部链接'); return;
      }
      this.context.startAbility({ action: 'ohos.want.action.viewData', uri: address, entities: ['entity.system.browsable'] })
        .then(() => call.resolve()).catch(() => reject(call, '无法打开系统浏览器'));
    });
    this.registerMethod('getAppIcon', call => { this.getAppIcon(call); });
    this.registerMethod('setAppIcon', call => { this.setAppIcon(call); });
  }

  private async diagnosticEnvironment(call: PluginCall): Promise<void> {
    const facts: DiagnosticEnvironment = { os: deviceInfo.osFullName, sdk: deviceInfo.sdkApiVersion };
    try {
      const net = await connection.getDefaultNet();
      facts.activeNetwork = net.netId !== 0;
      if (facts.activeNetwork) {
        const caps = await connection.getNetCapabilities(net);
        facts.wifi = caps.bearerTypes.includes(connection.NetBearType.BEARER_WIFI);
        facts.cellular = caps.bearerTypes.includes(connection.NetBearType.BEARER_CELLULAR);
        facts.ethernet = caps.bearerTypes.includes(connection.NetBearType.BEARER_ETHERNET);
        facts.vpn = caps.bearerTypes.includes(connection.NetBearType.BEARER_VPN);
        facts.validated = caps.networkCap?.includes(connection.NetCap.NET_CAPABILITY_VALIDATED);
      }
    } catch (error) {
      facts.networkInfoError = (error as BusinessError).code;
    }
    call.resolve(facts);
  }

  private async getAppIcon(call: PluginCall): Promise<void> {
    const result: AppIconStatus = { icon: 'simple', canChange: false };
    if (deviceInfo.sdkApiVersion >= 26) {
      try {
        const icons = await bundleManager.getAlternateIcons();
        const original = icons.find(icon => icon.iconName === 'original');
        result.canChange = !!original;
        if (original?.enabled) result.icon = 'original';
      } catch { reject(call, '无法读取系统图标'); return; }
    }
    call.resolve(result);
  }

  private async setAppIcon(call: PluginCall): Promise<void> {
    const icon = call.getString('icon');
    if (icon !== 'simple' && icon !== 'original') { reject(call, '应用图标无效'); return; }
    if (deviceInfo.sdkApiVersion < 26) { reject(call, '当前系统不支持更换桌面图标'); return; }
    try {
      await bundleManager.setAlternateIcon(icon === 'original' ? 'original' : '');
      call.resolve();
    } catch { reject(call, '系统未能切换应用图标'); }
  }

  private async openAmap(call: PluginCall): Promise<void> {
    const app = call.getString('app');
    const web = call.getString('web');
    if (!app.startsWith('amapuri://route/plan/?') || !web.startsWith('https://uri.amap.com/navigation?')) {
      reject(call, '导航地址无效');
      return;
    }
    try { await this.context.startAbility({ action: 'ohos.want.action.viewData', uri: app }); }
    catch {
      try { await this.context.startAbility({ action: 'ohos.want.action.viewData', uri: web }); }
      catch { reject(call, '无法打开高德地图'); return; }
    }
    call.resolve();
  }

  private async saveText(call: PluginCall): Promise<void> {
    const name = call.getString('name');
    if (!/^[a-zA-Z0-9_-]+\.(csv|txt)$/.test(name)) { reject(call, '文件名或文本无效'); return; }
    await this.saveDocument(call, name, () => utf8.encodeInto(call.getString('text')));
  }

  private async saveDocument(call: PluginCall, name: string, contents: () => Uint8Array): Promise<void> {
    try {
      const options = new picker.DocumentSaveOptions();
      options.newFileNames = [name];
      const targets = await new picker.DocumentViewPicker(this.context).save(options);
      if (targets.length > 0) {
        const bytes = contents();
        const file = fileIo.openSync(targets[0], fileIo.OpenMode.WRITE_ONLY | fileIo.OpenMode.TRUNC);
        try {
          let offset = 0;
          while (offset < bytes.byteLength) {
            const remaining = bytes.buffer.slice(bytes.byteOffset + offset, bytes.byteOffset + bytes.byteLength);
            const count = fileIo.writeSync(file.fd, remaining);
            if (count <= 0) throw new Error('写入不完整');
            offset += count;
          }
        }
        finally { fileIo.closeSync(file); }
      }
      const result: SaveResult = { saved: targets.length > 0 };
      call.resolve(result);
    } catch { reject(call, '无法保存文件'); }
  }
}

export class Vault {
  private match(key: string): asset.AssetMap {
    return new Map<asset.Tag, asset.Value>([[asset.Tag.ALIAS, utf8.encodeInto('leapmore:' + key)]]);
  }
  private async item(key: string): Promise<Uint8Array | null> {
    const query = this.match(key);
    query.set(asset.Tag.RETURN_TYPE, asset.ReturnType.ALL);
    try {
      const rows = await asset.query(query);
      return rows[0]?.get(asset.Tag.SECRET) as Uint8Array ?? null;
    } catch (error) {
      if ((error as BusinessError).code === asset.ErrorCode.NOT_FOUND) return null;
      throw new Error('安全存储操作失败');
    }
  }
  private async put(key: string, bytes: Uint8Array): Promise<void> {
    const entry = this.match(key);
    entry.set(asset.Tag.SECRET, bytes);
    entry.set(asset.Tag.ACCESSIBILITY, asset.Accessibility.DEVICE_UNLOCKED);
    entry.set(asset.Tag.CONFLICT_RESOLUTION, asset.ConflictResolution.OVERWRITE);
    await asset.add(entry);
  }
  private async drop(key: string): Promise<void> {
    try { await asset.remove(this.match(key)); }
    catch (error) { if ((error as BusinessError).code !== asset.ErrorCode.NOT_FOUND) throw new Error('安全存储操作失败'); }
  }
  private async index(key: string): Promise<string[]> {
    const root = await this.item(key);
    return root ? decoder.decodeToString(root).split(':') : [];
  }
  async get(key: string): Promise<string | undefined> {
    const info = await this.index(key);
    if (!info.length) return undefined;
    const data = new Uint8Array(Number(info[2]));
    let offset = 0;
    for (let index = 0; index < Number(info[1]); index++) {
      const part = await this.item(key + ':' + info[0] + ':' + index);
      if (part === null) throw new Error('安全存储不完整');
      data.set(part, offset);
      offset += part.length;
    }
    return decoder.decodeToString(data);
  }
  async set(key: string, value: string): Promise<void> {
    const current = await this.index(key);
    const generation = current[0] === 'a' ? 'b' : 'a';
    const data = utf8.encodeInto(value);
    const count = Math.ceil(data.length / 768);
    if (count > 200) throw new Error('数据超限');
    for (let i = 0; i < count; i++) await this.put(key + ':' + generation + ':' + i, data.slice(i * 768, (i + 1) * 768));
    await this.put(key, utf8.encodeInto(generation + ':' + count + ':' + data.length));
    await this.dropParts(key, current).catch(() => {});
  }
  async remove(key: string): Promise<void> {
    const current = await this.index(key);
    await this.drop(key);
    await this.dropParts(key, current);
  }
  private async dropParts(key: string, info: string[]): Promise<void> {
    if (!info.length) return;
    for (let i = 0; i < Number(info[1]); i++) await this.drop(key + ':' + info[0] + ':' + i);
  }
}

interface VaultValue { value?: string; }
interface BiometricAvailability { available: boolean; }
const biometricPrefix = 'remote-control-biometric:';
export class LeapVault extends CapacitorPlugin {
  private vault = new Vault();
  private jobs: Promise<void> = Promise.resolve();
  constructor() {
    super();
    this.registerMethod('get', call => this.queue(async () => {
      if (call.getString('key').startsWith(biometricPrefix)) { reject(call, '无法读取安全存储'); return; }
      const value = await this.vault.get(call.getString('key'));
      const output: VaultValue = { value: value };
      call.resolve(output);
    }, call));
    this.registerMethod('set', call => this.queue(async () => {
      await this.vault.set(call.getString('key'), call.getString('value'));
      call.resolve();
    }, call));
    this.registerMethod('remove', call => this.queue(async () => {
      await this.vault.remove(call.getString('key'));
      call.resolve();
    }, call));
    this.registerMethod('biometricsAvailable', call => {
      const result: BiometricAvailability = { available: this.biometricTypes().length > 0 };
      call.resolve(result);
    });
    this.registerMethod('getWithBiometrics', call => this.queue(async () => {
      const key = call.getString('key');
      if (!key.startsWith(biometricPrefix)) { reject(call, '无法读取操作密码'); return; }
      if (!await this.authenticate()) { reject(call, '生物识别未通过'); return; }
      const value = await this.vault.get(key);
      const result: VaultValue = { value };
      call.resolve(result);
    }, call));
  }

  private biometricTypes(): userAuth.UserAuthType[] {
    const modes = [userAuth.UserAuthType.FINGERPRINT, userAuth.UserAuthType.FACE];
    return modes.filter(type => {
      try { userAuth.getAvailableStatus(type, userAuth.AuthTrustLevel.ATL3); return true; }
      catch { return false; }
    });
  }

  private authenticate(): Promise<boolean> {
    const authType = this.biometricTypes();
    if (!authType.length) return Promise.resolve(false);
    return new Promise<boolean>(resolve => {
      try {
        const params: userAuth.AuthParam = { challenge: cryptoFramework.createRandom().generateRandomSync(16).data,
          authType, authTrustLevel: userAuth.AuthTrustLevel.ATL3 };
        const widget: userAuth.WidgetParam = { title: '验证身份以控车', navigationButtonText: '改用操作密码' };
        const instance = userAuth.getUserAuthInstance(params, widget);
        instance.on('result', {
          onResult(result: userAuth.UserAuthResult): void {
            resolve(result.result === userAuth.UserAuthResultCode.SUCCESS);
            instance.off('result');
          }
        });
        instance.start();
      } catch { resolve(false); }
    });
  }
  private queue(task: () => Promise<void>, call: PluginCall): void {
    if (!call.getString('key')) { reject(call, '安全存储参数不完整'); return; }
    this.jobs = this.jobs.then(task).catch(() => { reject(call, '系统安全存储操作失败'); });
  }
}

interface Redirect { redirect: string; }
interface AuthValue { url?: string; }
export class LeapAuth extends CapacitorPlugin {
  private listener: socket.TCPSocketServer | null = null;
  private callback: string | undefined;
  private timer: number = -1;
  private context: common.UIAbilityContext;
  constructor(context: common.UIAbilityContext) {
    super();
    this.context = context;
    this.registerMethod('begin', call => { this.begin(call); });
    this.registerMethod('take', call => { const output: AuthValue = { url: this.callback }; this.callback = undefined; call.resolve(output); });
    this.registerMethod('open', call => {
      const address = call.getString('url');
      if (!/^https?:\/\//.test(address)) { reject(call, '无效授权地址'); return; }
      this.context.startAbility({ action: 'ohos.want.action.viewData', uri: address, entities: ['entity.system.browsable'] })
        .then(() => call.resolve()).catch(() => reject(call, '无法打开系统浏览器'));
    });
  }
  private async begin(call: PluginCall): Promise<void> {
    const expected = call.getString('state');
    if (!/^[0-9a-f]{64}$/.test(expected)) { reject(call, '无效授权参数'); return; }
    this.stop();
    this.callback = undefined;
    const server = socket.constructTCPSocketServerInstance();
    this.listener = server;
    try {
      await server.listen({ address: '127.0.0.1', port: 0, family: 1 });
      const local = await server.getLocalAddress();
      const redirect = 'http://127.0.0.1:' + local.port + '/leapmore-ha';
      server.on('connect', client => this.listen(client, server, redirect, expected));
      this.timer = setTimeout(() => this.stop(), 600_000);
      const value: Redirect = { redirect: redirect };
      call.resolve(value);
    } catch { this.stop(); reject(call, '无法启动授权回调'); }
  }
  private listen(client: socket.TCPSocketConnection, server: socket.TCPSocketServer, redirect: string, expected: string): void {
    let request = '';
    let done = false;
    const timeout = setTimeout(() => { client.close().catch(() => {}); }, 2500);
    client.on('message', data => {
      if (done) return;
      request += decoder.decodeToString(new Uint8Array(data.message));
      if (request.length > 8192) { done = true; client.close().catch(() => {}); return; }
      const newline = request.indexOf('\n');
      if (newline < 0) return;
      done = true;
      const parts = request.slice(0, newline).trim().split(' ');
      let ok = false;
      if (this.listener === server && parts.length === 3 && parts[0] === 'GET' && parts[1].startsWith('/leapmore-ha?')) {
        try {
          const uri = url.URL.parseURL(redirect + parts[1].substring('/leapmore-ha'.length));
          ok = uri.params.get('state') === expected && (uri.params.has('code') || uri.params.has('error'));
          if (ok) this.callback = uri.href;
        } catch {}
      }
      const html = ok ? '<meta charset=utf-8><title>返回 LeapMore</title><p>授权完成，请返回 LeapMore。</p>' : 'Not found';
      const size = utf8.encodeInto(html).length;
      const packet = 'HTTP/1.1 ' + (ok ? '200 OK' : '404 Not Found') + '\r\nCache-Control: no-store\r\nReferrer-Policy: no-referrer\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: ' + size + '\r\nConnection: close\r\n\r\n' + html;
      client.send({ data: packet }).catch(() => {}).finally(() => {
        clearTimeout(timeout);
        client.close().catch(() => {});
        if (ok) this.stop();
      });
    });
  }
  private stop(): void {
    if (this.timer !== -1) clearTimeout(this.timer);
    if (this.listener) this.listener.close().catch(() => {});
    this.listener = null;
  }
}

interface NetResult { status: number; data: string; }
export class LeapNet extends CapacitorPlugin {
  constructor() {
    super();
    this.registerMethod('request', call => { this.request(call); });
  }
  private async request(call: PluginCall): Promise<void> {
    const address = call.getString('url');
    const input = call.getString('method');
    if (!/^https?:\/\//.test(address) || !['GET', 'POST', 'HEAD'].includes(input)) { reject(call, '无效请求'); return; }
    const binary = call.getBoolean('binary');
    const probe = call.getBoolean('probe');
    let client: http.HttpRequest | undefined = undefined;
    try {
      client = http.createHttp();
      const timeout = call.getNumber('timeoutMs');
      const options: http.HttpRequestOptions = {
        method: input === 'POST' ? http.RequestMethod.POST : input === 'HEAD' ? http.RequestMethod.HEAD : http.RequestMethod.GET,
        header: call.getObject('headers'), usingCache: false, connectTimeout: timeout > 0 ? Math.min(timeout, 20000) : probe ? 6000 : 10000,
        readTimeout: timeout > 0 ? Math.min(timeout, 120000) : probe ? 6000 : 20000,
        expectDataType: binary ? http.HttpDataType.ARRAY_BUFFER : http.HttpDataType.STRING
      };
      const body = call.getString('body');
      // ArkTS HTTP rejects an explicit empty string for POST. Login sends its parameters in the URL.
      if (input === 'POST' && body.length > 0) options.extraData = body;
      const reply = await client.request(address, options);
      const value = reply.result instanceof ArrayBuffer && binary
        ? new util.Base64Helper().encodeToStringSync(new Uint8Array(reply.result))
        : typeof reply.result === 'string' ? reply.result : '';
      const data: NetResult = { status: reply.responseCode, data: value };
      call.resolve(data);
    } catch (error) {
      const code = (error as BusinessError).code;
      const safeCode = Number.isSafeInteger(code) ? code : 0;
      call.rejectMessage('HARMONY_HTTP_' + safeCode, 'HARMONY_HTTP_' + safeCode);
    } finally { client?.destroy(); }
  }
}

export interface VehicleSummary {
  range?: string; rangeLabel?: string; soc?: string; fuel?: string; charging?: string; chargeStatus?: string;
  colorScheme?: string; climateOn?: boolean; trunkOpen?: boolean;
  state?: string; power?: string; locked?: string; inside?: string; odometer?: string;
  lockAction?: string; simulated?: boolean; canLock?: boolean; canControl?: boolean; canTrunk?: boolean; canFind?: boolean;
}
interface CardData extends VehicleSummary { dimension: number; stale: boolean; }
interface WidgetAction { action?: string; }
let pendingWidget: string | undefined;
export function acceptWidgetAction(action: string): void {
  if (['open', 'lock', 'climate', 'trunk', 'find'].includes(action)) pendingWidget = action;
}
export function widgetPrefs(context: common.Context): preferences.Preferences {
  return preferences.getPreferencesSync(context, { name: 'leapmore_widget' });
}
export function widgetData(prefs: preferences.Preferences, dimension: number, systemMode?: ConfigurationConstant.ColorMode): formBindingData.FormBindingData {
  const value = JSON.parse(prefs.getSync('summary', '{}') as string) as VehicleSummary;
  const updated = prefs.getSync('updated', 0) as number;
  const stale = Date.now() - updated > 900_000;
  const data: CardData = {
    dimension: dimension,
    stale: stale,
    range: value.range ?? '— km',
    rangeLabel: value.rangeLabel ?? '续航',
    colorScheme: value.colorScheme ?? (systemMode === ConfigurationConstant.ColorMode.COLOR_MODE_DARK ? 'dark' : 'light'),
    climateOn: value.climateOn === true,
    trunkOpen: value.trunkOpen === true,
    soc: value.soc ?? '—',
    fuel: value.fuel ?? '',
    charging: value.charging ?? '状态未知',
    chargeStatus: value.chargeStatus ?? '',
    state: !updated ? '待同步' : stale ? '缓存车况' : value.state ?? '状态未知',
    power: value.power ?? '',
    locked: value.locked ?? '—',
    inside: value.inside ?? '—',
    odometer: value.odometer ?? '',
    lockAction: value.lockAction ?? '解锁',
    canLock: !stale && value.canLock === true,
    canControl: !stale && value.canControl === true,
    canTrunk: !stale && (value.canTrunk ?? value.canControl) === true,
    canFind: !stale && (value.canFind ?? value.canControl) === true,
  };
  return formBindingData.createFormBindingData(data);
}
export class LeapWidget extends CapacitorPlugin {
  private context: common.UIAbilityContext;
  constructor(context: common.UIAbilityContext) {
    super();
    this.context = context;
    this.registerMethod('update', call => { this.store(call, false); });
    this.registerMethod('clear', call => { this.store(call, true); });
    this.registerMethod('take', call => {
      const result: WidgetAction = { action: pendingWidget };
      pendingWidget = undefined;
      call.resolve(result);
    });
  }
  private async store(call: PluginCall, clear: boolean): Promise<void> {
    try {
      const prefs = widgetPrefs(this.context);
      prefs.putSync('summary', clear ? '{}' : JSON.stringify(call.getObject('summary')));
      prefs.putSync('updated', clear ? 0 : Date.now());
      await prefs.flush();
      const catalog = prefs.getAllSync();
      for (const key of Object.keys(catalog)) if (key.startsWith('widget-')) {
        await formProvider.updateForm(key.substring(7), widgetData(prefs, prefs.getSync(key, 2) as number, this.context.config.colorMode)).catch(() => {});
      }
      call.resolve();
    } catch { reject(call, '桌面卡片更新失败'); }
  }
}
