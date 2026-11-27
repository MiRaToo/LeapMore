import { useEffect, useRef, useState } from 'react';
import type { Favorite } from '../../data/preferences';
import { Icon } from '../../ui/Icon';
import { Sheet } from '../../ui/components';
import { useModelContext } from '../context';
import { AmapKeySheet, useAmapKey } from './AmapKey';
import { parseAmapPoint, placeDistance, useAmapSuggestions } from './amapServices';
import { mapPoint } from './navigationDestination';

const demoPlaces = [
  { name: '世纪公园', address: '上海市浦东新区 · 花木路', point: { lat: 31.2158, lon: 121.5506 } },
  { name: '上海科技馆', address: '上海市浦东新区 · 世纪大道', point: { lat: 31.2186, lon: 121.5409 } },
  { name: '上海图书馆东馆', address: '上海市浦东新区 · 合欢路', point: { lat: 31.2241, lon: 121.5493 } },
  { name: '龙阳路充电站', address: '上海市浦东新区 · 龙阳路', point: { lat: 31.2033, lon: 121.5578 } },
];

type Props = {
  adding?: boolean; initialQuery?: string; close: () => void;
  choose: (place: Favorite, key: string | undefined, signal: AbortSignal) => void | Promise<void>;
};

export function PlaceSearchSheet({ adding = false, initialQuery = '', choose, close }: Props) {
  const m = useModelContext();
  const config = useAmapKey();
  const [text, setText] = useState(initialQuery);
  const [configure, setConfigure] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const job = useRef<AbortController>();
  const results = useRef<HTMLDivElement>(null);
  useEffect(() => () => job.current?.abort(), []);
  const term = text.trim();
  const coordinate = parseAmapPoint(term.replace(/，/g, ',').replace(/\s/g, ''));
  const raw = m.canSee('location') ? m.current.location : null;
  const origin = raw && raw.coordinate !== 'unknown' ? mapPoint(raw) : null;
  const remote = useAmapSuggestions(term, origin, config, !coordinate && !configure);
  const matches = (place: Favorite) => (place.name + place.address).toLocaleLowerCase().includes(term.toLocaleLowerCase());
  const favorites = adding || coordinate ? [] : m.favorites.filter(matches);
  const places = !config.key && m.simulated && !coordinate
    ? demoPlaces.filter(matches).sort((a, b) => origin ? placeDistance(origin, a.point) - placeDistance(origin, b.point) : 0)
    : remote.places;
  const canSearch = !!config.key || m.simulated;
  async function pick(place: Favorite) {
    if (!adding && !place.point && !config.key) { setConfigure(true); return; }
    if (job.current) return;
    const controller = new AbortController();
    job.current = controller;
    setLoading(true);
    setError('');
    try { await choose(place, config.key, controller.signal); }
    catch { if (!controller.signal.aborted) setError('无法解析这个地址，请选择其他地点或检查高德 Key。'); }
    finally { job.current = undefined; if (!controller.signal.aborted) setLoading(false); }
  }

  function result(place: Favorite, saved = false) {
    const distance = origin && place.point ? placeDistance(origin, place.point) : null;
    const proximity = distance === null ? '' : distance < 1000 ? Math.round(distance) + ' 米' : (distance / 1000).toFixed(1) + ' 公里';
    const detail = [proximity, place.address !== place.name && place.address].filter(Boolean).join(' · ');
    return <button type="button" className="place-option" key={place.point?.poiId ?? JSON.stringify([place.name, place.address, place.point])}
      aria-label={'选择' + place.name} aria-description={detail || undefined} disabled={loading} onClick={() => void pick(place)}>
      <span className="place-symbol"><Icon name={saved ? 'home' : 'locate'} size={17} /></span>
      <span className="place-lines"><strong>{place.name}</strong>{detail && <small>{detail}</small>}</span>
    </button>;
  }
  if (configure) return <AmapKeySheet close={() => setConfigure(false)} />;
  return <Sheet title={adding ? '新增常用地址' : '选择导航目的地'} close={close} showClose className="place-search-sheet">
    <div className="place-search-field"><Icon name="search" size={18} />
      <input type="search" value={text} aria-label={adding ? '搜索地址' : '搜索目的地'} placeholder="搜索地点、地址或高德坐标"
        autoComplete="off" enterKeyHint="search" maxLength={120} disabled={loading}
        onChange={e => { setText(e.target.value); setError(''); }}
        onKeyDown={e => { if (e.key === 'ArrowDown') { e.preventDefault(); results.current?.querySelector('button')?.focus(); } }} /></div>
    <div className="place-search-results" ref={results}>
      {!!favorites.length && <section><h3>常用地址</h3>{favorites.map(p => result(p, true))}</section>}
      {!!places.length && <section aria-label={term ? '地点候选' : '附近地点'}><h3>{term ? '地点候选' : '附近地点'}</h3>{places.map(p => result(p))}</section>}
      {coordinate && <button type="button" className="place-manual" disabled={loading} onClick={() => void pick({ name: term, address: term, point: coordinate })}>
        <Icon name="locate" size={16} />使用此坐标 · {term}</button>}
      {remote.loading && <p className="place-notice" role="status">{term ? '正在搜索…' : '正在查找附近地点…'}</p>}
      {remote.failed && <p className="place-notice" role="status">地点加载失败，请检查网络或高德 Key。</p>}
      {!term && !!config.key && !places.length && !remote.loading && !remote.failed && <p className="place-notice" role="status">
        {origin ? '附近暂无地点，可以输入名称搜索。' : '暂无车辆定位，可以输入名称搜索。'}</p>}
      {term && !coordinate && !favorites.length && !places.length && canSearch && !remote.loading && !remote.failed && <p className="place-notice" role="status">未找到匹配地点</p>}
      {term && !coordinate && (adding || config.key) && <button type="button" className="place-manual" disabled={loading}
        onClick={() => void pick({ name: term, address: term })}><Icon name="edit" size={16} />使用输入的地址</button>}
      {(!config.key && !m.simulated || remote.failed) && <button type="button" className="place-manual" onClick={() => setConfigure(true)}>
        <Icon name="gear" size={16} />配置高德搜索</button>}
      {(loading || error) && <p className="place-notice" role="status">{error || '正在解析地址…'}</p>}
    </div>
  </Sheet>;
}
