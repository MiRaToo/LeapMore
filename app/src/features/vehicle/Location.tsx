import { useQuery } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useModelContext } from '../context';
import { ControlNotice, useCommands } from './commands';
import { useVehicleControls } from './controls';
import { AmapView } from './AmapView';
import { AmapKeySheet, useAmapKey } from './AmapKey';
import { openAmapNavigation, useAmapAddress } from './amapServices';
import { PlaceSearchSheet } from './PlaceSearchSheet';
import type { Favorite } from '../../data/preferences';
import { readSetting } from '../../data/localDatabase';
import { AppBar, Hint, Row, Section, Sheet, SheetButtons, stamp } from '../../ui/components';
import { Icon } from '../../ui/Icon';
import { mapPoint, resolveDestination } from './navigationDestination';

export { mapPoint } from './navigationDestination';
export function ParkingPhoto({ close }: { close: () => void }) {
  const m = useModelContext();
  const photo = useQuery({
    queryKey: ['cloud', 'parking-photo', m.vehicleId],
    queryFn: () => m.client!.getParkingPhoto(m.vehicleId),
    enabled: !!m.client && m.canSee('location'), retry: false, gcTime: 0,
  });
  const known = photo.data?.url?.startsWith('https://') ? photo.data.url : null;
  return <Sheet close={close} title="驻车照片">
    {known ? <img className="parking-photo" alt="车辆驻车照片" referrerPolicy="no-referrer" src={known} />
      : <p className="confirm-desc">{photo.isFetching ? '正在读取驻车照片…' : '当前数据源暂无驻车照片。'}</p>}
    <button className="btn ghost" onClick={close}>关闭</button>
  </Sheet>;
}
export function LocationPage() {
  const m = useModelContext();
  const { find, reason } = useVehicleControls();
  const command = useCommands();
  const [configureKey, setConfigureKey] = useState(false);
  const navigationJob = useRef<AbortController | null>(null);
  const [loadingDestination, setLoadingDestination] = useState(false);
  const { key } = useAmapKey();
  useEffect(() => {
    setLoadingDestination(false);
    return () => { navigationJob.current?.abort(); navigationJob.current = null; };
  }, [m.vehicleId]);
  async function navigateTo(fav: Favorite) {
    const confirmation = { kind: 'navigation' as const, title: '发送导航到' + fav.name, description: fav.address, icon: 'locate' as const };
    if (m.simulated) { command.ask(confirmation); return; }
    if (!key && !fav.point) { setConfigureKey(true); return; }
    if (navigationJob.current && !navigationJob.current.signal.aborted) return;
    const job = new AbortController();
    navigationJob.current = job;
    setLoadingDestination(true);
    try {
      const destination = await resolveDestination(fav, key, m.vehicle?.abilities, job.signal);
      if (job.signal.aborted) return;
      command.ask({ ...confirmation, description: destination.address, remote: { kind: 'navigation', destination } });
    } catch {
      if (!job.signal.aborted) m.setToast('无法解析常用地址，请检查地址和高德 Key。');
    } finally {
      if (navigationJob.current === job) { navigationJob.current = null; setLoadingDestination(false); }
    }
  }
  const permitted = m.canSee('location');
  const raw = permitted ? m.current.location : null;
  const point = raw && raw.coordinate !== 'unknown' ? mapPoint(raw) : null;
  const formatted = raw ? raw.lat.toFixed(m.simulated ? 4 : 6) + ', ' + raw.lon.toFixed(m.simulated ? 4 : 6) : '暂无定位';
  const updated = raw ? m.simulated ? '2 分钟前' : stamp(raw.at) : '';
  const addressResult = useAmapAddress(point, !m.simulated);
  const demoAddress = m.simulated && key && raw;
  const addressLabel = demoAddress ? '上海市浦东新区花木路 · 精度约 15 米' : addressResult.data;
  return <><AppBar title="车辆位置" back="/home" sub={updated ? '定位 ' + updated : undefined} /><div className="page no-nav location-page">
    {!permitted ? <div className="card grant-card"><div className="confirm-ic"><Icon name="locate" /></div><b>车辆定位未授权</b>
      <Link className="link" to="/vehicle-access">查看车辆授权</Link></div> :
      <>
        <ControlNotice />
        <div className="bigmap location-map">
          {point ? <AmapView lat={point.lat} lon={point.lon} height={300} name="车辆位置" illustrated={m.simulated} /> :
            <p className="location-map-empty">{raw ? '坐标系未知，暂无法在地图定位。' : '尚未读取到车辆定位。'}</p>}
        </div>
        <section className="card location-card">
          <div className="location-summary"><div>
            <h2>{demoAddress ? '停车位 · 世纪公园' : addressLabel ? '车辆位置' : raw ? '坐标位置' : '暂无定位'}</h2>
            <p className="tiny muted">{addressLabel || (raw ? formatted + (!key ? ' · 未配置高德 Key，无法解析地址' : '') : '等待车辆位置更新，可检查定位实体映射。')}</p>
          </div>{updated && <span className="pill">{updated}</span>}</div>
          <div className="loc-actions">
            <button className="btn secondary sm" disabled={!point} onClick={() => {
              if (point) void openAmapNavigation(point, '车辆位置').catch(() => m.setToast('暂时无法打开高德地图'));
            }}>导航</button>
            <button className="btn secondary sm" disabled={!!reason('find')} onClick={find}>鸣笛寻车</button>
          </div>
        </section>
        {!key && <Hint>没有高德 Key 时只能显示坐标，无法把 GPS 解析成地址。<button className="link" onClick={() => setConfigureKey(true)}>去配置</button></Hint>}
        {addressResult.isError && <Hint kind="warn" icon="alert">地址解析失败，当前显示坐标。<button className="link" onClick={() => setConfigureKey(true)}>检查高德 Key</button></Hint>}
        <FavoriteAddresses key={m.profileScope + ':' + m.vehicleId} blocked={loadingDestination || !!reason('navigation')} navigateTo={navigateTo} />
        <details className="inline-details"><summary>定位说明</summary><p>地库或弱信号时，请留意最近的定位时间。</p></details>
      </>}
    {configureKey && <AmapKeySheet close={() => setConfigureKey(false)} />}
  </div></>;
}

function FavoriteAddresses({ blocked, navigateTo }: { blocked: boolean; navigateTo: (place: Favorite) => void }) {
  const m = useModelContext();
  const [editing, setEditing] = useState(false);
  const [remove, setRemove] = useState<Favorite>();
  const [step, setStep] = useState<'search' | 'name'>();
  const [selected, setSelected] = useState<Favorite>();
  const [name, setName] = useState('');
  const icons = ['home', 'car', 'bolt'] as const;
  function start() { setSelected(undefined); setName(''); setStep('search'); }
  return <>
    <Section className="location-favorites" title={<>常用地址<button type="button" className="link more" aria-pressed={editing}
      onClick={() => setEditing(!editing)}>{editing ? '完成' : '管理'}</button></>}>
      {editing && Object.keys(readSetting<Record<string, Favorite[]>>('favorites', {})).length > 0 &&
        <p className="tiny muted">旧版常用地址未记录所属账号，请为当前账号重新添加。</p>}
      {m.favorites.map((fav, i) => editing ? <div className="row favorite-edit-row" key={i}>
        <span className="ic"><Icon name={icons[i] ?? 'locate'} size={19} /></span>
        <span className="t">{fav.name}<small>{fav.address}</small></span>
        <button type="button" className="favorite-delete" aria-label={'删除' + fav.name} onClick={() => setRemove(fav)}><Icon name="trash" size={17} /></button>
      </div> : <Row key={i} icon={icons[i] ?? 'locate'} title={fav.name} sub={fav.address} right="发送导航" label={'发送导航到' + fav.name}
        disabled={blocked} onClick={() => navigateTo(fav)} />)}
      {!m.favorites.length && <p className="tiny muted">暂无常用地址</p>}
      <button type="button" className="favorite-add" onClick={start}><Icon name="plus" size={18} />新增地址</button>
    </Section>
    {step === 'search' && <PlaceSearchSheet adding initialQuery={selected?.name} close={() => setStep(selected ? 'name' : undefined)}
      choose={place => {
        if (!name || name === selected?.name.slice(0, 30)) setName(place.name.slice(0, 30));
        setSelected(place);
        setStep('name');
      }} />}
    {step === 'name' && selected && <Sheet title="保存常用地址" close={() => setStep(undefined)} showClose>
      <Row icon="locate" title={selected.name} sub={selected.address !== selected.name ? selected.address : undefined} right="更换" label="更换地点" onClick={() => setStep('search')} />
      <label className="prep-field">名称<input aria-label="名称" maxLength={30} value={name} onChange={e => setName(e.target.value)} placeholder="家、公司或地点名称" /></label>
      <button type="button" className="btn accent" disabled={!name.trim()} onClick={() => {
        m.setFavorites([...m.favorites, { ...selected, name: name.trim(), address: selected.address && selected.address !== selected.name ? selected.address + ' · ' + selected.name : selected.name }]);
        setStep(undefined);
      }}>保存地址</button>
    </Sheet>}
    {remove && <Sheet title={'删除「' + remove.name + '」？'} sub={remove.address} close={() => setRemove(undefined)}>
      <SheetButtons cancel={() => setRemove(undefined)} label="删除" action={() => {
        const index = m.favorites.findIndex(fav => fav.name === remove.name && fav.address === remove.address &&
          fav.point?.lat === remove.point?.lat && fav.point?.lon === remove.point?.lon);
        if (index >= 0) m.setFavorites(m.favorites.filter((_, i) => i !== index));
        setRemove(undefined);
      }} /></Sheet>}
  </>;
}
