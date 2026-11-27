import { useEffect, useRef, useState } from 'react';
import { useQueries } from '@tanstack/react-query';
import { useModelContext } from '../context';
import { haTripTrack } from '../../data/ha/ledger';
import type { Point, Trip } from '../../data/ha/measurements';
import { RouteThumbnail } from '../vehicle/AmapView';
import type { MapStyle } from '../vehicle/AmapView';
import { mapPoint } from '../vehicle/Location';
import { Icon } from '../../ui/Icon';

function drawableRuns(points: (Point | undefined)[]) {
  const runs: Point[][] = [];
  let run: Point[] = [];
  for (const point of points) {
    if (!point || point.coordinate === 'unknown') { run = []; continue; }
    if (point.gapBefore) run = [];
    const previous = run.at(-1);
    if (!previous) runs.push(run);
    if (previous?.lat !== point.lat || previous.lon !== point.lon) run.push(point);
  }
  return runs.filter(part => part.length >= 2).map(part => {
    const stride = Math.ceil(part.length / 120);
    return part.filter((_, index) => index % stride === 0 || index === part.length - 1).map(mapPoint);
  });
}

export function TripThumbnail({ trips, mapStyle, daily = false }: { trips: Trip[]; mapStyle: MapStyle; daily?: boolean }) {
  const { ha, canSee, usesHA } = useModelContext();
  const permitted = canSee('location');
  const element = useRef<HTMLDivElement>(null);
  const [near, setNear] = useState(false);
  useEffect(() => {
    const node = element.current;
    if (!node || near || !permitted) return;
    if (typeof IntersectionObserver !== 'function') { setNear(true); return; }
    const observer = new IntersectionObserver(([entry]) => {
      if (entry.isIntersecting) { setNear(true); observer.disconnect(); }
    }, { rootMargin: '48px' });
    observer.observe(node);
    return () => observer.disconnect();
  }, [near, permitted]);

  const { config, vin, connected } = ha;
  const remote = near && permitted && config && vin ? trips.filter(trip => trip.id.startsWith('ha-trip-') && trip.pointCount !== 0) : [];
  const previews = useQueries({ queries: remote.map(trip => {
    const id = trip.id.slice(8);
    return {
      queryKey: ['ha', 'trip-preview', config?.localScope, config?.url, vin, id, usesHA],
      queryFn: ({ signal }: { signal: AbortSignal }) => haTripTrack(config!, vin, id, signal, 120, usesHA ? 'refresh' : 'saved-only'),
      networkMode: 'offlineFirst' as const,
      enabled: connected, staleTime: 30 * 60_000, gcTime: 30 * 60_000, retry: false,
    };
  }) });
  const runs = near && permitted ? trips.flatMap(trip => drawableRuns(trip.route)).concat(
    previews.flatMap(query => drawableRuns(query.data?.map(sample => sample.position) ?? [])),
  ) : [];
  const loading = permitted && (!near || previews.some(query => query.isFetching));
  const unavailable = previews.some(query => query.isError || !connected && !query.data);
  const label = !permitted ? '定位未授权' : runs.length ? daily ? '当日合并轨迹' : '行程轨迹缩略图' :
    loading ? '正在读取轨迹' : unavailable ? '轨迹暂不可用' : daily ? '当天无轨迹' : '暂无轨迹';

  return <div className="trip-thumbnail" ref={element} role="img" aria-label={label} data-preview-status={runs.length ? 'ready' : loading ? 'loading' : 'unavailable'}>
    {runs.length ? <RouteThumbnail runs={runs} mapStyle={mapStyle} /> : <span className="trip-thumbnail-empty">
      <Icon name="map" size={15} />{label}
    </span>}
  </div>;
}
