import { useEffect, useId, useRef, useState } from 'react';
import type { RefObject } from 'react';
import { Link } from 'react-router-dom';
import { useModelContext } from '../context';
import { ControlNotice } from './commands';
import { chargeLabels, presets, QuickButton, useVehicleControls } from './controls';
import { Hint, Sheet, stamp, value } from '../../ui/components';
import { Icon } from '../../ui/Icon';
import type { IconName } from '../../ui/Icon';
import { ParkingPhoto, mapPoint } from './Location';
import { AmapView, homeMapAnchor } from './AmapView';
import { useAmapAddress } from './amapServices';
import { useChargingConfig, usePreheatSchedules } from './chargeSchedules';

function Meter({ percent, icon, range }: { percent: number | null; icon: 'battery' | 'fuel'; range?: number | null }) {
  return <div className="dual-col"><div className="dual-head"><Icon name={icon} size={16} /><b className="num">{value(percent)}{percent !== null && '%'}</b>
    {range !== undefined && <span className="dual-range">{value(range)} km</span>}</div>
    <div className={'soc-bar ' + (icon === 'fuel' ? 'fuel' : '')}><b style={{ width: Math.min(100, Math.max(0, percent ?? 0)) + '%' }} /></div></div>;
}
export function Tires({ close }: { close: () => void }) {
  const { current, tireRange, tireAlerts, setTireRange } = useModelContext();
  const [editing, setEditing] = useState(false);
  const [min, setMin] = useState(String(tireRange.min));
  const [max, setMax] = useState(String(tireRange.max));
  const minimum = Number(min), maximum = Number(max);
  const valid = Number.isSafeInteger(minimum) && Number.isSafeInteger(maximum) && minimum > 0 && minimum < maximum;
  return <Sheet title="胎压" sub="车头朝前 · 冷胎胎压" close={close} showClose className="tire-sheet">
    <div className="tire-diagram">
      <svg className="tire-car" viewBox="0 0 100 180" aria-label="车辆顶视图"><rect x="22" y="8" width="56" height="164" rx="24" fill="var(--bg-soft)" stroke="var(--line-strong)" strokeWidth="2" />
        <path d="M29 46 Q50 32 71 46L66 65H34ZM34 115h32l5 23Q50 146 29 138Z" fill="var(--line-strong)" />
        <path d="M50 18l-7 9h14Z" fill="var(--accent)" />
        {[21, 73].map(x => [37, 124].map(y => <rect key={x + ':' + y} x={x} y={y} width="7" height="23" rx="2" fill="var(--text2)" />))}</svg>
      {['左前', '右前', '左后', '右后'].map((label, index) => <div className={'tire tire-point tire-' + index} data-pressure-alert={tireAlerts[index] || undefined} key={label}>
        <span>{label}</span><b>{value(current.tires[index])}</b><small>{tireAlerts[index] ? 'kPa · 异常' : 'kPa'}</small>
      </div>)}
    </div><div className="tire-footer"><span className="tiny muted">提醒范围 {tireRange.min}–{tireRange.max} kPa</span>
      <button className="link" aria-expanded={editing} onClick={() => { setMin(String(tireRange.min)); setMax(String(tireRange.max)); setEditing(!editing); }}>
        {editing ? '取消' : '设置范围'}</button></div>
    {editing && <form className="tire-range" onSubmit={e => { e.preventDefault(); if (valid) { setTireRange({ min: minimum, max: maximum }); setEditing(false); } }}>
      <label>最低胎压（kPa）<input type="number" inputMode="numeric" min={1} step={1} value={min} onChange={e => setMin(e.target.value)} /></label>
      <label>最高胎压（kPa）<input type="number" inputMode="numeric" min={1} step={1} value={max} onChange={e => setMax(e.target.value)} /></label>
      <button type="submit" className="btn accent sm" disabled={!valid}>保存范围</button>
      <span className="tiny muted">以车辆铭牌标注的冷胎压力为准。</span>
    </form>}
  </Sheet>;
}
function Entry({ icon, title, to, action, alert, scheduled }: { icon: IconName; title: string; to?: string; action?: () => void; alert?: boolean; scheduled?: boolean }) {
  const body = <><span className="entry-ic"><Icon name={icon} size={21} /></span><span className="entry-title">{title}</span></>;
  return to ? <Link className="card entry" to={to} data-scheduled={scheduled || undefined} aria-description={scheduled ? '已开启充电或电池预热预约' : undefined}>{body}</Link> :
    <button className="card entry" data-pressure-alert={alert || undefined} aria-description={alert ? '胎压异常' : undefined} onClick={action}>{body}</button>;
}
export function Home({ active, modelSlot }: { active: boolean; modelSlot: RefObject<HTMLDivElement> }) {
  const model = useModelContext();
  const c = useVehicleControls();
  const chargePlan = useChargingConfig(active);
  const { schedules: preheat } = usePreheatSchedules(active);
  const scheduled = model.canSee('control') && ((model.simulated ? c.settings.schedule : chargePlan.data?.enabled) || preheat.data?.some(plan => plan.enabled));
  const v = model.current;
  const [edit, setEdit] = useState(false);
  const [nickname, setNickname] = useState(model.name);
  const [preset, showPreset] = useState(false);
  const presetTrigger = useRef<HTMLButtonElement>(null);
  const presetId = useId();
  const [tires, showTires] = useState(false);
  const [picture, showPicture] = useState(false);
  useEffect(() => {
    if (!active) { setEdit(false); showPreset(false); showTires(false); showPicture(false); }
  }, [active]);
  useEffect(() => {
    if (!active || !preset) return;
    const hide = (e: PointerEvent) => {
      if (!presetTrigger.current?.contains(e.target as Node) && !(e.target as Element).closest('.preset-bubble')) showPreset(false);
    };
    const escape = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      showPreset(false);
      presetTrigger.current?.focus();
    };
    document.addEventListener('pointerdown', hide);
    document.addEventListener('keydown', escape);
    return () => { document.removeEventListener('pointerdown', hide); document.removeEventListener('keydown', escape); };
  }, [active, preset]);
  function saveName() { if (model.vehicle && nickname.trim()) model.rename(model.vehicle, nickname); setEdit(false); }
  const controlBlocked = !!c.reason('climate');
  const point = v.location && v.location.coordinate !== 'unknown' ? mapPoint(v.location) : null;
  const { data: locationAddress, hasKey } = useAmapAddress(point, active && model.canSee('location') && !model.simulated);
  const mapTitle = locationAddress ? locationAddress.length > 8 ? '…' + locationAddress.slice(-8) : locationAddress : '车辆位置';
  const reev = v.powertrain === 'reev';
  return <div className="home">
    <div className="hero">
      <header className="hero-top"><div className="hero-title"><div className="name">
        {edit ? <input className="name-input" autoFocus value={nickname} maxLength={10} aria-label="车辆昵称"
          onChange={e => setNickname(e.target.value)} onBlur={saveName} onKeyDown={e => { if (e.key === 'Enter') saveName(); if (e.key === 'Escape') setEdit(false); }} /> :
          <button className="name-btn" title="双击修改昵称" onDoubleClick={() => { setNickname(model.name); setEdit(true); }}>{model.name}</button>}
        <Link className="name-chev" to="/vehicles" aria-label="切换车辆"><Icon name="chevrond" size={17} /></Link></div>
        <div className="sub">{!model.simulated && model.scenario === 'stale' ? '上次车况' : '状态更新'} · {model.scenario === 'offline' ? (v.at || model.simulated ? '缓存' : '暂无车况') : model.simulated ? '今天 20:35' : stamp(v.at)}</div></div>
        <div className="hero-tools">
          <div className="hero-status">
            <span className="hero-state" data-active={v.driving || undefined}><i aria-hidden="true" />{v.driving == null ? '状态未知' : v.driving ? '行驶中' : '已驻车'}</span>
            <Link className="hero-charge" data-active={v.charging === 'charging' || v.charging === 'done' || undefined} to="/charging">
              <Icon name={v.charging === 'charging' ? 'bolt' : 'plug'} size={14} />{chargeLabels[v.charging]}</Link>
          </div>
          <button className="hero-refresh" aria-label="刷新" aria-busy={model.refreshing} disabled={model.refreshing}
            onClick={() => void model.refresh(true)}><Icon name="refresh" size={17} /></button>
        </div>
      </header>
      <div className="hero-metrics">
        {reev ? <div className="dual-soc"><Meter percent={v.soc} range={v.electricRange} icon="battery" /><Meter percent={v.fuel} range={v.fuelRange} icon="fuel" /></div> :
          <div className="soc-line"><Icon name="battery" size={18} /><span className="soc-text num">{value(v.soc)}{v.soc !== null && '%'}</span>
            <div className="soc-bar"><b style={{ width: Math.min(100, Math.max(0, v.soc ?? 0)) + '%' }} /></div></div>}
        <div className="energy-val num">{value(v.range)}<i>km</i></div>
        <div className="hero-lock"><button className="lock-state" disabled={!!c.reason('lock')} onClick={c.lock}>
          <Icon name={c.locked === false ? 'doorUnlock' : 'doorLock'} size={17} />
          <span className={c.locked === false ? 'lock-open-status' : undefined}>{c.locked === null ? '锁状态未知' : c.locked ? '车门已锁' : '车门未锁'}</span></button>
          {model.scenario === 'pending' && <div className="pending-lock"><span className="pill pending">待车端确认</span></div>}</div>
      </div>
      <div className="home-model-slot" ref={modelSlot} aria-hidden="true" />
      <div className="hero-actions">
        <QuickButton icon={c.locked === false ? 'doorLock' : 'doorUnlock'} label={c.locked === false ? '上锁' : '解锁'} title={c.lockTitle}
          status={c.locked === null ? '车门锁状态未知' : c.locked ? '车门已锁' : '车门未锁'} active={c.locked === false} onClick={c.lock} disabled={!!c.reason('lock')} />
        <QuickButton icon={c.trunk ? 'tailgateOpen' : 'tailgate'} label="后备箱" title={c.trunkTitle}
          status={c.trunk === null ? '后备箱状态未知' : c.trunk ? '后备箱未关' : '后备箱已关'} active={c.trunk === true} onClick={c.toggleTrunk} disabled={controlBlocked} />
        <QuickButton icon={c.window.icon} label="车窗" title="车窗" status={c.window.status} active={c.windowOpen}
          onClick={() => c.setSheet('windows')} disabled={controlBlocked} />
        <QuickButton icon={c.shadeOpen ? 'roofShadeOpen' : 'roofShade'} label="遮阳帘" title="遮阳帘"
          status={c.shadeOpen === null ? '遮阳帘状态未知' : c.shadeOpen ? '遮阳帘未关' : '遮阳帘已关'} active={c.shadeOpen === true} onClick={c.shade} disabled={controlBlocked} />
      </div>
    </div>
    <div className="home-cards">
      <ControlNotice />
      {model.simulated && model.scenario === 'stale' && <Hint kind="warn" icon="clock">数据可能过期 · 38 分钟前</Hint>}
      <div className="grid2">
        <section className="card climate"><div className="ch-top"><Link to="/climate"><div className="temp-main num">{value(v.inside, 1)}<i>℃</i></div><div className="temp-label">车内温度</div></Link>
          <button className={'fan-btn' + (c.climateOn ? ' on' : '')} aria-label="空调开关" disabled={controlBlocked} onClick={c.toggleClimate}><Icon name="climateFan" size={21} /></button></div>
          <Link className="temp-target num" to="/climate" aria-label={'空调目标温度 ' + (c.targetTemp === null ? '未上报' : c.targetTemp + '℃')}>{value(c.targetTemp, 1)}<i>℃</i></Link>
          <div className="preset-actions"><button ref={presetTrigger} className={'round-btn' + (preset ? ' on' : '')} disabled={controlBlocked}
            onClick={() => showPreset(!preset)} aria-label="空调预设" aria-expanded={preset} aria-controls={preset ? presetId : undefined}><Icon name="climatePresets" size={19} /></button>
            {preset && <div className="preset-bubble" id={presetId} role="group" aria-label="空调预设选项">{presets.map(p =>
              <button key={p[0]} className={'preset-opt' + (c.settings.climate.preset === p[0] ? ' on' : '')}
                onClick={() => { showPreset(false); c.preset(p); }}><span className="ic"><Icon name={p[1]} size={16} /></span>{p[0]}</button>)}</div>}
            {c.hasComfort && <button className="round-btn" disabled={controlBlocked} onClick={() => { showPreset(false); c.setSheet('seat'); }} aria-label="座椅与加热"><Icon name="seatComfort" size={19} /></button>}</div>
        </section>
        {model.canSee('location') ? <div className="card map-card">
          <Link to="/location" className="home-map-link" aria-label="查看车辆位置">
            {active && (point ? <div className="home-mini-map"><AmapView lat={point.lat} lon={point.lon} height="100%" preview illustrated={model.simulated} /></div> : <div className="map-bg" />)}
            {hasKey && <span className="map-top" title={locationAddress}><span className="map-title">{mapTitle}</span></span>}
            {(point || model.simulated) && <span className="map-pin" aria-hidden="true" style={{ left: 100 * homeMapAnchor.x + '%', top: 100 * homeMapAnchor.y + '%' }}><Icon name="car" size={18} /></span>}
            <span className="map-time">{model.simulated ? '2 分钟前' : v.location?.at ? stamp(v.location.at) : v.location ? '更新时间未知' : '暂无定位'}</span>
          </Link>
          <div className="map-pills"><button className="map-pill" onClick={() => showPicture(true)}><Icon name="camera" size={13} />驻车照片</button>
            <button className="map-pill" disabled={controlBlocked} onClick={c.find}><Icon name="carHorn" size={13} />鸣笛寻车</button>
          </div></div> :
          <div className="card grant-card"><div className="confirm-ic"><Icon name="locate" /></div><b>车辆定位未授权</b>
            <Link className="link" to="/vehicle-access">查看车辆授权</Link>{!controlBlocked && <button className="map-pill" onClick={c.find}>鸣笛寻车</button>}</div>}
      </div>
      <div className="home-entries">
        <Entry icon="plug" title="充电" to="/charging" scheduled={!!scheduled} />
        <Entry icon="tirePressure" title="胎压" alert={model.tireAlerts.some(Boolean)} action={() => showTires(true)} />
        <Entry icon="climatePresets" title="控制" to="/control" />
        <Entry icon="palette" title="外观" to="/appearance" />
      </div>
      <div className="home-caption">{model.mode === 'ha' ? <Link className="link" to="/login">登录零跑查看实时车况</Link> :
        <span>{model.simulated ? '模拟数据' : '数据来自零跑云'} · 非官方客户端</span>}</div>
    </div>
    {active && tires && <Tires close={() => showTires(false)} />}{active && picture && <ParkingPhoto close={() => showPicture(false)} />}
  </div>;
}
