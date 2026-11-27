import { useEffect, useId, useMemo, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import { useSetting } from '../../data/preferences';
import { kmBetween } from '../../data/ha/measurements';
import { Icon } from '../../ui/Icon';
import { useModelContext } from '../context';

const TILE = 256;
const VECTOR = 'https://webrd0{s}.is.autonavi.com/appmaptile?lang=zh_cn&size=1&scale=1&style=8&x={x}&y={y}&z={z}';
const SATELLITE = 'https://webst0{s}.is.autonavi.com/appmaptile?style=6&x={x}&y={y}&z={z}';
const FALLBACK = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';

export type MapStyle = 'vector' | 'satellite' | 'dark';
const mapChoices = ['vector', 'satellite', 'dark', 'system'] as const;
type MapChoice = typeof mapChoices[number];
const mapLabels: Record<MapChoice, string> = { vector: '日间', satellite: '卫星', dark: '深色', system: '跟随' };

export function useMapStyle() {
  const [choice, setChoice] = useSetting<MapChoice>('mapStyle', 'system');
  const { systemColorScheme } = useModelContext();
  const style = choice === 'system' ? systemColorScheme === 'dark' ? 'dark' : 'vector' : choice;
  return { choice, setChoice, style };
}

type RoutePoint = { lat: number; lon: number; at: number; speed?: number | null; gapBefore?: boolean };
type ScreenPoint = { x: number; y: number };
type Camera = { center: [number, number]; zoom: number };
const zoomLimit = (zoom: number) => Math.max(3, Math.min(18, zoom));
function spanBetween([a, b]: ScreenPoint[]) {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, length: Math.max(1, Math.hypot(a.x - b.x, a.y - b.y)) };
}
const speedColors = ['#2b86ae', '#229486', '#9fa14a', '#dd9545', '#cc6355'];

function fitRoute(route: RoutePoint[], w: number, h: number, padX = 47, padY = 36) {
  let left = Infinity, top = Infinity, right = -Infinity, bottom = -Infinity;
  for (const point of route) {
    const { x, y } = project(point.lat, point.lon, 0);
    left = Math.min(left, x); right = Math.max(right, x);
    top = Math.min(top, y); bottom = Math.max(bottom, y);
  }
  const scale = Math.min(Math.max(1, w - 2 * padX) / Math.max(1e-8, right - left), Math.max(1, h - 2 * padY) / Math.max(1e-8, bottom - top));
  return { center: unproject((left + right) / 2, (top + bottom) / 2, 0), zoom: Math.max(3, Math.min(17, Math.floor(Math.log2(scale)))) };
}

function tileUrl(tpl: string, z: number, x: number, y: number) {
  const s = ((x + y) % 4) + 1;
  return tpl.replace('{s}', String(s)).replace('{z}', String(z)).replace('{x}', String(x)).replace('{y}', String(y));
}

function project(lat: number, lon: number, z: number) {
  lat = Math.max(-85.0511, Math.min(85.0511, lat));
  const scale = TILE * Math.pow(2, z);
  const x = ((lon + 180) / 360) * scale;
  const sin = Math.sin((lat * Math.PI) / 180);
  const y = (0.5 - Math.log((1 + sin) / (1 - sin)) / (4 * Math.PI)) * scale;
  return { x, y };
}

function unproject(x: number, y: number, z: number): [number, number] {
  const scale = TILE * Math.pow(2, z);
  const lon = (x / scale) * 360 - 180;
  const n = Math.PI - (2 * Math.PI * y) / scale;
  const lat = (180 / Math.PI) * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)));
  return [lat, lon];
}

function mapTiles(mapStyle: MapStyle, z: number, originX: number, originY: number, w: number, h: number) {
  const n = 2 ** z;
  const tiles = [];
  const tpl = mapStyle === 'satellite' ? SATELLITE : VECTOR;
  for (let x = Math.floor(originX / TILE); x <= Math.floor((originX + w) / TILE); x++) {
    for (let y = Math.max(0, Math.floor(originY / TILE)); y <= Math.min(n - 1, Math.floor((originY + h) / TILE)); y++) {
      const tx = ((x % n) + n) % n;
      tiles.push({ key: z + '/' + x + '/' + y, left: x * TILE - originX, top: y * TILE - originY,
        src: tileUrl(tpl, z, tx, y), fallback: tileUrl(FALLBACK, z, tx, y) });
    }
  }
  return tiles;
}

function MapTile({ tile, style }: { tile: ReturnType<typeof mapTiles>[number]; style: CSSProperties }) {
  return <img src={tile.src} alt="" draggable={false} referrerPolicy="no-referrer" style={style} onError={e => {
    const img = e.currentTarget;
    if (img.dataset.fallback) return;
    img.dataset.fallback = '1';
    img.src = tile.fallback;
  }} />;
}

export function RouteThumbnail({ runs, mapStyle }: { runs: RoutePoint[][]; mapStyle: MapStyle }) {
  const w = 160, h = 90;
  const { center, zoom } = fitRoute(runs.flat(), w, h, 12, 12);
  const p = project(...center, zoom);
  const x = p.x - w / 2, y = p.y - h / 2;
  const paths = runs.map(run => run.map((point, index) => {
    const pixel = project(point.lat, point.lon, zoom);
    return `${index && !point.gapBefore ? 'L' : 'M'}${(pixel.x - x).toFixed(1)} ${(pixel.y - y).toFixed(1)}`;
  }).join('')).join('');
  return <div className={'trip-thumbnail-map' + (mapStyle === 'dark' ? ' is-dark' : '')} aria-hidden="true">
    <div className="amap-tiles">
      {mapTiles(mapStyle, zoom, x, y, w, h).map(tile => <MapTile key={tile.src} tile={tile} style={{
        left: 100 * tile.left / w + '%', top: 100 * tile.top / h + '%', width: 100 * TILE / w + '%', height: 100 * TILE / h + '%',
      }} />)}
    </div>
    <svg className="amap-route trip-thumbnail-route" viewBox={`0 0 ${w} ${h}`} fill="none" strokeLinecap="round" strokeLinejoin="round">
      <path d={paths} stroke="white" strokeWidth="5" />
      <path d={paths} stroke="#137cc5" strokeWidth="3" />
    </svg>
  </div>;
}

export const homeMapAnchor = { x: .26, y: .44 };

export function AmapView({ lat, lon, height = 240, marker = 'car', name = marker === 'charge' ? '充电位置' : '车辆位置', sub, preview = false, illustrated = false, route, selectedAt, onRouteSelect }: {
  lat: number; lon: number; height?: number | '100%'; name?: string; sub?: string; preview?: boolean; illustrated?: boolean;
  marker?: 'car' | 'charge'; route?: RoutePoint[]; selectedAt?: number | null; onRouteSelect?: (at: number | null) => void;
}) {
  const recordMap = !!route || marker === 'charge';
  const box = useRef<HTMLDivElement | null>(null);
  const pointers = useRef(new Map<number, ScreenPoint>());
  const drag = useRef<{ start: ScreenPoint; camera: Camera; picking: boolean; moved: boolean; fromPinch?: boolean } | null>(null);
  const pinch = useRef<{ world: ScreenPoint; zoom: number; length: number } | null>(null);
  const [size, setSize] = useState({ w: 360, h: typeof height === 'number' ? height : 240 });
  const [view, setView] = useState<Camera>({ center: [lat, lon], zoom: route ? 13 : 16 });
  const camera = useRef(view);
  camera.current = view;
  const [follow, setFollow] = useState(true);
  const { choice: mapChoice, setChoice: setMapChoice, style: mapStyle } = useMapStyle();
  const [dragging, setDragging] = useState(false);
  const [opacity, setOpacity] = useSetting('tripMapControlOpacity', 88);
  const [toolsOpen, setToolsOpen] = useState(false);
  const toolsId = useId();

  const toolBox = useRef<HTMLDivElement>(null);
  const toolButton = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!toolsOpen) return;
    const outside = (event: PointerEvent) => {
      if (!toolBox.current?.contains(event.target as Node)) setToolsOpen(false);
    };
    document.addEventListener('pointerdown', outside, true);
    return () => document.removeEventListener('pointerdown', outside, true);
  }, [toolsOpen]);

  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setSize({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    setSize({ w: el.clientWidth, h: el.clientHeight });
    return () => ro.disconnect();
  }, [height]);

  const fit = useMemo(() => route?.length ? fitRoute(route, size.w, size.h) : null, [route, size.w, size.h]);
  useEffect(() => {
    if (!follow) return;
    setView(current => ({ center: fit?.center ?? [lat, lon], zoom: fit?.zoom ?? current.zoom }));
  }, [lat, lon, follow, fit]);

  const isDark = mapStyle === 'dark';
  const { zoom: z, center } = view;
  const p = project(center[0], center[1], z);
  const originX = p.x - size.w * (preview ? homeMapAnchor.x : .5);
  const originY = p.y - size.h * (preview ? homeMapAnchor.y : .5);
  const tileZoom = Math.floor(z);
  const tileScale = 2 ** (z - tileZoom);
  const tiles = illustrated ? [] : mapTiles(mapStyle, tileZoom, originX / tileScale, originY / tileScale, size.w / tileScale, size.h / tileScale);
  const trajectory = useMemo(() => {
    let lo = Infinity, hi = -Infinity;
    const segments = route?.map((point, i) => {
      if (point.speed != null) { lo = Math.min(lo, point.speed); hi = Math.max(hi, point.speed); }
      const projected = project(point.lat, point.lon, z);
      const previous = route[i - 1];
      const gap = !!previous && (point.gapBefore || point.at - previous.at > 180_000 || kmBetween(previous, point) > 2);
      return { x: projected.x - originX, y: projected.y - originY, at: point.at, speed: point.speed, gap };
    }) ?? [];
    const withSpeed = Number.isFinite(lo);
    if (withSpeed && hi - lo < 10) { lo = Math.max(0, lo - 5); hi += 5; }
    const paths = new Map<string, string>();
    let solid = '', gaps = '';
    segments.forEach((point, i) => {
      const last = segments[i - 1];
      if (!last) return;
      const line = 'M' + last.x.toFixed(1) + ' ' + last.y.toFixed(1) + 'L' + point.x.toFixed(1) + ' ' + point.y.toFixed(1);
      if (point.gap) { gaps += line; return; }
      solid += line;
      const speed = point.speed != null && last.speed != null ? (point.speed + last.speed) / 2 : null;
      const t = speed == null ? null : (speed - lo) / (hi - lo);
      const color = t === null ? withSpeed ? '#858b94' : '#0ca1ee' : speedColors[t < .2 ? 0 : t < .45 ? 1 : t < .7 ? 2 : t < .9 ? 3 : 4];
      paths.set(color, (paths.get(color) ?? '') + line);
    });
    return { segments, solid, gaps, paths: [...paths], withSpeed, lo, hi };
  }, [route, z, originX, originY]);
  const { segments } = trajectory;
  const picked = selectedAt == null ? undefined : segments.find(point => point.at === selectedAt);
  const selectedPoint = selectedAt == null ? undefined : route?.find(point => point.at === selectedAt);
  useEffect(() => {
    if (!selectedPoint) return;
    setView(current => {
      const focus = project(selectedPoint.lat, selectedPoint.lon, current.zoom);
      const from = project(...current.center, current.zoom);
      return Math.abs(focus.x - from.x) > size.w / 2 - 14 || Math.abs(focus.y - from.y) > size.h / 2 - 14
        ? { ...current, center: [selectedPoint.lat, selectedPoint.lon] } : current;
    });
  }, [selectedPoint, size.w, size.h]);
  const car = project(lat, lon, z);
  const carLeft = car.x - originX;
  const carTop = car.y - originY;

  function updateCamera(next: Camera) {
    camera.current = next;
    setView(next);
  }
  function zoomBy(change: number) {
    if (fit) setFollow(false);
    updateCamera({ center, zoom: zoomLimit(z + change) });
  }

  function routeSampleAt(clientX: number, clientY: number, radius = 22) {
    const rect = box.current?.getBoundingClientRect();
    if (!rect || !onRouteSelect) return undefined;
    const x = clientX - rect.left, y = clientY - rect.top;
    let best = radius ** 2, time: number | undefined;
    const check = (px: number, py: number, at: number) => {
      const distance = (px - x) ** 2 + (py - y) ** 2;
      if (distance <= best) { best = distance; time = at; }
    };
    segments.forEach((point, i) => {
      check(point.x, point.y, point.at);
      const last = segments[i - 1];
      if (!last || point.gap) return;
      const dx = point.x - last.x, dy = point.y - last.y;
      const length = dx * dx + dy * dy;
      if (!length) return;
      const t = ((x - last.x) * dx + (y - last.y) * dy) / length;
      if (t > 0 && t < 1) check(last.x + t * dx, last.y + t * dy, t < .5 ? last.at : point.at);
    });
    return time;
  }

  function endPointer(id: number, point?: ScreenPoint) {
    if (!pointers.current.delete(id)) return;
    const d = drag.current;
    if (point && d && !d.fromPinch) {
      if (d.picking) {
        const sample = routeSampleAt(point.x, point.y, 28);
        if (sample !== undefined) onRouteSelect?.(sample);
      } else if (!d.moved && Math.hypot(point.x - d.start.x, point.y - d.start.y) < 6) onRouteSelect?.(null);
    }
    pinch.current = null;
    const remaining = pointers.current.values().next().value;
    drag.current = remaining ? { start: remaining, camera: camera.current, picking: false, moved: false, fromPinch: true } : null;
    setDragging(!!remaining);
  }

  return (
    <div className={'amap-view' + (isDark ? ' is-dark' : '') + (preview ? ' amap-preview' : '') + (recordMap ? ' amap-record' : '') + (route ? ' amap-trip' : '')}
      data-map-style={mapChoice} data-map-zoom={z.toFixed(3)}
      style={recordMap ? { height, '--map-control-opacity': opacity / 100 } as CSSProperties : { height }} ref={box}>
      <div className="amap-tiles">
        {illustrated && <div className="map-bg" style={preview ? undefined : {
          transform: `translate(${carLeft - size.w / 2}px, ${carTop - size.h / 2}px) scale(${Math.max(1, 2 ** (z - 16))})`,
        }} />}
        {tiles.map(tile => <MapTile key={tile.key + mapStyle} tile={tile} style={{ left: tile.left * tileScale, top: tile.top * tileScale,
          width: TILE * tileScale, height: TILE * tileScale }} />)}
      </div>
      <div className="amap-tint" />
      {segments.length > 0 && <svg className="amap-route" viewBox={`0 0 ${size.w} ${size.h}`} aria-label="行程轨迹">
        <path d={trajectory.solid} fill="none" stroke="white" strokeOpacity=".9" strokeWidth="6.5" strokeLinecap="round" />
        {trajectory.paths.map(([color, path]) => <path className="amap-speed-path" key={color} d={path} fill="none" stroke={color} strokeWidth="4" strokeLinecap="round" />)}
        {trajectory.gaps && <path d={trajectory.gaps} fill="none" stroke="#727781" strokeWidth="2.5" strokeDasharray="4 4" />}
        <circle aria-label="起点" cx={segments[0].x} cy={segments[0].y} r="6" fill="var(--trip-origin)" stroke="white" strokeWidth="2" />
        <circle aria-label="终点" cx={segments.at(-1)!.x} cy={segments.at(-1)!.y} r="6" fill="var(--trip-destination)" stroke="white" strokeWidth="2" />
        {picked && <circle className="amap-route-cursor" data-sample-at={picked.at} cx={picked.x} cy={picked.y} r="7" fill="var(--accent)" stroke="white" strokeWidth="3" />}
      </svg>}
      {trajectory.withSpeed && segments.length > 1 && <div className="amap-speed-legend" aria-label="轨迹速度范围">
        <span>{Math.round(trajectory.lo)}</span><i /><span>{Math.round(trajectory.hi)} km/h</span>
      </div>}
      {!route && !preview && <button
        className="amap-car"
        style={{ left: carLeft, top: carTop }}
        onClick={() => { setFollow(true); updateCamera({ center: [lat, lon], zoom: z }); }}
        aria-label={name}
        title={name}
      >
        <Icon name={marker === 'charge' ? 'plug' : 'car'} size={14} />
      </button>}
      {!preview && (
        <>
          {!recordMap && <div className="amap-bar"><div className="amap-title"><b>{name}</b>{sub && <small>{sub}</small>}</div></div>}
          <div className="amap-ctl" ref={toolBox} onKeyDown={e => {
            if (toolsOpen && e.key === 'Escape') { setToolsOpen(false); toolButton.current?.focus(); }
          }} onBlur={e => { if (!e.currentTarget.contains(e.relatedTarget)) setToolsOpen(false); }}>
            <button type="button" className={follow ? 'on' : ''} onClick={() => {
              setFollow(true); updateCamera(fit ?? { center: [lat, lon], zoom: 16 }); setToolsOpen(false);
            }} aria-label={route ? '回到路线' : marker === 'charge' ? '回到充电位置' : '跟随车辆'}><Icon name="locate" size={16} /></button>
            {recordMap && <button type="button" ref={toolButton} aria-label="地图设置" aria-expanded={toolsOpen} aria-controls={toolsId}
              onClick={() => setToolsOpen(!toolsOpen)}><Icon name="layers" size={16} /></button>}
            {(!recordMap || toolsOpen) && <div className={recordMap ? 'amap-tools-panel' : 'amap-vehicle-tools'} id={toolsId}>
              <div className="amap-zoom">
                <button type="button" onClick={() => zoomBy(1)} aria-label="放大"><Icon name="plus" size={15} /></button>
                <button type="button" onClick={() => zoomBy(-1)} aria-label="缩小"><Icon name="minus" size={15} /></button>
              </div>
              <button type="button" className="amap-style" onClick={() => setMapChoice(choice => mapChoices[(mapChoices.indexOf(choice) + 1) % mapChoices.length])}
                aria-label="切换底图" title={mapChoice === 'system' ? '跟随系统颜色' : undefined}>
                {recordMap && <span>底图</span>}{mapLabels[mapChoice]}
              </button>
              {recordMap && <label className="amap-opacity"><span>控件不透明度</span><output>{opacity}%</output>
                <input type="range" aria-label="地图控件不透明度" min={35} max={100} value={opacity} onChange={e => setOpacity(e.currentTarget.valueAsNumber)} />
              </label>}
            </div>}
          </div>
          {!illustrated && <span className="amap-attrib">© 高德地图</span>}
          <div
            className={'amap-drag' + (dragging ? ' active' : '')}
            tabIndex={onRouteSelect ? 0 : undefined}
            role={onRouteSelect ? 'group' : undefined}
            aria-label={onRouteSelect ? '轨迹采样，左右方向键选点，Esc 清除选择' : undefined}
            onKeyDown={e => {
              if (!onRouteSelect || !segments.length || !['ArrowLeft', 'ArrowRight', 'Home', 'End', 'Escape'].includes(e.key)) return;
              e.preventDefault();
              if (e.key === 'Escape') { onRouteSelect(null); return; }
              const current = segments.findIndex(point => point.at === selectedAt);
              const index = e.key === 'Home' ? 0 : e.key === 'End' ? segments.length - 1 :
                Math.max(0, Math.min(segments.length - 1, current + (e.key === 'ArrowLeft' ? -1 : 1)));
              onRouteSelect(segments[index].at);
            }}
            onPointerDown={(e) => {
              if (e.button !== 0 || pointers.current.size >= 2 || e.pointerType !== 'touch' && pointers.current.size > 0) return;
              if (toolsOpen) setToolsOpen(false);
              const point = { x: e.clientX, y: e.clientY };
              pointers.current.set(e.pointerId, point);
              e.currentTarget.setPointerCapture(e.pointerId);
              const current = camera.current;
              if (pointers.current.size === 2) {
                const { x, y, length } = spanBetween([...pointers.current.values()]);
                const rect = e.currentTarget.getBoundingClientRect();
                const centerPixel = project(...current.center, current.zoom);
                pinch.current = { zoom: current.zoom, length, world: {
                  x: centerPixel.x + x - rect.left - size.w / 2,
                  y: centerPixel.y + y - rect.top - size.h / 2,
                } };
                drag.current = null;
                setFollow(false);
              } else {
                drag.current = { start: point, camera: current, picking: routeSampleAt(point.x, point.y) !== undefined, moved: false };
              }
              setDragging(true);
            }}
            onPointerMove={(e) => {
              if (!pointers.current.has(e.pointerId)) return;
              pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
              const pinchStart = pinch.current;
              if (pinchStart) {
                const { x, y, length } = spanBetween([...pointers.current.values()]);
                const rect = e.currentTarget.getBoundingClientRect();
                const zoom = zoomLimit(pinchStart.zoom + Math.log2(length / pinchStart.length));
                const scale = 2 ** (zoom - pinchStart.zoom);
                updateCamera({ zoom, center: unproject(pinchStart.world.x * scale - x + rect.left + size.w / 2,
                  pinchStart.world.y * scale - y + rect.top + size.h / 2, zoom) });
                return;
              }
              const d = drag.current;
              if (!d) return;
              if (d.picking) {
                const sample = routeSampleAt(e.clientX, e.clientY, 28);
                if (sample !== undefined) onRouteSelect?.(sample);
                return;
              }
              const dx = e.clientX - d.start.x;
              const dy = e.clientY - d.start.y;
              if (Math.abs(dx) + Math.abs(dy) < 2) return;
              d.moved = true;
              const zoom = d.camera.zoom;
              const base = project(...d.camera.center, zoom);
              setFollow(false);
              updateCamera({ zoom, center: unproject(base.x - dx, base.y - dy, zoom) });
            }}
            onPointerUp={e => endPointer(e.pointerId, { x: e.clientX, y: e.clientY })}
            onPointerCancel={e => endPointer(e.pointerId)}
            onLostPointerCapture={e => endPointer(e.pointerId)}
          />
        </>
      )}
    </div>
  );
}
