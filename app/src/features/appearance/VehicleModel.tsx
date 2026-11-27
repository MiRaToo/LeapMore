import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { readDataset, readSetting, updateDataset } from '../../data/localDatabase';
import { useSetting } from '../../data/preferences';
import { failureFacts } from '../../data/serviceFailure';
import { CarPictureOnly } from '../../data/cloud/LiveClient';
import { startModelTrace, viewerDiagnosticStep } from '../../data/modelDiagnostics';
import { asset, hasLocalCarAssets } from '../../ui/components';
import { Icon } from '../../ui/Icon';
import { useModelContext } from '../context';
import type { MarketSelection } from './MarketPicker';

export type Face = 'front' | 'rear' | 'left' | 'right' | 'top';
type Pattern = 'solid' | 'stripe' | 'gradient' | 'carbon' | 'image';
export type Decoration = { kind: Pattern; color: string; endColor?: string; image?: string; x: number; y: number; scale: number; rotation: number; opacity: number };
export const slotCount = 4;
export const defaultGradientEnd = '#0d1218';
export type Wrap = Partial<Record<Face, Decoration | (Decoration | null)[]>>;
export function slotsOf(face: Wrap[Face]): (Decoration | null)[] {
  return Array.isArray(face) ? face : face ? [face] : [];
}
const emptyWrap: Wrap = {};
const sampleTextures = new Map<string, string>();

export function texture(face: Decoration) {
  if (face.image && face.kind === 'image') return face.image;
  const key = face.kind === 'carbon' ? 'carbon' : face.kind + face.color + (face.kind === 'gradient' ? face.endColor ?? defaultGradientEnd : '');
  const existing = sampleTextures.get(key);
  if (existing) return existing;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 256;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = face.color;
  if (face.kind === 'gradient') {
    const gradient = ctx.createLinearGradient(0, 0, 256, 256);
    gradient.addColorStop(0, face.color); gradient.addColorStop(1, face.endColor ?? defaultGradientEnd);
    ctx.fillStyle = gradient;
  }
  ctx.fillRect(0, 0, 256, 256);
  if (face.kind === 'carbon') {
    for (let y = 0; y < 256; y += 8) for (let x = 0; x < 256; x += 8) {
      ctx.fillStyle = ((x + y) / 8) % 2 ? '#2a3037' : '#14181d';
      ctx.fillRect(x, y, 8, 8);
    }
  }
  if (face.kind === 'stripe') {
    ctx.strokeStyle = 'rgba(255,255,255,.72)'; ctx.lineWidth = 5;
    for (let x = -256; x < 256; x += 27) {
      ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x + 256, 256); ctx.stroke();
    }
  }
  const result = canvas.toDataURL('image/png');
  if (sampleTextures.size >= 32) sampleTextures.delete(sampleTextures.keys().next().value!);
  sampleTextures.set(key, result);
  return result;
}

function useVisualPreferences() {
  const [mode, setMode] = useSetting<'3d' | '2d'>('visualMode', '3d');
  const [background, setBackground] = useSetting('visualBackground', 'auto');
  const [quality, setQuality] = useSetting('visualQuality', 'high');
  const { vehicleId, setToast } = useModelContext();
  const queryClient = useQueryClient();
  const key = 'vehicle-wrap:' + vehicleId;
  const legacy = () => readSetting<Record<string, Wrap>>('wrap', {})[vehicleId] ?? emptyWrap;
  const savedWrap = useQuery({ queryKey: [key], enabled: !!vehicleId, staleTime: Infinity,
    queryFn: async () => (await readDataset<Wrap>(key)) ?? legacy() });
  function setWrap(change: (previous: Wrap) => Wrap) {
    if (!savedWrap.isSuccess) { setToast('车衣尚未读取，请稍后重试'); void savedWrap.refetch(); return; }
    queryClient.setQueryData<Wrap>([key], previous => change(previous ?? emptyWrap));
    void updateDataset<Wrap>(key, previous => change(previous ?? legacy())).catch(() => {
      setToast('车衣未能保存到本机，请检查可用空间');
      void queryClient.invalidateQueries({ queryKey: [key] });
    });
  }
  const [marketByVehicle, setMarketByVehicle] = useSetting<Record<string, MarketSelection>>('visualMarket', {});
  return { mode, setMode, background, setBackground, quality, setQuality, wrap: savedWrap.data ?? emptyWrap, setWrap, marketByVehicle, setMarketByVehicle };
}

const Preferences = createContext<ReturnType<typeof useVisualPreferences> | null>(null);
export function VehicleVisualProvider({ children }: { children: ReactNode }) {
  return <Preferences.Provider value={useVisualPreferences()}>{children}</Preferences.Provider>;
}

export function useVehicleVisual(paused = false, visible = true, diagnostic = false) {
  const m = useModelContext();
  const { mode: preferredMode, setMode, background, setBackground, quality, setQuality, wrap, setWrap, marketByVehicle, setMarketByVehicle } = useContext(Preferences)!;
  const mode = diagnostic ? '3d' : preferredMode;
  const saved = marketByVehicle[m.vehicleId];
  // Earlier demo selections sometimes stored a C10 illustration for another model.
  const market = saved?.image?.endsWith('/c10.png') && saved.model !== 'C10' ? undefined : saved;
  const modelName = m.vehicle?.model ?? '零跑';
  const queryKey = ['cloud', '3d', m.cloudKey] as const;
  const cloud = useQuery({ queryKey, enabled: visible && mode === '3d' && !!m.client && !!m.vehicleId && !paused && !m.expired,
    queryFn: async ({ signal }) => {
      const trace = startModelTrace(m.cloudKey);
      try {
        const { prepareCloud3D } = await import('../../data/cloud/cloud3d');
        const result = await prepareCloud3D(m.client!, m.vehicleId, undefined, signal, (step, facts) => {
          if (!signal.aborted) trace(step, facts);
        }, diagnostic);
        signal.throwIfAborted();
        trace('prepared');
        return { ...result, trace };
      } catch (error) {
        if (signal.aborted) trace('cancelled');
        else trace('failed', failureFacts(error));
        throw error;
      }
    }, retry: false, staleTime: Infinity });
  const autoPicture = !paused && !diagnostic && mode === '3d' && !cloud.data && cloud.error instanceof CarPictureOnly;
  const photo = useQuery({ queryKey: ['cloud', 'car-picture', m.cloudKey], enabled: visible && (mode === '2d' || autoPicture) && !!m.client && !!m.vehicleId && !m.expired,
    queryFn: () => m.client!.getCarPicture(m.vehicleId), retry: false, staleTime: 600_000 });
  const localViewer = __LEAPMORE_LOCAL_3D__ && m.simulated && modelName === 'C10'
    ? import.meta.env.BASE_URL + 'car3d-demo/view.html?' + new URLSearchParams({
      car: 'C10', year: '2026', trim: '605激光雷达版', color: '2', seat: '5', radius: '19', offset: '.44',
    }) : '';
  const colors = cloud.data?.colors ?? [];
  const factoryPaint = colors.find(row => row.tsp === new URLSearchParams(cloud.data?.params).get('color'));
  const paint = !m.hasCustomPaint && factoryPaint ? factoryPaint : m.paint;
  const fallback = !autoPicture && hasLocalCarAssets && ['C10', 'B10'].includes(modelName) ? asset(modelName === 'B10' ? 'b10.png' : 'c10.png') : '';
  const officialImage = photo.data?.startsWith('https://') ? photo.data : '';
  const marketImage = mode === '2d' ? market?.image : undefined;
  const image = marketImage || officialImage || fallback;
  const scene = background === 'auto' ? m.colorScheme === 'dark' ? 'night' : 'day' : background;
  return { mode, setMode, background, scene, colorScheme: m.colorScheme, setBackground, quality, setQuality, wrap, setWrap, market, modelName, queryKey,
    setMarket: (next: MarketSelection) => setMarketByVehicle(previous => ({ ...previous, [m.vehicleId]: next })),
    paint, colors, image, fallback: marketImage ? undefined : fallback, cloud, visible, autoPicture, fetchingPhoto: photo.isFetching,
    paintOverride: m.hasCustomPaint || m.simulated ? m.paint.hex : '',
    viewer: mode === '3d' && !paused ? cloud.data?.url ?? localViewer : '' };
}

export type ModelStatus = 'loading' | 'full' | 'unavailable' | '2d';

type OrbitMessage = { t: 'orbit'; azimuth: number; pitch: number; zoom: number } |
  { t: 'orbit-release'; azimuth: number; pitch: number } | { t: 'orbit-stop' } | { t: 'orbit-reset'; animate: boolean };
type PointerSample = { x: number; y: number; at: number };

function OrbitSurface({ home, send }: { home: boolean; send: (message: OrbitMessage) => void }) {
  const surface = useRef<HTMLDivElement>(null);
  const pointers = useRef(new Map<number, PointerSample>());
  const gesture = useRef({ start: 0, dragged: false, pinched: false });
  const velocity = useRef<{ azimuth: number; pitch: number; at: number } | null>(null);
  const lastTap = useRef<PointerSample | null>(null);
  const orbit = (azimuth: number, pitch: number, zoom = 1) => send({ t: 'orbit', azimuth, pitch, zoom });
  useEffect(() => {
    const node = surface.current;
    if (home || !node) return;
    function wheel(event: WheelEvent) {
      event.preventDefault();
      const distance = event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? node!.clientHeight : 1);
      send({ t: 'orbit', azimuth: 0, pitch: 0, zoom: Math.exp(Math.max(-.25, Math.min(.25, distance * .002))) });
    }
    node.addEventListener('wheel', wheel, { passive: false });
    return () => node.removeEventListener('wheel', wheel);
  }, [home, send]);

  function cancelPointer(id: number) {
    if (!pointers.current.delete(id)) return;
    gesture.current.pinched = true;
    velocity.current = null;
    lastTap.current = null;
    send({ t: 'orbit-stop' });
  }

  return <div ref={surface} className={'model-orbit' + (home ? ' home-model-orbit' : '')} role="group"
    aria-label={home ? '旋转首页车模' : '旋转 3D 车模'} aria-description="拖动旋转，双击复位。键盘使用方向键，Home 键复位。" tabIndex={0}
    onPointerDown={event => {
      if (event.button !== 0 || pointers.current.size >= 2) return;
      if (!pointers.current.size) gesture.current = { start: event.timeStamp, dragged: false, pinched: false };
      else { gesture.current.pinched = true; lastTap.current = null; }
      velocity.current = null;
      send({ t: 'orbit-stop' });
      pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY, at: event.timeStamp });
      event.currentTarget.setPointerCapture(event.pointerId);
    }}
    onPointerMove={event => {
      const point = pointers.current.get(event.pointerId);
      if (!point) return;
      const next = { x: event.clientX, y: event.clientY, at: event.timeStamp };
      const other = [...pointers.current.entries()].find(([id]) => id !== event.pointerId)?.[1];
      const dx = point.x - next.x, dy = point.y - next.y;
      if (!other && !gesture.current.dragged && Math.hypot(dx, dy) < 5) return;
      pointers.current.set(event.pointerId, next);
      gesture.current.dragged = true;
      lastTap.current = null;
      if (other) {
        const before = Math.hypot(point.x - other.x, point.y - other.y);
        const after = Math.hypot(next.x - other.x, next.y - other.y);
        if (before > 5 && after > 5) orbit(0, 0, before / after);
      } else if (dx || dy) {
        const { clientWidth, clientHeight } = event.currentTarget;
        const azimuth = dx * 2 * Math.PI / clientWidth, pitch = dy * Math.PI / clientHeight;
        const seconds = Math.max(8, next.at - point.at) / 1000;
        velocity.current = { azimuth: azimuth / seconds, pitch: pitch / seconds, at: next.at };
        orbit(azimuth, pitch);
      }
    }}
    onPointerUp={event => {
      const point = pointers.current.get(event.pointerId);
      if (!point) return;
      pointers.current.delete(event.pointerId);
      const { start, dragged, pinched } = gesture.current;
      if (pinched || pointers.current.size) return;
      const speed = velocity.current;
      const tap = { x: event.clientX, y: event.clientY, at: event.timeStamp };
      if (dragged) {
        if (speed && tap.at - speed.at < 75) send({ t: 'orbit-release', azimuth: speed.azimuth, pitch: speed.pitch });
      } else if (tap.at - start < 280 && Math.hypot(tap.x - point.x, tap.y - point.y) < 5) {
        const previous = lastTap.current;
        if (previous && tap.at - previous.at < 300 && Math.hypot(tap.x - previous.x, tap.y - previous.y) < 24) {
          lastTap.current = null;
          send({ t: 'orbit-reset', animate: true });
        } else lastTap.current = tap;
      } else lastTap.current = null;
    }}
    onPointerCancel={event => cancelPointer(event.pointerId)}
    onLostPointerCapture={event => cancelPointer(event.pointerId)}
    onKeyDown={event => {
      switch (event.key) {
        case 'ArrowLeft': orbit(.25, 0); break;
        case 'ArrowRight': orbit(-.25, 0); break;
        case 'ArrowUp': orbit(0, -.2); break;
        case 'ArrowDown': orbit(0, .2); break;
        case '+': orbit(0, 0, .9); break;
        case '-': orbit(0, 0, 1.1); break;
        case 'Home': send({ t: 'orbit-reset', animate: false }); break;
        default: return;
      }
      event.preventDefault();
    }} />;
}

export function VehicleModel({ visual, home = false, editingWrap = false, onStatus }: {
  visual: ReturnType<typeof useVehicleVisual>; home?: boolean; editingWrap?: boolean; onStatus?: (status: ModelStatus) => void;
}) {
  const frame = useRef<HTMLIFrameElement>(null);
  const [phase, setPhase] = useState<'loading' | 'full' | 'unavailable'>('loading');
  const [brokenImages, setBrokenImages] = useState<string[]>([]);
  useEffect(() => {
    const retry = () => setBrokenImages([]);
    window.addEventListener('online', retry);
    return () => window.removeEventListener('online', retry);
  }, []);
  const rememberBrokenImage = (url: string) => setBrokenImages(previous => [...previous, url]);
  const { viewer, scene: background, colorScheme, paintOverride, quality, wrap, cloud, visible } = visual;
  const cloudAsset = cloud.data;
  const trace = cloudAsset?.trace;
  const isolated = !!cloudAsset?.webId;
  const image = [visual.image, visual.fallback].find(url => url && !brokenImages.includes(url));
  let status: ModelStatus = viewer ? phase : cloud.isFetching ? 'loading' : 'unavailable';
  if (visual.mode === '2d') status = '2d';
  else if (visual.autoPicture) status = image ? '2d' : visual.fetchingPhoto ? 'loading' : 'unavailable';
  const wrapPayload = useMemo(() => {
    if (!viewer || !visible) return 'null';
    const faces = Object.fromEntries(Object.entries(wrap).map(([side, items]) => [side,
      slotsOf(items).filter((item): item is Decoration => !!item).map(item => ({ ...item, image: texture(item) }))]));
    return Object.keys(faces).length ? JSON.stringify({ version: 3, faces }) : 'null';
  }, [viewer, visible, wrap]);
  const appearance = useMemo(() => ({ t: 'appearance', background, paint: paintOverride, quality, wrap: wrapPayload }),
    [background, paintOverride, quality, wrapPayload]);
  const latestAppearance = useRef(appearance);
  latestAppearance.current = appearance;
  const latestVisibility = useRef(visible);
  latestVisibility.current = visible;
  const surface = home ? 'home' : editingWrap ? 'wrap' : 'appearance';
  const latestSurface = useRef(surface);
  latestSurface.current = surface;
  const sendPresentation = useCallback(() => {
    const target = frame.current?.contentWindow;
    const origin = isolated ? '*' : location.origin;
    if (target && latestVisibility.current) {
      const floor = getComputedStyle(document.documentElement).getPropertyValue('--bg').trim();
      target.postMessage({ t: 'surface', view: latestSurface.current }, origin);
      target.postMessage({ ...latestAppearance.current, floor }, origin);
    }
    target?.postMessage({ t: 'visibility', visible: latestVisibility.current }, origin);
  }, [isolated]);
  const sendOrbit = useCallback((message: OrbitMessage) => {
    frame.current?.contentWindow?.postMessage(message, isolated ? '*' : location.origin);
  }, [isolated]);
  useEffect(() => { onStatus?.(status); }, [onStatus, status]);
  useEffect(() => {
    if (!viewer) return;
    setPhase('loading');
    trace?.('viewer');
    const recorded = new Set<string>();
    function message(event: MessageEvent) {
      if (event.source !== frame.current?.contentWindow || event.origin !== (isolated ? 'null' : location.origin)) return;
      const data = event.data;
      if (trace && data && typeof data === 'object') {
        const step = viewerDiagnosticStep(data);
        if (step && !recorded.has(step)) {
          recorded.add(step);
          trace(step, typeof data.ms === 'number' && data.ms >= 0 && data.ms < 3_600_000 ? { elapsedMs: Math.round(data.ms) } : undefined);
        }
      }
      if (event.data?.t === 'appearance-request') sendPresentation();
      if (event.data?.t === 'ready' && event.data.full === true) setPhase('full');
      if (event.data?.t === 'err' && event.data?.msg !== '完整模型未就绪，当前显示简化车模') setPhase('unavailable');
    }
    window.addEventListener('message', message);
    return () => window.removeEventListener('message', message);
  }, [viewer, isolated, sendPresentation, trace]);
  useEffect(() => {
    if (!viewer || !visible || phase !== 'loading') return;
    const timeout = setTimeout(() => { trace?.('timeout'); setPhase('unavailable'); }, 40_000);
    return () => clearTimeout(timeout);
  }, [viewer, visible, phase, trace]);
  useEffect(() => {
    if (viewer) sendPresentation();
  }, [viewer, appearance, colorScheme, visible, surface, sendPresentation]);
  let nativeUrl = viewer;
  if (!isolated && viewer) {
    const url = new URL(viewer, location.href);
    url.searchParams.set('app', '1');
    url.searchParams.set('shared', '1');
    nativeUrl = url.href;
  }
  return <div className={(home ? 'home-model' : 'c3d-stage') + ' bg-' + background} data-model-status={status}>
    {viewer && (status === 'loading' || status === 'full') &&
      <iframe key={trace?.id ?? viewer} ref={frame} title={home ? '首页 3D 车模' : '3D 车模'} tabIndex={-1} src={isolated ? undefined : nativeUrl} srcDoc={cloudAsset?.document}
        data-revealed={status === 'full'}
        sandbox={isolated ? 'allow-scripts' : undefined} referrerPolicy="no-referrer" onLoad={event => {
          const target = event.currentTarget.contentWindow;
          if (!cloudAsset?.webId || !target) return;
          const params = new URLSearchParams(cloudAsset.params);
          params.set('app', '1');
          params.set('shared', '1');
          params.set('bg', background);
          const id = cloudAsset.webId;
          void import('../../data/cloud/cloud3d').then(({ sendViewerAssets }) => sendViewerAssets(target, id, params.toString())).catch(() => {
            if (frame.current?.contentWindow === target) { trace?.('transferError'); setPhase('unavailable'); }
          });
        }} />}
    {(status === 'loading' || status === 'unavailable') && <div className="c3d-loader" role="status"
      aria-label={status === 'loading' ? '加载 3D 车模' : '3D 车模暂不可用'} data-unavailable={status === 'unavailable' || undefined} />}
    {visible && status === 'full' && <OrbitSurface key={String(home)} home={home} send={sendOrbit} />}
    {status === '2d' && <>
      {image ? <img className="static3d contain" src={image} alt="车辆外观" referrerPolicy="no-referrer" onError={() => rememberBrokenImage(image)} /> :
        <div className="car-image-missing"><Icon name="car" size={72} />{!home && (visual.image && brokenImages.includes(visual.image) ?
          <button className="link" onClick={() => setBrokenImages([])}>重新加载外观图</button> : <span>暂无车模图片</span>)}</div>}
      {!home && <div className="c3d-badge">{visual.mode === '2d' && visual.market?.image ? visual.market.model + ' · ' + visual.market.year + ' · 2D 商城' : '2D 外观'}</div>}
    </>}
  </div>;
}
