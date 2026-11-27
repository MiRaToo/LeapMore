import type { Vehicle } from '../types';
import type { Destination } from './remote';
import { findClimatePreset } from './climatePresets.ts';
import type { PreparationClimate } from './climatePresets';
import { encodeRemote, RemoteCommandError } from './remote.ts';

export type PreparationPreset = {
  id: string; name: string; destination: Destination | null;
  climate: boolean; climatePreset?: PreparationClimate; temperature: number; fan: number;
  seat: 'none' | 'heat' | 'vent'; steering: boolean; mirrors: boolean;
};
export type PreparationContent = Record<string, unknown>;
export type PreparationPlan = {
  set_id: string; start_time: string; days: number[] | null; enable: boolean;
  datacontent: PreparationContent; name?: string | null; [key: string]: unknown;
};
export type PreparationEdit =
  | { action: 'save'; previous?: PreparationPlan; time: string; days: number[]; preset?: { name: string; content: PreparationContent } }
  | { action: 'toggle' | 'delete'; previous: PreparationPlan };

export const preparationKey = (scope: string) => ['cloud', 'preparation-schedules', scope] as const;
export const permitsCommand = (vehicle: Vehicle, id: number) =>
  !vehicle.commandRights?.length || vehicle.commandRights.includes(String(id));
export const permitsFeature = (vehicle: Vehicle, id: number) =>
  !vehicle.abilities?.length || vehicle.abilities.includes(String(id));
// The preparation editor uses the navigation module (30). Some cars list the standalone send command (180).
export const permitsPreparationNavigation = (vehicle: Vehicle) => permitsFeature(vehicle, 30) || permitsFeature(vehicle, 180);
export const preparationModules = {
  syn_path: 180, air_condition: 170, seat_setting: 301, steeringWheelHeatCtrl: 320, rearMirrorHeating: 440,
} as const;
export function allowsPreparationContent(vehicle: Vehicle, content: PreparationContent, scheduled: boolean, location: boolean) {
  return Object.keys(content).length > 0 && (!content.syn_path || location) &&
    Object.entries(preparationModules).every(([key, id]) => !content[key] || (key === 'syn_path' ? permitsPreparationNavigation(vehicle) : permitsFeature(vehicle, scheduled && id === 170 ? 171 : id)));
}

export function preparationContent(preset: PreparationPreset, vehicle: Vehicle): PreparationContent {
  const content: PreparationContent = {};
  const dest = preset.destination;
  if (dest) {
    if (!dest.name.trim() || !Number.isFinite(dest.lat) || Math.abs(dest.lat) > 90 || !Number.isFinite(dest.lon) || Math.abs(dest.lon) > 180) {
      throw new RemoteCommandError('请选择有坐标的导航目的地。');
    }
    content.syn_path = { enable: true, addressname: dest.name, address: dest.address, addresskey: dest.poiId ?? '',
      latitude: String(dest.lat), longitude: String(dest.lon), linenum: '0' };
  }
  if (preset.climate) {
    const selected = findClimatePreset(preset.climatePreset);
    if (selected) {
      const settings = selected[2];
      const { state } = encodeRemote({ kind: 'climate', on: true, preset: true, ...settings });
      content.air_condition = { ...state as object, enable: true, windlevel: String(settings.fan) };
    } else {
      if (!Number.isInteger(preset.temperature) || preset.temperature < 16 || preset.temperature > 32 ||
          !Number.isInteger(preset.fan) || preset.fan < 1 || preset.fan > 7) throw new RemoteCommandError('请选择有效的空调温度与风量。');
      const modern = vehicle.abilities?.includes('12');
      content.air_condition = { enable: true, operate: 'manual', mode: modern || vehicle.carType === 'T03' ? 'nohotcold' : '',
        temperature: String(preset.temperature), windlevel: String(preset.fan), circle: 'out' };
    }
  }
  if (preset.seat !== 'none') content.seat_setting = { enable: true, isHeat: preset.seat === 'heat', left_front: preset.seat === 'heat' ? '3' : '13',
    right_front: '0', left_rear: '0', right_rear: '0', left_third: '0', right_third: '0' };
  if (preset.steering) content.steeringWheelHeatCtrl = { enable: true, value: '2' };
  if (preset.mirrors) content.rearMirrorHeating = { enable: true, value: '2' };
  return content;
}

const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const validDays = (v: unknown): v is number[] => Array.isArray(v) && v.every(d => Number.isInteger(d) && d >= 0 && d <= 6) && new Set(v).size === v.length;
const validTime = (value: string) => /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value);
export function readPreparationPlans(data: unknown): PreparationPlan[] {
  const invalid = () => new RemoteCommandError('无法识别预约备车列表，请重新读取。');
  if (data === null || data === '') return [];
  if (typeof data === 'string') {
    try { data = JSON.parse(data); } catch { throw invalid(); }
  }
  if (!object(data) || !Array.isArray(data.controls)) throw invalid();
  const ids = new Set<string>();
  return data.controls.map((row: unknown) => {
    if (!object(row) || typeof row.set_id !== 'string' || !row.set_id || ids.has(row.set_id) ||
      typeof row.start_time !== 'string' || !/^\d{4}-\d\d-\d\d [\d:]{8}$/.test(row.start_time) ||
      !Number.isFinite(Date.parse(row.start_time.replace(' ', 'T'))) || !validTime(row.start_time.slice(11, 16)) ||
      !(row.days === null || validDays(row.days)) || typeof row.enable !== 'boolean' || !object(row.datacontent)) throw invalid();
    ids.add(row.set_id);
    return row as PreparationPlan;
  });
}

function sameRecord(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((item, i) => sameRecord(item, b[i]));
  return object(a) && object(b) && Object.keys(a).length === Object.keys(b).length && Object.keys(a).every(key => sameRecord(a[key], b[key]));
}
export function planExpired(plan: PreparationPlan, now = Date.now()) {
  return !plan.days?.length && Date.parse(plan.start_time.replace(' ', 'T')) <= now;
}
function nextStart(time: string, days: number[], now: number) {
  const [hour, minute] = time.split(':').map(Number);
  const date = new Date(now);
  date.setHours(hour, minute, 0, 0);
  if (+date <= now) date.setDate(date.getDate() + 1);
  while (days.length && !days.includes(date.getDay())) date.setDate(date.getDate() + 1);
  const two = (n: number) => String(n).padStart(2, '0');
  return date.getFullYear() + '-' + two(date.getMonth() + 1) + '-' + two(date.getDate()) + ' ' + time + ':00';
}

export function applyPreparationEdit(plans: PreparationPlan[], edit: PreparationEdit, vin: string, now = Date.now()) {
  const previous = edit.previous;
  const existing = plans.find(plan => plan.set_id === previous?.set_id);
  if (previous && !sameRecord(existing, previous)) throw new RemoteCommandError('这条预约已变更，请重新读取后再操作。');
  if (!previous && plans.length >= 5) throw new RemoteCommandError('每辆车最多可保存 5 条预约备车。');
  const id = existing?.set_id ?? vin + '_' + now;
  let target: PreparationPlan | null = null;
  if (edit.action === 'save') {
    if (!validTime(edit.time) || !validDays(edit.days)) throw new RemoteCommandError('请选择有效的时间与重复日期。');
    const content = edit.preset?.content ?? existing?.datacontent;
    if (!content || !Object.keys(content).length) throw new RemoteCommandError('请选择至少包含一项操作的预设。');
    const originalDate = existing && !existing.days?.length && !edit.days.length
      ? existing.start_time.slice(0, 11) + edit.time + ':00' : '';
    const start = Date.parse(originalDate.replace(' ', 'T')) > now ? originalDate : nextStart(edit.time, edit.days, now);
    target = { ...existing, set_id: id, enable: true, update_time: String(now), start_time: start,
      days: edit.days, name: edit.preset?.name ?? existing?.name ?? null, datacontent: content };
  } else if (edit.action === 'toggle' && existing) {
    const expired = planExpired(existing, now);
    target = { ...existing, enable: expired || !existing.enable, update_time: String(now),
      start_time: expired ? nextStart(existing.start_time.slice(11, 16), [], now) : existing.start_time };
  }
  const controls = plans.flatMap(plan => plan.set_id === id ? target ? [target] : [] : [plan]);
  if (!existing && target) controls.push(target);
  return { controls, id, target };
}

export function confirmsPreparation(plans: PreparationPlan[], edit: { id: string; target: PreparationPlan | null }) {
  const saved = plans.find(plan => plan.set_id === edit.id);
  const target = edit.target;
  return target ? !!saved && saved.enable === target.enable && saved.start_time === target.start_time &&
    sameRecord(saved.days ?? [], target.days ?? []) && sameRecord(saved.datacontent, target.datacontent) : !saved;
}
