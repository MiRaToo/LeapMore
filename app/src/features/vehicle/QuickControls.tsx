import { useEffect, useReducer, useRef, useState } from 'react';
import { useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { useModelContext } from '../context';
import { useQuery } from '@tanstack/react-query';
import { AppBar, Row, Section, Sheet } from '../../ui/components';
import { permitsCommand, preparationContent, allowsPreparationContent } from '../../data/cloud/preparation';
import { readSetting, saveSetting } from '../../data/localDatabase';
import { widgetBridge } from '../../platform/widgets';
import { Capacitor } from '@capacitor/core';
import { applyRecordingShortcut, supportsManualTrips, usePendingRecordingShortcut } from '../../platform/iosTrip';
import { loadPreparationPresets, presetSummary } from './PreparationPresets';
import { useVehicleControls } from './controls';

import { quickClimatePreset } from '../../data/cloud/climatePresets';

const slots = {
  prepare: '一键备车', 'climate-on': '开启空调', 'climate-off': '关闭空调', 'lock-only': '锁车', find: '鸣笛寻车', 'window-close': '关闭车窗', 'window-vent': '车窗通风',
  'climate-cool': '极速降温', 'climate-heat': '极速升温', 'climate-vent': '快速除味', 'climate-def': '风挡除霜', 'prepare-2': '一键备车 2',
} as const;
type Slot = keyof typeof slots;
const groups = [
  { title: '备车', slots: ['prepare', 'prepare-2'] },
  { title: '空调', slots: ['climate-on', 'climate-off', 'climate-cool', 'climate-heat', 'climate-vent', 'climate-def'] },
  { title: '车窗', slots: ['window-close', 'window-vent'] },
  { title: '车锁与寻车', slots: ['lock-only', 'find'] },
] as const satisfies readonly { title: string; slots: readonly Slot[] }[];
const slotNames = Object.keys(slots) as Slot[];
const validSlot = (key: string | null): key is Slot => !!key && Object.hasOwn(slots, key);
const prepareSlot = (slot: Slot) => slot === 'prepare' || slot === 'prepare-2';
type Bindings = Partial<Record<Slot, string>>;
const bindingKey = 'quick-control-bindings';
const changed = 'quick-controls-changed';

function useQuickTargets() {
  const m = useModelContext();
  const [, invalidate] = useReducer(n => n + 1, 0);
  useEffect(() => {
    window.addEventListener(changed, invalidate);
    window.addEventListener('storage', invalidate);
    return () => { window.removeEventListener(changed, invalidate); window.removeEventListener('storage', invalidate); };
  }, []);
  const cars = m.booted && !m.expired && (m.mode === 'demo' || m.mode === 'cloud') ? m.vehicles : [];
  return cars.map(car => {
    const key = [m.profileScope, car.id, car.vin];
    const title = m.localVehicleName(car) || car.nickname || car.model;
    const id = JSON.stringify(key);
    const presets = loadPreparationPresets(readSetting('preparation-presets:' + m.profileScope + ':' + car.id, null), car).presets;
    return { id, title, car, presets: presets.map(preset => ({ id: JSON.stringify([...key, preset.id]), title: preset.name, preset })) };
  });
}

export function PublishQuickControls() {
  const m = useModelContext();
  const cars = useQuickTargets();
  const bindings = readSetting<Bindings>(bindingKey, {});
  const demoBlocked = m.simulated ? (m.debug.driving ? '行驶中，请停车后再试' :
    m.scenario === 'offline' ? '车辆离线' : m.scenario === 'pending' ? '车辆未确认' : undefined) : undefined;
  const targets = cars.flatMap(car => [
    { id: car.id, title: car.title, preset: false, demoBlocked, demoControl: m.simulated ? m.grants.control : undefined },
    ...car.presets.map(p => ({ id: p.id, title: car.title + ' · ' + p.title, preset: true, definition: p.preset, demoBlocked: m.simulated && !m.grants.control ? '车辆控制未授权' : demoBlocked })),
  ]);
  const tiles = Object.fromEntries(slotNames.flatMap(slot => {
    const target = targets.find(t => t.id === bindings[slot] && t.preset === prepareSlot(slot));
    return target ? [[slot, target]] : [];
  }));
  const payload = JSON.stringify({ targets, tiles });
  useEffect(() => { if (m.booted) void widgetBridge.publishQuick(JSON.parse(payload)); }, [payload, m.booted]);
  const request = usePendingRecordingShortcut();
  const handled = useRef('');
  useEffect(() => {
    if (!request || handled.current === request.id || !m.booted) return;
    const car = cars.find(car => car.id === request.target);
    const recorder = m.manualTrip;
    let issue: string | undefined;
    if (!car) issue = '绑定的车辆已不可用，请重新选择车辆';
    else if (car.car.id !== m.vehicleId) { m.setVehicleId(car.car.id); return; }
    else if (!m.usesPhone) issue = '请先在记录数据源中启用手机记录';
    else if (!m.grants.mileage || !recorder.available) issue = '当前账号没有这辆车的记录权限';
    else if (recorder.busy || !recorder.state && !recorder.issue) return;
    else if (!recorder.state) issue = recorder.issue;
    else if (recorder.active && recorder.state.vehicleId !== car.car.id) issue = '正在记录另一辆车，请先结束该车的记录';
    handled.current = request.id;
    const binding = 'binding' in recorder ? recorder.binding : undefined;
    void applyRecordingShortcut(request, m.simulated, issue, binding).then(() => {
      if ('setDemoRecording' in recorder) recorder.setDemoRecording(request.start);
    }).catch(() => {}); // The native intent returns the error to Shortcuts.
  }, [request, m, cars]);
  return null;
}

export function QuickControlSettings() {
  const cars = useQuickTargets();
  const [params, setParams] = useSearchParams();
  const editing = params.get('slot');
  const [bindings, setBindings] = useState(() => readSetting<Bindings>(bindingKey, {}));
  const [notice, setNotice] = useState('');
  const ios = Capacitor.getPlatform() === 'ios';
  function bind(slot: Slot, id: string) {
    const next = { ...readSetting<Bindings>(bindingKey, {}), [slot]: id };
    saveSetting(bindingKey, next);
    setBindings(next);
    window.dispatchEvent(new Event(changed));
  }
  return <><AppBar title="快捷控制" back="/mine" /><div className="page no-nav">
    {ios && <Section><Row icon="spark" title="打开快捷指令" sub="iOS 16 起，添加动作时搜索 LeapMore，选择车辆或备车预设。"
      onClick={() => { void widgetBridge.openShortcuts().catch(() => setNotice('请先安装 Apple 的「快捷指令」App。')); }} /></Section>}
    {groups.map(group => <Section key={group.title} title={group.title}>{group.slots.filter(slot => !ios || slot !== 'prepare-2').map(slot => {
      const car = cars.find(car => prepareSlot(slot) ? car.presets.some(p => p.id === bindings[slot]) : car.id === bindings[slot]);
      const preset = car?.presets.find(p => p.id === bindings[slot]);
      return <Row key={slot} title={slots[slot]} sub={ios ? undefined : car ? [car.title, preset?.title].filter(Boolean).join(' · ') : '选择绑定车辆'}
        icon={prepareSlot(slot) ? 'spark' : slot === 'find' ? 'carHorn' : slot === 'lock-only' ? 'doorLock' : slot.startsWith('window-') ? 'sideWindowOpen' : quickClimatePreset(slot)?.[1] ?? 'climateFan'}
        onClick={ios ? undefined : () => { setNotice(''); setParams({ slot }); }} />;
    })}</Section>)}
    {ios && supportsManualTrips() && <Section title="手机记录"><Row icon="route" title="开始记录行程和充电" /><Row icon="route" title="结束记录行程和充电" /></Section>}
    <p className="tiny muted">{ios ? '快捷指令和控制中心使用绑定车辆的控车设置。' : '磁贴按绑定车辆的控车设置执行。'}选择「发送前不确认」并保存操作密码后，点击即发送。</p>
    {notice && <p role="status">{notice}</p>}
    {!ios && validSlot(editing) && <Sheet title={slots[editing]} close={() => setParams({}, { replace: true })} showClose>
      {cars.length === 0 && <p>请先登录并添加车辆。</p>}
      {cars.map(car => prepareSlot(editing) ? <Section key={car.id} title={car.title}>
        {car.presets.length === 0 && <p>请先为这辆车创建备车预设。</p>}
        {car.presets.map(p => <Row key={p.id} icon="spark" title={p.title} right={bindings[editing] === p.id ? '已绑定' : undefined} onClick={() => bind(editing, p.id)} />)}
      </Section> : <Row key={car.id} icon="car" title={car.title} right={bindings[editing] === car.id ? '已绑定' : undefined} onClick={() => bind(editing, car.id)} />)}
      {bindings[editing] && <button className="btn secondary" onClick={async () => {
        try { setNotice(await widgetBridge.addTile(editing)); } catch { setNotice('可在系统快捷设置的编辑面板添加磁贴。'); }
        setParams({}, { replace: true });
      }}>添加到快捷设置</button>}
    </Sheet>}
  </div></>;
}

export function QuickAction() {
  const m = useModelContext();
  const c = useVehicleControls();
  const cars = useQuickTargets();
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const handled = useRef(false);
  const slot = params.get('action'), id = params.get('target');
  const car = validSlot(slot) && cars.find(car => prepareSlot(slot) ? car.presets.some(p => p.id === id) : car.id === id);
  const preset = car && car.presets.find(p => p.id === id)?.preset;
  const launch = useLocation().key;
  const checkPower = m.mode === 'cloud' && !!car && car.car.id === m.vehicleId &&
    (slot === 'lock-only' || slot === 'climate-on' || slot === 'climate-off');
  const report = useQuery({
    queryKey: ['quick-control-state', launch, id], enabled: checkPower,
    queryFn: async () => (await m.readVehicleReport()) ?? null,
    staleTime: Infinity, gcTime: 0, retry: false, refetchOnWindowFocus: false, networkMode: 'always',
  });
  useEffect(() => {
    if (handled.current || !m.booted) return;
    function finish(note?: string) {
      handled.current = true;
      if (note) m.setToast(note);
      navigate('/home', { replace: true });
    }
    if (!validSlot(slot) || !car) { finish('绑定的车辆或预设已不可用，请重新配置快捷控制。'); return; }
    if (c.command || c.step) { finish('请先完成当前控车操作。'); return; }
    if (m.vehicleId !== car.car.id) { m.setVehicleId(car.car.id); return; }
    if (m.mode === 'cloud' && !m.controlStateReady && m.scenario !== 'offline') return;
    if (checkPower && report.isPending) return;
    if (checkPower && !report.data) { finish('无法读取绑定车辆的车况，请稍后重试。'); return; }
    const recent = m.simulated || (report.data?.vehicleId === m.vehicleId &&
      Date.now() - (report.data?.reportedAt ?? report.data?.updatedAt ?? 0) < 90_000);
    const selectedClimate = quickClimatePreset(slot);
    const kind = prepareSlot(slot) ? 'prepare' : slot === 'lock-only' ? 'lock' : slot === 'find' ? 'find' : slot.startsWith('window-') ? 'window' : 'climate';
    const blocked = c.reason(kind);
    if (blocked) { finish(blocked[0]); return; }
    if (kind === 'prepare' && preset) {
      const content = preparationContent(preset, car.car);
      if (!permitsCommand(car.car, 360) || !allowsPreparationContent(car.car, content, false, m.canSee('location'))) {
        finish('这辆车不支持所选备车预设。'); return;
      }
      void c.ask({ kind, title: '立即备车', icon: 'spark', description: preset.name + ' · ' + presetSummary(preset),
        remote: { kind, content }, apply: () => c.applyPreparation(preset) });
    } else if (slot === 'lock-only') {
      if (recent && (m.simulated ? c.locked : report.data?.locked) === true) { finish('车辆已上锁'); return; }
      c.setDoorLock(true);
    } else if (slot === 'find') c.find();
    else if (kind === 'window') c.setWindow(slot === 'window-close' ? 'closed' : 'vent');
    else if (selectedClimate) c.preset(selectedClimate);
    else if (kind === 'climate') {
      const on = slot === 'climate-on';
      if (recent && (m.simulated ? c.climateOn : report.data?.climateOn) === on) { finish(on ? '空调已开启' : '空调已关闭'); return; }
      c.setClimatePower(on);
    }
    finish();
  }, [m, c, car, preset, slot, navigate, checkPower, report.data, report.isPending]);
  return <p className="loading">正在读取绑定车辆…</p>;
}
