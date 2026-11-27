import { useEffect, useState } from 'react';
import type { Dispatch, RefObject, SetStateAction } from 'react';
import { Link } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { useModelContext } from '../context';
import { MarketPicker } from './MarketPicker';
import { WrapEditor } from './WrapEditor';
import type { Face, ModelStatus, useVehicleVisual } from './VehicleModel';
import { Seg } from '../../ui/components';
import { Icon } from '../../ui/Icon';

const paints = [
  ['金属黑', '#353535'], ['天幕灰', '#14192F'], ['珍珠白', '#FFFFFF'], ['苔原灰', '#C4C4BC'], ['春芽绿', '#D2FFC6'], ['仙踪绿', '#FFFFFF'],
  ['冰川蓝', '#ADCEE9'], ['星煜紫', '#2A1130'], ['香草白', '#FFF3D2'], ['苍松翠', '#072217'], ['光白', '#FFFFFF'], ['松岚灰', '#7E909A'],
  ['星河银', '#D4E5ED'], ['星辉银', '#A9ABC4'], ['曦露紫', '#725972'], ['漫宇蓝', '#52678E'], ['摩卡粉', '#CBB0A7'],
] as const;
const backgrounds = [['auto', '跟随主题'], ['day', '日间'], ['night', '夜间'], ['studio', '影棚'], ['aurora', '极光']] as const;
function hsv(h: number, s: number, v: number) {
  const k = (n: number) => (n + h / 60) % 6;
  const component = (n: number) => Math.round(255 * (v - v * s * Math.max(0, Math.min(k(n), 4 - k(n), 1)))).toString(16).padStart(2, '0');
  return '#' + component(5) + component(3) + component(1);
}

export type AppearancePanel = 'settings' | 'paint' | 'wrap' | null;
export function AppearancePage({ active, show, setShow, visual, setPaused, modelStatus, modelSlot, focusFace }: {
  show: AppearancePanel; setShow: Dispatch<SetStateAction<AppearancePanel>>;
  active: boolean; visual: ReturnType<typeof useVehicleVisual>; setPaused: (paused: boolean) => void;
  modelStatus: ModelStatus; modelSlot: RefObject<HTMLDivElement>; focusFace: (face: Face) => void;
}) {
  const m = useModelContext();
  const qc = useQueryClient();
  useEffect(() => { if (active) setShow('settings'); }, [active, setShow]);
  const { mode, setMode, background, setBackground, quality, setQuality, wrap, setWrap, market, cloud, paint: shownPaint } = visual;
  const [color, setColor] = useState({ h: 258, s: .64, v: 1 });
  const [status, setStatus] = useState('');
  const rendering = modelStatus === 'full';
  async function clearModel() {
    setPaused(true);
    try {
      await qc.cancelQueries({ queryKey: visual.queryKey });
      if (m.client) await (await import('../../data/cloud/cloud3d')).dropCloud3D(m.vehicleId);
      qc.removeQueries({ queryKey: visual.queryKey });
      setStatus('已清理下载的车模缓存。');
    } catch { setStatus('未找到已下载的车模，或缓存无法清理。'); }
  }
  function setCustom(h: number, s: number, v: number) { setColor({ h, s, v }); m.setPaint(hsv(h, s, v), '自定义'); }
  const viewName = !rendering && mode === '2d' ? market?.model ?? visual.modelName : visual.modelName;
  const paintList = visual.colors.length ? visual.colors.map(row => [row.name, row.hex] as const) : paints;
  const panelTitle = show === 'paint' ? '自定义车漆' : mode === '3d' ? '3D 设置' : '外观设置';
  const show3DSettings = mode === '3d' && !visual.autoPicture;
  const previewTip = {
    full: '拖动旋转 · 双指缩放 · 双击复位',
    loading: visual.autoPicture ? '正在读取车辆外观图' : '正在加载 3D 车模',
    unavailable: visual.autoPicture ? '暂无可用外观图' : '当前无可用 3D 模型',
    '2d': visual.autoPicture ? '云端本次提供 2D 外观' : '2D 商城外观',
  }[modelStatus];
  return <div className="stage3d appearance-layout" data-settings-open={!!show} data-wrap-editor={show === 'wrap' || undefined}>
    <div className="appearance-preview" ref={modelSlot} data-scene={mode === '3d' ? visual.scene : undefined}>
    <div className="hud"><Link className="iconbtn glass" to="/home" aria-label="返回"><Icon name="back" size={21} /></Link><div className="appearance-tools">
      <button className="iconbtn glass" onClick={() => { setPaused(false); setMode(mode === '3d' ? '2d' : '3d'); if (show === 'wrap') setShow('settings'); }} aria-label="切换静态图"><Icon name="file" size={18} /></button>
      <button className="iconbtn glass" onClick={() => setShow(active => active === 'settings' ? null : 'settings')} aria-label="3D 设置"
        aria-expanded={!!show} aria-controls={show ? 'appearance-settings' : undefined}><Icon name="gear" size={18} /></button></div></div>
    <div className="c3d-tip">{previewTip}</div>
    </div>
    <div className="appearance-controls" key={show ?? 'closed'}>
    {!show && <div className="card"><div className="between"><div><b>{viewName} · {show3DSettings ? '3D' : '2D'} 车模</b>
      <div className="tiny muted">{visual.autoPicture ? '官方车辆外观' : cloud.isError && mode === '3d' ? '暂未读到本车 3D 素材' : rendering ? '官方查看器' : status || market?.trim || '车辆外观'}</div></div>{rendering && <span className="pill green">{cloud.data ? '已缓存' : '本地样例'}</span>}</div>
      {!visual.autoPicture && <><div className="divider" /><div className="c3d-actions">
        {mode === '3d' ? <>
          <button className="c3d-chip" onClick={() => setShow('settings')}><i className="sw" style={{ background: shownPaint.hex }} />车漆 · {shownPaint.name}</button>
          <button className="c3d-chip" onClick={() => setShow('settings')}><Icon name="sun" size={14} />{backgrounds.find(b => b[0] === background)?.[1]}</button>
          <button className="c3d-chip" onClick={() => setShow('wrap')}><Icon name="shield" size={14} />{Object.keys(wrap).length ? '自定义车衣' : '原厂车衣'}</button>
        </> : <button className="c3d-chip" onClick={() => setShow('settings')}><Icon name="palette" size={14} />{market?.color || '商城车漆'}</button>}
      </div></>}</div>}
    {show === 'wrap' && <WrapEditor key={m.vehicleId} vehicleId={m.vehicleId} visual={visual} ready={rendering}
      focusFace={focusFace} finish={() => setShow('settings')} />}
    {show && show !== 'wrap' && <section className="card appearance-sheet" id="appearance-settings" aria-label={panelTitle}>
      <header className="appearance-panel-heading">
        <div><h2>{panelTitle}</h2><span className="tiny muted">{viewName} · {mode === '3d' ? '3D' : '2D'} 车模</span></div>
        {rendering && <span className="pill green">{cloud.data ? '已缓存' : '本地样例'}</span>}
        <button className="iconbtn" aria-label={show === 'settings' ? '收起设置' : '返回设置'}
          onClick={() => setShow(show === 'settings' ? null : 'settings')}><Icon name={show === 'settings' ? 'x' : 'back'} size={17} /></button>
      </header>
    {show === 'settings' && <>
      {show3DSettings && <div className="c3d-sec"><div className="c3d-sec-h paint-heading">车漆 <span role="status">{shownPaint.name}</span></div>
      <div className="swatches" role="group" aria-label="原厂车漆">{paintList.map(([name, hex]) => <button key={name} className="swatch" title={name} aria-label={name}
        aria-pressed={shownPaint.name === name} onClick={() => m.setPaint(hex, name)}><i style={{ background: hex }} /><span><Icon name="check" size={12} /></span></button>)}
        <button className="swatch swatch-custom" aria-label="自定义车漆" onClick={() => setShow('paint')}><i><Icon name="plus" size={17} /></i></button></div></div>}
      <div className="c3d-sec"><div className="c3d-sec-h">车模显示</div><Seg options={[[ '3d', '自动 / 3D'], ['2d', '仅 2D']]} current={mode} choose={next => { setPaused(false); setMode(next); }} label="车模显示" /></div>
      {mode === '2d' && <MarketPicker key={m.vehicleId} selection={market} select={visual.setMarket} car={visual.modelName}
        year={m.vehicle?.year} energy={m.current.powertrain === 'reev' ? '增程' : '纯电'} />}
      {show3DSettings && <>
      <div className="c3d-sec"><div className="c3d-sec-h">背景</div><Seg options={backgrounds} current={background} choose={setBackground} label="背景" /></div>
      <div className="c3d-sec"><div className="c3d-sec-h">车衣</div><div className="seg"><button onClick={() => setWrap(() => ({}))} className={!Object.keys(wrap).length ? 'on' : ''}>原厂车漆</button><button onClick={() => setShow('wrap')}>自定义车衣</button></div></div>
      <div className="c3d-sec"><div className="c3d-sec-h">渲染</div><Seg options={[[ 'high', '高清'], ['power', '省电']]} current={quality} choose={setQuality} label="渲染" /></div>
      {cloud.data && <button className="link" onClick={() => void clearModel()}>清理模型缓存</button>}
      </>}
      {status && <p className="tiny muted" role="status">{status}</p>}
      <button className="btn ghost" onClick={() => setShow(null)}>完成</button>
    </>}
    {show === 'paint' && <>
      <div className="paint-picker" style={{ backgroundColor: 'hsl(' + color.h + ' 100% 50%)' }} aria-label="明度与饱和度"
        onPointerDown={e => {
          e.currentTarget.setPointerCapture(e.pointerId);
          const rect = e.currentTarget.getBoundingClientRect();
          setCustom(color.h, (e.clientX - rect.left) / rect.width, 1 - (e.clientY - rect.top) / rect.height);
        }} onPointerMove={e => {
          if (!e.currentTarget.hasPointerCapture(e.pointerId)) return;
          const rect = e.currentTarget.getBoundingClientRect();
          setCustom(color.h, Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width)), 1 - Math.min(1, Math.max(0, (e.clientY - rect.top) / rect.height)));
        }}><i style={{ left: color.s * 100 + '%', top: (1 - color.v) * 100 + '%' }} /></div>
      <label className="paint-channel hue-channel">色相<input className="cc-hue" type="range" min="0" max="359" value={color.h} onChange={e => setCustom(e.target.valueAsNumber, color.s, color.v)} /></label>
      <label className="paint-channel">饱和度<input type="range" min="0" max="100" value={color.s * 100} onChange={e => setCustom(color.h, e.target.valueAsNumber / 100, color.v)} /></label>
      <label className="paint-channel">明度<input type="range" min="0" max="100" value={color.v * 100} onChange={e => setCustom(color.h, color.s, e.target.valueAsNumber / 100)} /></label>
      <div className="c3d-actions"><button className="c3d-chip"><i className="sw" style={{ background: m.paint.hex }} />{m.paint.hex}</button></div>
      <button className="btn accent" onClick={() => setShow('settings')}>完成</button>
    </>}
    </section>}
    </div>
  </div>;
}
