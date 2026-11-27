import { readSetting, saveSetting } from '../../data/localDatabase';
import { createContext, useContext, useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { useModelContext } from '../context';
import { useCommands } from './commands';
import { Capacitor } from '@capacitor/core';
import { App as NativeApp } from '@capacitor/app';
import { widgetBridge } from '../../platform/widgets';
import { Row, Seg, Sheet, Switch } from '../../ui/components';
import { Icon } from '../../ui/Icon';
import type { IconName } from '../../ui/Icon';
import type { PreparationPreset } from '../../data/cloud/preparation';
import type { CabinHeater, ClimateMode, RemoteCommand } from '../../data/cloud/remote';
import { reportedWindowPosition, weekdays } from '../../data/cloud/remote';

import { climatePresets as presets, findClimatePreset, quickClimatePreset } from '../../data/cloud/climatePresets';
export { presets };
type Climate = { on: boolean; temp: number; mode: ClimateMode; fan: number; seat: number; vent: number; preset: string };
const windowChoices = ['closed', 'vent', 'half', 'full'] as const;
type WindowChoice = typeof windowChoices[number];
const windows = {
  closed: { label: '关闭', status: '全关', command: '关闭车窗', icon: 'sideWindow' },
  vent: { label: '开一条缝', status: '微开', command: '车窗开一条缝', icon: 'sideWindowVent' },
  half: { label: '半开', status: '半开', command: '车窗半开', icon: 'sideWindowHalf' },
  full: { label: '全开', status: '全开', command: '车窗全开', icon: 'sideWindowFull' },
  open: { status: '未关，开度未知', icon: 'sideWindowOpen' },
  unknown: { status: '车窗状态未知', icon: 'sideWindowOpen' },
} as const;
const initial = {
  locked: true, trunk: false, window: 'closed' as WindowChoice, shade: false,
  climate: { on: false, temp: 18, mode: 'cool', fan: 2, seat: 0, vent: 0, preset: '' } as Climate,
  sentry: false, steeringHeat: false, mirrorHeat: false,
  limit: 90, health: true, schedule: false, start: '22:00', end: '06:00', days: weekdays,
};
export const chargeLabels = { unplugged: '未插枪', plugged: '已插枪', charging: '充电中', done: '充电完成', unknown: '状态未知' } as const;
const seatLevels = [[0, '关'], [1, '1'], [2, '2'], [3, '3']] as const;
const cabinHeaters = {
  steeringHeat: { title: '方向盘加热', icon: 'steering' },
  mirrorHeat: { title: '后视镜加热', icon: 'defrost' },
} as const;
const heaterKeys = ['steeringHeat', 'mirrorHeat'] as const;

function preparationSettings(climate: Climate, preset: PreparationPreset) {
  const prepared = { ...climate };
  const selected = findClimatePreset(preset.climatePreset);
  if (preset.climate) Object.assign(prepared, { on: true, temp: preset.temperature, fan: preset.fan, ...selected?.[2], preset: selected?.[0] ?? '' });
  if (preset.seat === 'heat') { prepared.seat = 3; prepared.vent = 0; }
  if (preset.seat === 'vent') { prepared.vent = 3; prepared.seat = 0; }
  return { climate: prepared, ...(preset.steering && { steeringHeat: true }), ...(preset.mirrors && { mirrorHeat: true }) };
}

type VehicleSettings = Record<string, typeof initial>;
const demoStorage = 'native-demo-controls';
const nativeDemoPlatform = () => ['android', 'ios'].includes(Capacitor.getPlatform());
const readDemoControls = () => readSetting<VehicleSettings>(demoStorage, {});

function useControlsModel() {
  const model = useModelContext();
  const cmd = useCommands();
  const [settingsByVehicle, setSettings] = useState<VehicleSettings>({});
  const [demoSettings, setDemoSettings] = useState<VehicleSettings>(readDemoControls);
  const [demoLoaded, setDemoLoaded] = useState(false);
  const nativeDemo = model.simulated && nativeDemoPlatform();
  const demoControlsReady = !nativeDemo || demoLoaded;
  const settings = (nativeDemo ? demoSettings : settingsByVehicle)[model.vehicleId] ?? initial;
  const [sheet, setSheet] = useState<'seat' | 'windows' | 'presets' | null>(null);
  const current = model.current;
  const targetTemp = model.simulated ? settings.climate.temp : current.climateTemp;
  const climate = model.simulated ? settings.climate : {
    ...initial.climate, temp: current.climateTemp ?? 24, fan: current.climateFan && current.climateFan <= 7 ? current.climateFan : 3,
    seat: current.seatHeat ?? -1, vent: current.seatVent ?? -1,
  };
  const heating = model.simulated ? settings : current;
  const hasCabinHeating = heaterKeys.some(key => heating[key] !== null);
  const hasComfort = hasCabinHeating || climate.seat >= 0 || climate.vent >= 0;
  const locked = model.simulated ? settings.locked : model.current.locked;
  const climateOn = model.simulated ? climate.on : model.current.climateOn;
  const trunk = model.simulated ? settings.trunk : model.current.trunkOpen;
  const shadeOpen = model.simulated ? settings.shade : model.current.sunshadeOpen;
  const reportedWindow = model.current.windowOpen;
  const preciseWindow = reportedWindowPosition(current.windowPercent);
  const windowPosition = model.simulated ? settings.window : reportedWindow === null ? 'unknown' :
    reportedWindow ? preciseWindow && preciseWindow !== 'closed' ? preciseWindow : 'open' : 'closed';
  const window = windows[windowPosition];
  const windowOpen = windowPosition !== 'closed' && windowPosition !== 'unknown';
  const lockTitle = locked === false ? '上锁车门' : '解锁车门';
  const climateTitle = climateOn ? '关闭空调' : '开启空调';
  const trunkTitle = trunk ? '关闭后备箱' : '打开后备箱';
  function patch(update: Partial<typeof initial>) {
    const id = model.vehicleId;
    const apply = (records: VehicleSettings) => ({ ...records, [id]: { ...(records[id] ?? initial), ...update } });
    if (nativeDemo) {
      const next = apply(readDemoControls());
      saveSetting(demoStorage, next);
      setDemoSettings(next);
    } else setSettings(apply);
  }
  function applyPreparation(preset: PreparationPreset) { patch(preparationSettings(climate, preset)); }
  useEffect(() => {
    if (!model.booted || !nativeDemo) { setDemoLoaded(false); return; }
    let mounted = true;
    const apply = async () => {
      const effects = await widgetBridge.takeDemo().catch(() => []);
      const next = readDemoControls();
      if (effects.length) {
        for (const { vehicleId, action, preset } of effects) {
          const before = next[vehicleId] ?? initial;
          if (action === 'lock-only') next[vehicleId] = { ...before, locked: true };
          if (action === 'climate-on' || action === 'climate-off') next[vehicleId] = { ...before, climate: { ...before.climate, on: action === 'climate-on' } };
          if (action === 'window-close' || action === 'window-vent') next[vehicleId] = { ...before, window: action === 'window-close' ? 'closed' : 'vent' };
          const selected = quickClimatePreset(action);
          if (selected) next[vehicleId] = { ...before, climate: { ...before.climate, ...selected[2], on: true, preset: selected[0] } };
          if (preset && (action === 'prepare' || action === 'prepare-2')) next[vehicleId] = { ...before, ...preparationSettings(before.climate, preset) };
        }
        saveSetting(demoStorage, next);
      }
      if (mounted) { setDemoSettings(next); setDemoLoaded(true); }
    };
    const visible = () => { if (!document.hidden) void apply(); };
    visible();
    const changed = (event: StorageEvent) => {
      if (event.key === 'leapmore.' + demoStorage) setDemoSettings(readDemoControls());
    };
    globalThis.addEventListener('storage', changed);
    const listener = NativeApp.addListener('appStateChange', e => { if (e.isActive) visible(); });
    document.addEventListener('visibilitychange', visible);
    globalThis.addEventListener('focus', visible);
    return () => { mounted = false; globalThis.removeEventListener('storage', changed); void listener.then(l => l.remove()).catch(() => {}); document.removeEventListener('visibilitychange', visible); globalThis.removeEventListener('focus', visible); };
  }, [model.mode, model.booted]);
  function toggleSentry(on: boolean, stillRequested?: () => boolean, onComplete?: () => void) {
    cmd.ask({ kind: 'sentry', title: (on ? '开启' : '关闭') + '哨兵模式', icon: 'shield',
      stillRequested, onComplete, description: stillRequested ? '检测到本次驻车的哨兵模式已关闭。' : onComplete ? '同时关闭这辆车的「一直启动哨兵模式」。' : undefined,
      remote: { kind: 'sentry', on, ...(stillRequested && { onlyWhenParkedOff: true }) }, apply: () => patch({ sentry: on }) });
  }
  function setDoorLock(target: boolean) {
    cmd.ask({ kind: 'lock', title: target ? '上锁车门' : '解锁车门', icon: target ? 'doorLock' : 'doorUnlock',
      description: target ? '请确认已带出钥匙。' : undefined, remote: { kind: 'lock', locked: target }, apply: () => patch({ locked: target }) });
  }
  function lock() { setDoorLock(locked === false); }
  function toggleTrunk() {
    cmd.ask({ kind: 'trunk', title: trunkTitle, icon: trunk ? 'tailgate' : 'tailgateOpen',
      description: '请确认车后无人、无遮挡。', remote: { kind: 'trunk', open: !trunk }, apply: () => patch({ trunk: !trunk }) });
  }
  function setWindow(position: WindowChoice) {
    setSheet(null);
    const target = windows[position];
    cmd.ask({ kind: 'window', title: target.command, icon: target.icon,
      description: '请确认车窗周围无遮挡。', remote: { kind: 'window', position }, apply: () => patch({ window: position }) });
  }
  function shade() {
    cmd.ask({ kind: 'shade', title: shadeOpen ? '关闭遮阳帘' : '打开遮阳帘', icon: shadeOpen ? 'roofShade' : 'roofShadeOpen',
      remote: { kind: 'shade', open: !shadeOpen }, apply: () => patch({ shade: !shadeOpen }) });
  }
  function setClimatePower(on: boolean) {
    cmd.ask({ kind: 'climate', title: on ? '开启空调' : '关闭空调', icon: 'climateFan',
      description: on && !model.simulated ? `制冷 · ${climate.temp}℃ · 风量 ${climate.fan} 档` : undefined,
      remote: { ...climate, kind: 'climate', on, preset: false },
      apply: () => patch({ climate: { ...climate, on } }) });
  }
  function toggleClimate() { setClimatePower(!climateOn); }
  function sendClimate(update: Partial<Climate>, description: string, after?: () => void) {
    const target = { ...climate, ...update, preset: '' };
    cmd.ask({ kind: 'climate', title: '发送空调设置', icon: 'climateFan', description,
      remote: { ...target, kind: 'climate', on: true, preset: false },
      apply: () => patch({ climate: target }), onComplete: after });
  }
  function preset(p: (typeof presets)[number]) {
    setSheet(null);
    cmd.ask({ kind: 'climate', title: '启用' + p[0], icon: p[1],
      remote: { kind: 'climate', on: true, ...p[2], preset: true },
      apply: () => patch({ climate: { ...climate, on: true, ...p[2], preset: p[0] } }) });
  }
  function seat(key: 'seat' | 'vent', n: number) {
    if (climate[key] < 0) return;
    setSheet(null);
    cmd.ask({ kind: 'seat', title: key === 'seat' ? '主驾座椅加热' : '主驾座椅通风', icon: 'seatComfort',
      description: n ? '设为 ' + n + ' 档' : '关闭', remote: { kind: 'seat', feature: key, level: n },
      apply: () => patch({ climate: { ...climate, [key]: n } }) });
  }
  function toggleHeater(feature: CabinHeater) {
    const currentState = heating[feature];
    if (currentState === null) return;
    setSheet(null);
    const { title, icon } = cabinHeaters[feature];
    const on = !currentState;
    cmd.ask({ kind: 'cabinHeat', title: (on ? '开启' : '关闭') + title, icon,
      remote: { kind: 'cabinHeat', feature, on }, apply: () => patch({ [feature]: on }) });
  }
  function charging(update: Partial<typeof initial>, title: string, description?: string, onComplete?: () => void) {
    const { limit, schedule, start, end, days, health } = update;
    const remote: RemoteCommand = health !== undefined ? { kind: 'charge', health } :
      { kind: 'charge', plan: { limit, enabled: schedule, start, end, days } };
    cmd.ask({ kind: 'charge', title, icon: 'plug', description, remote, onComplete, apply: () => patch(update) });
  }
  function find() { cmd.ask({ kind: 'find', title: '鸣笛寻车', icon: 'carHorn', description: '车辆将闪灯并鸣笛。', remote: { kind: 'find' } }); }
  return { ...cmd, demoControlsReady, settings, toggleSentry, applyPreparation, setDoorLock, setClimatePower, climate, targetTemp, heating, hasCabinHeating, hasComfort, toggleHeater, sheet, setSheet, locked, lockTitle, climateOn, climateTitle, trunk, trunkTitle,
    window, windowPosition, windowOpen, shadeOpen, lock, toggleTrunk, setWindow, shade, toggleClimate, sendClimate, preset, seat, charging, find };
}
const Controls = createContext<ReturnType<typeof useControlsModel> | null>(null);
export const useVehicleControls = () => useContext(Controls)!;

export function CabinHeatingRows() {
  const c = useVehicleControls();
  const disabled = !!c.reason('cabinHeat');
  return heaterKeys.map(feature => {
    const checked = c.heating[feature];
    if (checked === null) return null;
    const { title, icon } = cabinHeaters[feature];
    return <div className="cRow" key={feature}>
      <span className="cIC"><Icon name={icon} size={18} /></span><span className="cL">{title}</span>
      <span className="cC"><Switch checked={checked} action={() => c.toggleHeater(feature)} label={title} disabled={disabled} /></span>
    </div>;
  });
}

export function ControlsProvider({ children }: { children: ReactNode }) {
  const c = useControlsModel();
  const { name } = useModelContext();
  const close = () => c.setSheet(null);
  return <Controls.Provider value={c}>
    {children}
    {c.sheet === 'windows' && <Sheet title="车窗" sub={name + ' · 四窗'} close={close} showClose>
      {windowChoices.map(position =>
        <Row icon={windows[position].icon} title={windows[position].label} key={position}
          right={c.windowPosition === position ? '当前' : undefined} onClick={() => c.setWindow(position)} />)}
    </Sheet>}
    {c.sheet === 'seat' && c.hasComfort && <Sheet title="座椅与加热" sub={name} close={close} showClose>
      <div className="seat-options">
        {([['seat', '主驾座椅加热', 'seat'], ['vent', '主驾座椅通风', 'wind']] as const).map(([key, title, icon]) =>
          c.climate[key] >= 0 && <div className="cRow seat-option" key={key}>
            <span className="cIC"><Icon name={icon} size={18} /></span><span className="cL">{title}</span>
            <Seg options={seatLevels} current={c.climate[key]} choose={v => c.seat(key, v)} label={title} />
          </div>)}
        <CabinHeatingRows />
      </div>
    </Sheet>}
    {c.sheet === 'presets' && <Sheet title="空调预设" close={close} showClose><div className="preset-grid">{presets.map(p =>
      <button className={'preset-chip' + (c.settings.climate.preset === p[0] ? ' on' : '')} key={p[0]} onClick={() => c.preset(p)}>
        <span className="ic"><Icon name={p[1]} size={18} /></span>{p[0]}</button>)}</div></Sheet>}
  </Controls.Provider>;
}

export function QuickButton({ icon, label, title, status, active, onClick, disabled }: {
  icon: IconName; label: string; title: string; status: string; active: boolean; onClick: () => void; disabled?: boolean;
}) {
  return <div className="act" data-open={active || undefined}><button className="circ" aria-label={title} aria-description={status}
    title={status} disabled={disabled} onClick={onClick}><Icon name={icon} size={25} /></button><span className="act-label">{label}</span></div>;
}
