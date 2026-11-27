import 'core-js/web/url';
import 'core-js/web/url-search-params';
import { CloudSessionExpired, exchangeCarToken, refreshAccountToken, LiveVehicleClient, RemoteDeliveryUnknown } from '../../src/data/cloud/LiveClient';
import type { LiveVehicles } from '../../src/data/cloud/LiveClient';
import { RemoteCommandError } from '../../src/data/cloud/remote';
import type { RemoteCommand } from '../../src/data/cloud/remote';
import { preparationContent, permitsCommand } from '../../src/data/cloud/preparation';
import type { PreparationPreset } from '../../src/data/cloud/preparation';
import { sha256Hex } from '../../src/data/cloud/liveCrypto';

import { quickClimatePreset } from '../../src/data/cloud/climatePresets';

export interface QuickHost {
  input(): string;
  enteredPin?(): string;
  vault(key: string): string | null;
  session(previous: string, next: string): boolean;
  http(request: string): string;
  finish(message: string, effect: string): void;
}
declare global { var QuickHost: QuickHost; }
type Entry = {id: string; title: string; preset: boolean; definition?: PreparationPreset; demoBlocked?: string; demoControl?: boolean};
const invalid = '绑定的车辆或预设已不可用';

async function execute(action: string, target: string, approval: string) {
  const entry = (): Entry => {
    const value = JSON.parse(QuickHost.input() || 'null') as Entry | null;
    if (!value || value.id !== target || value.preset !== (action === 'prepare' || action === 'prepare-2')) throw new RemoteCommandError(invalid);
    return value;
  };
  const current = entry();
  const [profile, vehicleId, vin, presetId] = JSON.parse(target) as string[];
  if (!vehicleId || !vin || current.definition?.id !== presetId) throw new RemoteCommandError(invalid);
  const climatePreset = quickClimatePreset(action);
  const windowPosition = action === 'window-close' ? 'closed' : action === 'window-vent' ? 'vent' : null;
  if (!climatePreset && !windowPosition && !['prepare', 'prepare-2', 'lock-only', 'climate-on', 'climate-off', 'find'].includes(action)) throw new RemoteCommandError(invalid);
  // A native confirmation is scoped to the exact action, target and configuration shown.
  async function userApproved(method: 'confirm' | 'pin') {
    const challenge = method + ':' + await sha256Hex(JSON.stringify([method, action, current]));
    if (approval === challenge) return true;
    if (approval) throw new RemoteCommandError('控车配置已变更，请重新操作');
    QuickHost.finish(challenge, '');
    return false;
  }
  if (profile === 'demo') {
    if (action !== 'lock-only' && current.demoControl === false) throw new RemoteCommandError('车辆控制未授权');
    if (current.demoBlocked) throw new RemoteCommandError(current.demoBlocked);
    if (!await userApproved('confirm')) return;
    QuickHost.finish('模拟已执行', JSON.stringify({ vehicleId, action, preset: current.definition }));
    return;
  }
  const read = <T>(key: string): T | null => JSON.parse(QuickHost.vault(key) || 'null');
  let original = QuickHost.vault('leapmotor-session') || '';
  let session = JSON.parse(original || 'null') as LiveVehicles | null;
  if (!session || profile !== 'cloud:' + session.account.userId) throw new RemoteCommandError('请先登录绑定车辆的账号');
  const scope = await sha256Hex(JSON.stringify([session.account.userId, vin.toUpperCase()]));
  function credentials() {
    const prefs = read<{ mode: string; saved: boolean }>('remote-control:mode:' + scope);
    const saved = (prefs?.mode === 'instant' || prefs?.mode === 'reuse') && prefs.saved && read<string>('remote-control:pin:' + scope);
    return { mode: prefs?.mode, saved: typeof saved === 'string' && /^\d{4,6}$/.test(saved) ? saved : '' };
  }
  const auth = credentials();
  if (!auth.saved || auth.mode !== 'instant') {
    if (!await userApproved(auth.saved ? 'confirm' : 'pin')) return;
  } else if (approval) throw new RemoteCommandError('控车配置已变更，请重新操作');
  const pin = auth.saved || QuickHost.enteredPin?.() || '';
  if (!/^\d{4,6}$/.test(pin)) throw new RemoteCommandError('请输入 4 至 6 位操作密码');
  const accountId = session.account.userId, deviceId = session.deviceId;
  function save(next: LiveVehicles) {
    const encoded = JSON.stringify(next);
    if (QuickHost.session(original, encoded)) {
      original = encoded;
      return next;
    }
    original = QuickHost.vault('leapmotor-session') || '';
    const latest = JSON.parse(original || 'null') as LiveVehicles | null;
    if (!latest || latest.account.userId !== accountId || latest.deviceId !== deviceId) throw new CloudSessionExpired();
    return latest;
  }
  if (session.car.expiresAt <= Date.now() + 30_000) {
    if (session.account.expiresAt <= Date.now() + 30_000) {
      const account = await refreshAccountToken(session.account, session.deviceId);
      session = save({ ...session, account });
    }
    if (session.car.expiresAt <= Date.now() + 30_000) {
      const car = await exchangeCarToken(session.account, session.deviceId);
      session = save({ ...session, car });
    }
  }
  const active = session;
  const client = new LiveVehicleClient(active.car, active.account, active.deviceId, active.vehicles);
  const checkSession = () => {
    const latest = read<LiveVehicles>('leapmotor-session');
    if (latest?.account.userId !== active.account.userId || latest.deviceId !== active.deviceId ||
        latest.car.accessToken !== active.car.accessToken) throw new CloudSessionExpired();
    if (JSON.stringify(entry()) !== JSON.stringify(current) || JSON.stringify(credentials()) !== JSON.stringify(auth)) throw new RemoteCommandError(invalid);
  };
  const guard = { throwIfAborted: checkSession } as AbortSignal;
  let submitted = false;
  try {
    const car = (await client.getVehicles()).find(car => car.id === vehicleId && car.vin === vin);
    if (!car) throw new RemoteCommandError(invalid);
    const commandId = action.startsWith('prepare') ? 360 : action === 'find' ? 120 : action === 'lock-only' ? 110 : windowPosition ? 230 : 170;
    if (!permitsCommand(car, commandId)) throw new RemoteCommandError('此车未授权该操作');
    let command: RemoteCommand;
    if (current.definition) command = { kind: 'prepare', content: preparationContent(current.definition, car) };
    else if (windowPosition) command = { kind: 'window', position: windowPosition };
    else if (climatePreset) command = { kind: 'climate', on: true, preset: true, ...climatePreset[2] };
    else if (action === 'find') command = { kind: 'find' };
    else {
      const state = await client.getState(vehicleId, 6000);
      const age = Date.now() - (state.reportedAt ?? 0);
      const fresh = age >= -5000 && age <= 90_000;
      if (action === 'lock-only') {
        if (fresh && state.locked === true) { QuickHost.finish('车辆已上锁', ''); return; }
        command = {kind:'lock', locked:true};
      } else {
        const on = action === 'climate-on';
        if (fresh && state.climateOn === on) { QuickHost.finish(on ? '空调已开启' : '空调已关闭', ''); return; }
        command = {kind:'climate', on, temp: state.climateTempC ?? 24, fan: state.climateFan && state.climateFan <= 7 ? state.climateFan : 3, mode:'cool'};
      }
    }
    const receipt = await client.sendCommand(vehicleId, command, pin, guard, () => { checkSession(); submitted = true; }, undefined, vin);
    const ack = await client.queryCommand(receipt).catch(() => 'pending');
    QuickHost.finish(ack === 'confirmed' ? '车辆已确认' : ack === 'failed' ? '车辆执行失败' : '云端已受理，等待车辆确认', '');
  } catch (error) {
    if (error instanceof RemoteCommandError || error instanceof CloudSessionExpired) throw error;
    if (submitted || error instanceof RemoteDeliveryUnknown) throw new RemoteCommandError('发送结果未知，请查看车况');
    throw error;
  }
}

export function run(action: string, target: string, approval = '') {
  void execute(action, target, approval).catch(error => QuickHost.finish(error instanceof CloudSessionExpired ? '登录已失效，请打开 App 刷新登录' :
    error instanceof RemoteCommandError ? error.message : '无法连接车辆服务，请稍后重试', ''));
}

