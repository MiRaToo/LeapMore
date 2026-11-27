import { Capacitor, registerPlugin, type PluginListenerHandle } from '@capacitor/core';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import type { Frame } from '../data/ha/measurements';
import type { CarState, Vehicle } from '../data/types';
import { loadCloudSession } from '../features/account/session';

type Binding = { account: string; id: string; vin: string; name: string };
type Reading = { ownsSampling: boolean; report?: CarState; reportVersion?: number };
type State = Reading & { phase: 'idle' | 'starting' | 'recording' | 'ended' | 'interrupted'; scope: string; vehicle: string; vehicleId: string; lastSample: number; note: string };
type Config = { account: string; cars: { id: string; vin: string; location: boolean }[] };
export type RecordingShortcut = { id: string; target: string; start: boolean };
interface TripPlugin {
  addListener(event: 'recordingShortcut', listener: () => void): Promise<PluginListenerHandle>;
  pendingShortcut(): Promise<Partial<RecordingShortcut>>;
  applyShortcut(options: { id: string; demo: boolean; issue?: string }): Promise<void>;
  configure(options: Config): Promise<void>;
  reading(car: Binding): Promise<Reading>;
  state(car: Binding): Promise<State>;
  start(car: Binding): Promise<State>;
  stop(car: Binding & { scope: string }): Promise<State>;
  batch(car: Binding): Promise<{ cursor: number; frames: Frame[] }>;
  ack(car: Binding & { cursor: number }): Promise<void>;
  clear(car: Binding): Promise<void>;
}
const plugin = registerPlugin<TripPlugin>('LeapTrip');
export const supportsManualTrips = () => Capacitor.getPlatform() === 'ios' && Capacitor.isPluginAvailable('LeapTrip');

export function usePendingRecordingShortcut() {
  const [request, setRequest] = useState<RecordingShortcut>();
  useEffect(() => {
    if (!supportsManualTrips()) return;
    let live = true;
    function refresh() {
      void plugin.pendingShortcut().then(next => {
        if (live && next.id && next.target && typeof next.start === 'boolean') {
          setRequest({ id: next.id, target: next.target, start: next.start });
        }
      }).catch(() => {});
    }
    const listener = plugin.addListener('recordingShortcut', refresh);
    void listener.then(refresh).catch(() => {});
    return () => { live = false; void listener.then(handle => handle.remove()).catch(() => {}); };
  }, []);
  return request;
}

export function applyRecordingShortcut(request: RecordingShortcut, demo: boolean, issue?: string, binding?: Binding) {
  const apply = () => plugin.applyShortcut({ id: request.id, demo, issue });
  return binding && !issue ? withVehicle(binding, apply) : apply();
}

// The demo shares one UI session across pages without giving it native sampling ownership.
export function useDemoTripRecording(vehicleId: string, name: string, phoneSource: boolean) {
  const [session, setSession] = useState<State>();
  const available = !!vehicleId && phoneSource;
  const active = available && session?.phase === 'recording';
  useEffect(() => {
    if (!available) setSession(undefined);
    if (!active) return;
    const timer = window.setInterval(() => {
      if (!document.hidden) setSession(previous => previous?.phase === 'recording' ? { ...previous, lastSample: Date.now() } : previous);
    }, 30_000);
    return () => window.clearInterval(timer);
  }, [available, active]);
  const idle: State = { vehicleId, vehicle: name, phase: 'idle', lastSample: 0, note: '', scope: vehicleId, ownsSampling: false };
  const state = active || session?.vehicleId === vehicleId ? session : idle;
  function start() {
    if (vehicleId) setSession(previous => previous?.phase === 'recording' ? previous : { ...idle, phase: 'recording', lastSample: Date.now() });
  }
  function toggle() {
    if (!available) return;
    if (active) setSession(previous => previous && { ...previous, phase: 'ended' });
    else start();
  }
  function setDemoRecording(wanted: boolean) {
    if (wanted) start();
    else setSession(previous => previous?.vehicleId === vehicleId && previous.phase === 'recording'
      ? { ...previous, phase: 'ended' } : previous);
  }
  return { available, state, active, busy: false, issue: '', start, toggle, setDemoRecording };
}

// Finish an in-flight foreground read before handing its vehicle to the recorder. Queued reads check
// ownership inside the lock, including explicit refreshes and the first read after a WebView reload.
const handoffs = new Map<string, Promise<void>>();
function withVehicle<T>(car: Binding, work: () => Promise<T>): Promise<T> {
  const scope = JSON.stringify([car.account, car.id, car.vin.toUpperCase()]);
  const next = (handoffs.get(scope) ?? Promise.resolve()).then(work);
  const done = next.then(() => {}, () => {});
  handoffs.set(scope, done);
  void done.then(() => { if (handoffs.get(scope) === done) handoffs.delete(scope); });
  return next;
}
export function readRecordingOrCloud(car: Binding, signal: AbortSignal, cached: () => CarState | undefined, read: () => Promise<CarState>) {
  return withVehicle(car, async () => {
    signal.throwIfAborted();
    const { ownsSampling, report } = await plugin.reading(car);
    signal.throwIfAborted();
    if (!ownsSampling) return read();
    const latest = report?.vehicleId === car.id ? report : cached();
    if (!latest) throw new Error('等待车辆记录的首次采样');
    return latest;
  });
}

export function useIOSTripRecording(ready: boolean, enabled: boolean, account: string, cars: Vehicle[], car: Vehicle | undefined, name: string) {
  const qc = useQueryClient();
  const supported = supportsManualTrips();
  const config = supported && ready ? JSON.stringify({ account, cars: enabled ? cars.filter(v => !v.shared || v.grants?.mileage)
    .map(v => ({ id: v.id, vin: v.vin, location: !v.shared || !!v.grants?.location })) : [] }) : '';
  const binding = supported && account && car?.vin ? { account, id: car.id, vin: car.vin, name } : undefined;
  const key = config && binding && enabled && (!car?.shared || car.grants?.mileage) ? JSON.stringify(binding) : '';
  const [view, setView] = useState<{ key: string; state: State }>();
  const [syncIssue, setSyncIssue] = useState('');
  const [issue, setIssue] = useState('');
  const [busy, setBusy] = useState(false);
  const scope = useRef(key);
  scope.current = key;
  const revision = useRef(0);
  const acting = useRef(false);
  const sync = useRef<() => void>();
  useEffect(() => {
    if (!config) return;
    let live = true, working = false;
    const car: Binding | undefined = key ? JSON.parse(key) : undefined;
    setIssue(''); setSyncIssue('');
    let configured = false;
    let version: number | undefined;
    async function refresh() {
      if (!live || working || configured && (acting.current || document.hidden)) return;
      working = true;
      const expected = revision.current;
      try {
        if (!configured) { await plugin.configure(JSON.parse(config)); configured = true; }
        if (!car || !live || document.hidden || acting.current) return;
        const state = await plugin.state(car);
        if (!live || revision.current !== expected) return;
        if (state.ownsSampling && state.report?.vehicleId === car.id && state.reportVersion !== version) {
          const report = state.report;
          qc.setQueryData<CarState>(['cloud', 'state', car.account + ':' + car.id], old =>
            (old?.reportedAt ?? old?.updatedAt ?? 0) > (report.reportedAt ?? report.updatedAt) ? old : report);
        }
        version = state.reportVersion;
        setView(prior => prior?.key === key && prior.state.scope === state.scope && prior.state.ownsSampling === state.ownsSampling &&
          prior.state.phase === state.phase && prior.state.vehicle === state.vehicle && prior.state.lastSample === state.lastSample &&
          prior.state.note === state.note ? prior : { key, state });
        setSyncIssue('');
      } catch (e) { if (live) setSyncIssue(e instanceof Error ? e.message : '无法同步车辆记录'); }
      finally { working = false; }
    }
    sync.current = refresh;
    void refresh();
    const timer = key ? window.setInterval(refresh, 2500) : undefined;
    document.addEventListener('visibilitychange', refresh);
    return () => { live = false; sync.current = undefined; clearInterval(timer); document.removeEventListener('visibilitychange', refresh); };
  }, [key, config, qc]);
  const state = key && view?.key === key ? view.state : undefined;
  const active = state?.phase === 'starting' || state?.phase === 'recording';
  async function toggle() {
    if (!binding || !key || !state || acting.current) return;
    acting.current = true; revision.current++; setBusy(true); setIssue('');
    try {
      let next: State;
      if (active) next = await plugin.stop({ ...binding, scope: state.scope });
      else {
        const started = await withVehicle(binding, async () => {
          const session = await loadCloudSession();
          if (scope.current !== key) return;
          if (session?.account.userId !== binding.account) throw new Error('请重新登录后继续');
          return plugin.start(binding);
        });
        if (!started) return;
        next = started;
      }
      if (scope.current === key) setView({ key, state: next });
    } catch (e) { if (scope.current === key) setIssue(e instanceof Error ? e.message : '无法更改车辆记录'); }
    finally { acting.current = false; setBusy(false); sync.current?.(); }
  }
  async function clear() {
    if (!binding) return;
    revision.current++;
    await plugin.clear(binding);
    setView(undefined);
  }
  return { available: !!key, key, binding, state, active, busy, toggle, issue: issue || syncIssue, clear };
}

// Drain the durable native queue on an observation or phase change and on return to the foreground.
// A failed import stays in SQLite until the IndexedDB transaction commits.
export function useIOSTripHistory(key: string, lastSample: number | undefined, phase: State['phase'] | undefined,
  importFrames: (frames: Frame[]) => Promise<void>) {
  const [issue, setIssue] = useState('');
  useEffect(() => {
    setIssue('');
    if (!key) return;
    const car: Binding = JSON.parse(key);
    let live = true, working = false, retry: number | undefined;
    async function drain() {
      if (!live || working || document.hidden) return;
      working = true;
      window.clearTimeout(retry);
      try {
        while (live) {
          const { cursor, frames } = await plugin.batch(car);
          if (!live || !frames.length) break;
          await importFrames(frames);
          await plugin.ack({ ...car, cursor });
          if (frames.length < 256) break;
        }
        if (live) setIssue('');
      } catch (e) {
        if (live) { setIssue(e instanceof Error ? e.message : '无法导入车辆采样'); retry = window.setTimeout(drain, 5000); }
      } finally { working = false; }
    }
    void drain();
    document.addEventListener('visibilitychange', drain);
    return () => { live = false; window.clearTimeout(retry); document.removeEventListener('visibilitychange', drain); };
  }, [key, lastSample, phase, importFrames]);
  return issue;
}
