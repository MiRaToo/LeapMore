import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Capacitor } from '@capacitor/core';
import { request } from '../../platform/network';
import { nativeSettings } from '../../platform/settings';
import { useAmapKey } from './AmapKey';

type Point = { lat: number; lon: number };
export type AmapPlace = { name: string; address: string; point: Point & { poiId?: string } };
const locationValue = ({ lat, lon }: Point) => `${lon.toFixed(5)},${lat.toFixed(5)}`;
const service = 'https://restapi.amap.com/v3/';

export function parseAmapPoint(value: unknown): Point | undefined {
  if (typeof value !== 'string' || !/^-?\d+(?:\.\d+)?,-?\d+(?:\.\d+)?$/.test(value)) return undefined;
  const [lon, lat] = value.split(',').map(Number);
  if (Math.abs(lat) > 90 || Math.abs(lon) > 180 || !lat && !lon) return undefined;
  return { lat, lon };
}

export function useAmapAddress(point: Point | null | undefined, enabled = true) {
  const config = useAmapKey();
  return useAddressAt(point, enabled, config);
}

function useAddressAt(point: Point | null | undefined, enabled: boolean, { key, revision }: ReturnType<typeof useAmapKey>) {
  const location = point ? locationValue(point) : '';
  const query = useQuery({ queryKey: ['amap', 'address', revision, location], enabled: enabled && !!key && !!location,
    staleTime: 15 * 60_000, gcTime: 30 * 60_000, retry: false, queryFn: async ({ signal }) => {
      const params = new URLSearchParams({ location, key: key! });
      const reply = await request<{ status: string; regeocode?: { formatted_address?: string; addressComponent?: { citycode?: unknown; adcode?: unknown } } }>(service + 'geocode/regeo?' + params, { signal });
      if (reply.status !== '1') throw new Error('地址解析失败，请检查高德 Key。');
      const address = reply.regeocode?.formatted_address;
      const area = reply.regeocode?.addressComponent;
      const city = [area?.citycode, area?.adcode].find((v): v is string => typeof v === 'string' && !!v.trim());
      return { address: typeof address === 'string' ? address.trim() : '', city };
    } });
  return { hasKey: !!key, data: key ? query.data?.address : undefined, city: key ? query.data?.city : undefined, loading: query.isLoading, isError: !!key && query.isError };
}

type PlaceResult = { name?: unknown; id?: unknown; location?: unknown; address?: unknown; district?: unknown; cityname?: unknown; adname?: unknown };
function mapPlaces(rows?: PlaceResult[]): AmapPlace[] {
  if (!Array.isArray(rows)) return [];
  return rows.flatMap((row): AmapPlace[] => {
    const point = parseAmapPoint(row.location);
    if (!point || typeof row.name !== 'string' || !row.name.trim()) return [];
    const address = [row.district ?? row.cityname, row.adname, row.address]
      .filter((part): part is string => typeof part === 'string' && !!part.trim()).join('');
    const name = row.name.trim();
    return [{ name, address: address || name, point: { ...point, poiId: typeof row.id === 'string' && row.id ? row.id : undefined } }];
  }).slice(0, 8);
}

export function useAmapSuggestions(input: string, origin: Point | null, config: ReturnType<typeof useAmapKey>, enabled: boolean) {
  const { key, revision } = config;
  const { city, loading: locatingCity } = useAddressAt(origin, enabled, config);
  const keyword = input.trim();
  const [settled, setSettled] = useState(keyword);
  useEffect(() => {
    const timer = setTimeout(() => setSettled(keyword), 240);
    return () => clearTimeout(timer);
  }, [keyword]);
  const location = origin ? locationValue(origin) : '';
  const ready = enabled && !!key && (keyword ? keyword === settled && !locatingCity : !!location);
  const query = useQuery({
    queryKey: ['amap', 'places', revision, keyword ? settled : '', location, keyword ? city ?? '' : ''],
    enabled: ready, retry: false, staleTime: 5 * 60_000,
    queryFn: async ({ signal }) => {
      const params = new URLSearchParams({ key: key!, ...(location ? { location } : {}) });
      if (!keyword) {
        params.set('radius', '3000');
        params.set('sortrule', 'distance');
        params.set('offset', '8');
        const result = await request<{ status: string; pois?: PlaceResult[] }>(service + 'place/around?' + params, { signal });
        if (result.status !== '1') throw new Error('无法读取附近地点');
        return mapPlaces(result.pois);
      }
      params.set('keywords', settled);
      params.set('datatype', 'poi');
      if (city) params.set('city', city);
      const result = await request<{ status: string; tips?: PlaceResult[] }>(service + 'assistant/inputtips?' + params, { signal });
      if (result.status !== '1') throw new Error('无法读取地点建议');
      const tips = mapPlaces(result.tips);
      if (tips.length) return tips;
      // District and category hints can omit coordinates. Offer selectable POIs for that keyword.
      const search = new URLSearchParams({ key: key!, keywords: settled, offset: '8', ...(city ? { city } : {}) });
      const matches = await request<{ status: string; pois?: PlaceResult[] }>(service + 'place/text?' + search, { signal });
      if (matches.status !== '1') throw new Error('无法搜索地点');
      return mapPlaces(matches.pois);
    },
  });
  return { places: ready ? query.data ?? [] : [], failed: ready && query.isError,
    loading: enabled && !!key && (!!keyword || !!location) && (!ready || query.isPending) };
}

export function placeDistance(origin: Point, point: Point) {
  const rad = Math.PI / 180;
  const hav = Math.sin((point.lat - origin.lat) * rad / 2) ** 2 +
    Math.cos(origin.lat * rad) * Math.cos(point.lat * rad) * Math.sin((point.lon - origin.lon) * rad / 2) ** 2;
  return 12742000 * Math.asin(Math.sqrt(Math.min(1, hav)));
}

export async function openAmapNavigation(point: Point, title: string) {
  const target = { dlat: point.lat.toFixed(6), dlon: point.lon.toFixed(6), dname: title, sourceApplication: 'LeapMore', dev: '0', t: '0' };
  const platform = Capacitor.getPlatform();
  const app = (platform === 'ios' ? 'iosamap://path?' : 'amapuri://route/plan/?') + new URLSearchParams(target);
  const web = 'https://uri.amap.com/navigation?' + new URLSearchParams({ to: `${target.dlon},${target.dlat}`, mode: 'car', src: 'LeapMore',
    callnative: Capacitor.isNativePlatform() ? '0' : '1' });
  if (Capacitor.isNativePlatform() && Capacitor.isPluginAvailable('LeapSettings')) {
    await nativeSettings.openAmap({ app, web });
  } else window.open(web, '_blank', 'noopener,noreferrer');
}
