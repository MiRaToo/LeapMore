import { useEffect, useState } from 'react';
import { readSetting, saveSetting } from './localDatabase';
import type { Tariff } from './types';

export const defaultTariff: Tariff = {
  ac: { peak: .62, valley: .32, valleyStart: '23:00', valleyEnd: '07:00', efficiency: 90 },
  dc: { periods: [{ start: '00:00', end: '08:00', price: 1.2 }, { start: '08:00', end: '18:00', price: 1.55 }, { start: '18:00', end: '00:00', price: 1.35 }], efficiency: 92 },
};
export type Source = 'phone' | 'ha' | 'hybrid' | 'off';
export const defaultRecordSource = 'off' satisfies Source;
export const sourceUsesPhone = (source: Source) => source === 'phone' || source === 'hybrid';
export const sourceUsesHA = (source: Source) => source === 'ha' || source === 'hybrid';
export type Grant = 'control' | 'location' | 'mileage';
export type Options = { phone?: string; name?: string; color?: string; colorName?: string };
export type Favorite = { name: string; address: string; point?: { lat: number; lon: number; poiId?: string } };
export const allGrants: Record<Grant, boolean> = { control: true, location: true, mileage: true };

export const themeModes = { light: '浅色', dark: '深色', system: '跟随系统' } as const;
export type ThemeMode = keyof typeof themeModes;
export const themeAccents = {
  blue: { name: '默认蓝', light: '#03a9f4', dark: '#03a9f4' },
  teal: { name: '青绿', light: '#08796b', dark: '#64cfbd' },
  violet: { name: '紫色', light: '#6e4bb4', dark: '#bc9cfa' },
  orange: { name: '暖橙', light: '#a24813', dark: '#f3ad75' },
  rose: { name: '玫红', light: '#a63b62', dark: '#f69bb8' },
  graphite: { name: '石墨灰', light: '#4f6376', dark: '#aabacb' },
} as const;
export type ThemeAccent = keyof typeof themeAccents;

export function useSetting<T>(key: string, initial: T) {
  const [value, setValue] = useState<T>(() => readSetting(key, initial));
  useEffect(() => { saveSetting(key, value); }, [key, value]);
  return [value, setValue] as const;
}
