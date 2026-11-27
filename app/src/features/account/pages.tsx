import { useEffect, useId, useRef, useState } from 'react';
import { Link, Navigate, useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { useModelContext } from '../context';
import { authorizeCloud, hasCloudSession, loadCloudSession } from './session';
import { sendSmsCode } from '../../data/cloud/LiveClient';
import { randomDeviceId } from '../../data/cloud/liveCrypto';
import { failureFacts, loginFailureMessage, type LoginStage } from '../../data/serviceFailure';
import { recordLoginFailure } from '../../platform/diagnostics';
import { readSetting } from '../../data/localDatabase';
import { LocalSessionStorageError } from '../../platform/secure';
import { AppBar, Hint, Row, Section, Seg, Sheet, SheetButtons, asset, hasLocalCarAssets } from '../../ui/components';
import { Icon } from '../../ui/Icon';
import type { IconName } from '../../ui/Icon';
import { capacityLimits, formatBatteryCapacity, validChargeEfficiency } from '../../data/vehicleEnergy';

export const grantsList = [
  ['basic', 'lock', '基础授权', '解锁、闭锁车辆'],
  ['control', 'car', '车辆控制', '快捷控车、充电、温控与备车'],
  ['location', 'locate', '车辆定位', '车辆位置与驻车照片'],
  ['mileage', 'chart', '里程能耗', '查看车辆里程和能耗'],
] as const;
export const disclaimer = 'LeapMore 是免费提供的非官方工具，与零跑汽车无隶属关系。车况来自你授权的数据源，历史记录存于本机。';
export function Login() {
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const model = useModelContext();
  const [form, setForm] = useState({ phone: '', code: '', agree: false });
  const [busy, setBusy] = useState<'sms' | 'login' | null>(null);
  const [note, setNote] = useState('');
  const [sentTo, setSentTo] = useState('');
  const [resend, setResend] = useState(0);
  const [terms, setTerms] = useState(false);
  const [canResume, setCanResume] = useState(false);
  const device = useRef<string | null>(null);
  useEffect(() => {
    let active = true;
    void hasCloudSession().then(saved => { if (active) setCanResume(saved); }).catch(() => {});
    return () => { active = false; };
  }, []);
  useEffect(() => {
    if (!resend) return;
    const timer = setTimeout(() => setResend(x => Math.max(0, x - 1)), 1000);
    return () => clearTimeout(timer);
  }, [resend]);
  const phoneValid = /^1\d{10}$/.test(form.phone);
  async function sms() {
    if (!phoneValid) { setNote('请输入 11 位手机号。'); return; }
    if (!form.agree) { setNote('请先阅读并同意用户协议与隐私说明。'); return; }
    setBusy('sms');
    try {
      device.current ??= randomDeviceId();
      await sendSmsCode(form.phone, device.current);
      setSentTo(form.phone);
      setResend(60);
      setNote('验证码已发送。');
    } catch (error) { recordLoginFailure(model.profileScope, 'sms', error, 'sms-send'); setNote(loginFailureMessage('sms-send', failureFacts(error))); }
    finally { setBusy(null); }
  }
  async function signIn() {
    if (!form.agree || !phoneValid || form.code.length !== 6 || sentTo !== form.phone) {
      setNote('请先同意条款，获取并填写短信验证码。'); return;
    }
    setBusy('login');
    let stage: LoginStage = 'sms-verify';
    try {
      model.chooseMode('cloud', await authorizeCloud(form.phone, form.code, device.current ?? randomDeviceId(), value => { stage = value; }));
      navigate('/vehicles', { replace: true });
    } catch (error) { recordLoginFailure(model.profileScope, 'login', error, stage); setNote(error instanceof LocalSessionStorageError ? error.message : loginFailureMessage(stage, failureFacts(error))); }
    finally { setBusy(null); }
  }
  async function resumeCloud() {
    setBusy('login');
    try {
      const session = await loadCloudSession();
      if (!session) { setCanResume(false); setNote('本机没有已保存的会话，请登录。'); return; }
      model.chooseMode('cloud', session);
      navigate(session.vehicles.some(v => v.id === model.vehicleId) ? '/home' : '/vehicles', { replace: true });
    } catch { setCanResume(false); setNote('无法恢复已保存的会话，请重新登录。'); }
    finally { setBusy(null); }
  }
  return <div className="login"><img className="login-brand" src={asset('leaplink-icon-simple.png')} alt="LeapMore" width={76} height={76} />
    <h1>{model.expired ? '重新登录' : '欢迎回来'}</h1><p className="lede">登录零跑账号，开始用车。</p>
    <form className="form" onSubmit={e => { e.preventDefault(); void signIn(); }}>
      <div className="field"><span className="prefix">+86</span><input aria-label="手机号" placeholder="手机号" type="tel" inputMode="tel" autoComplete="tel-national" value={form.phone}
        onChange={e => { setForm({ ...form, phone: e.target.value.replace(/\D/g, '').slice(0, 11), code: '' }); setSentTo(''); }} /></div>
      <div className="field"><input aria-label="验证码" placeholder="短信验证码" inputMode="numeric" autoComplete="one-time-code" value={form.code}
        onChange={e => setForm({ ...form, code: e.target.value.replace(/\D/g, '').slice(0, 6) })} />
        <button type="button" className="codebtn" onClick={() => void sms()} disabled={!!busy || resend > 0}>{resend ? resend + ' 秒后重试' : '获取验证码'}</button></div>
      <p className="login-feedback" role="status">{note}</p>
      <div className="consent"><button type="button" className={'chk ' + (form.agree ? 'on' : '')} role="checkbox" aria-checked={form.agree} aria-label="同意条款"
        onClick={() => setForm({ ...form, agree: !form.agree })}><Icon name="check" size={11} /></button>
        <div>我已阅读并同意<button type="button" className="link" onClick={() => setTerms(true)}>《用户协议》与《隐私政策》</button></div></div>
      <button type="submit" className="btn accent" disabled={!!busy}>{model.expired ? '重新登录' : '登录'}</button>
      <div className="why"><Link to="/subaccount">为什么要用<b>子账号</b>？</Link></div>
    </form>
    <div className="login-alternatives">
      <Link className="link" to="/states">故障诊断与导出</Link>
      <button className="link" disabled={busy === 'login'} onClick={() => { model.chooseMode('demo'); navigate('/vehicles', { replace: true }); }}>使用演示账号</button>
      <button className="link" disabled={busy === 'login'} onClick={() => { model.chooseMode('ha'); navigate('/ha'); }}>连接 Home Assistant</button>
      {canResume && !(model.mode === 'cloud' && model.expired) && <button className="link" disabled={busy === 'login'} onClick={() => void resumeCloud()}>继续使用已登录账号</button>}
    </div>
    {(pathname === '/welcome' || terms) && <Sheet title={terms ? '用户协议与隐私说明' : '欢迎使用 LeapMore'} close={terms ? () => setTerms(false) : undefined}>
      <p className="confirm-desc">{disclaimer}</p><p className="confirm-desc">使用零跑子账号可避免让官方 App 上的主账号下线。请确认只绑定你有权使用的车辆。</p>
      <button className="btn accent" onClick={() => { if (terms) setTerms(false); else navigate('/login', { replace: true }); }}>{terms ? '完成' : '我知道了'}</button>
    </Sheet>}
  </div>;
}
export function Subaccount() {
  return <><AppBar title="登录建议" back="/login" /><div className="page no-nav"><h2 className="page-title">建议使用子账号</h2>
    <Hint kind="warn" icon="alert">零跑云单账号单会话，主账号登录本应用会让手机上的官方 App 下线。</Hint>
    <Section><ol className="steps">{['用另一个手机号注册零跑账号。', '官方 App 用主账号把车分享给这个子账号。', '本应用登录子账号，官方 App 继续用主账号。'].map((step, i) =>
      <li className="stepItem" key={step}><span className="stepNo">{i + 1}</span><div className="small">{step}</div></li>)}</ol>
      <div className="divider" /><p className="small muted">基础授权必选，包含解锁和闭锁。车辆控制、车辆定位和里程能耗可分别开通。</p>
    </Section>
    <Link className="btn accent" to="/login">我准备好了</Link><Link className="btn ghost" to="/login">仍用主账号</Link>
  </div></>;
}
export function VehicleList({ manage = false }: { manage?: boolean }) {
  const model = useModelContext();
  const navigate = useNavigate();
  const [selection, setSelected] = useState(model.vehicle?.id);
  const [note, setNote] = useState('');
  const [settings, setSettings] = useSearchParams();
  const menu = model.vehicles;
  const selected = menu.some(vehicle => vehicle.id === selection) ? selection : model.vehicle?.id ?? menu[0]?.id;
  const canEditEnergy = manage && model.mode !== 'ha' && model.canSee('mileage');
  const capacitySetup = !manage && settings.get('setting') === 'capacity' && model.vehicle;
  const enterHome = () => navigate('/home', { replace: true });
  function enterVehicle() {
    const car = menu.find(vehicle => vehicle.id === selected);
    if (!car) return;
    model.setVehicleId(car.id);
    if (model.shouldGuideBatterySetup(car)) setSettings({ setting: 'capacity' }, { replace: true });
    else navigate('/home');
  }
  async function recheck() {
    try { await model.refreshVehicles(); setNote('已重新检查车辆。'); }
    catch { setNote('无法加载车辆，请稍后重试。'); }
  }
  if (capacitySetup && !model.shouldGuideBatterySetup(capacitySetup)) return <Navigate to="/home" replace />;
  return <><AppBar title={manage ? '车辆管理' : '选择车辆'} back={manage ? '/mine' : model.vehicle ? '/home' : '/login'} sub={manage ? '车辆与安全' : '已授权车辆'} />
    <div className="page no-nav">
      {manage && Object.keys(readSetting<Record<string, string>>('names', {})).length > 0 && <p className="tiny muted">旧版本机车辆名称未记录所属账号，因此不会自动显示，可重新设置。</p>}
      {model.expired || !menu.length || (model.simulated && model.scenario === 'offline') ?
        <Section className="vehicle-empty"><div className="confirm-ic"><Icon name={model.expired ? 'key' : 'car'} size={24} /></div>
          <h2>{model.expired ? '会话已失效' : model.vehiclesError || model.scenario === 'offline' ? '无法加载车辆' : '未找到已授权车辆'}</h2>
          <p>{model.expired ? '重新登录后可继续查看车况。' : model.vehiclesError ? '车辆列表读取失败，可重新检查或导出诊断。' : '请让主账号分享车辆，再重新检查。'}</p>
          {model.expired ? <Link className="btn accent" to="/login">重新登录</Link> :
            <><Link className="btn accent" to="/vehicle-access">查看车辆授权</Link><button className="btn ghost" onClick={() => void recheck()}>重新检查车辆</button></>}
          <Link className="link" to="/states">故障诊断与导出</Link><p role="status">{note}</p></Section> :
        <>
          {menu.map((car, i) => <button key={car.id} className={'vcard' + (selected === car.id ? ' selected' : '')} aria-pressed={selected === car.id}
            onClick={() => { setSelected(car.id); if (manage) model.setVehicleId(car.id); }}>
            {hasLocalCarAssets ? <img src={asset(car.model.includes('B10') ? 'b10.png' : 'c10.png')} alt="" /> :
              <span className="vcard-icon"><Icon name="car" size={30} /></span>}<span className="info"><span className="name">{car.id === model.vehicleId ? model.name : car.nickname}</span>
              <span className="meta">{car.model} {car.year || ''}{car.vin && ' · ••••' + car.vin.slice(-4)}</span>
              <span className="meta">{car.shared ? '共享车辆' : selected === car.id ? '当前车辆' : '授权车辆'}</span></span>
            <span className={'pill ' + (selected === car.id ? 'green' : '')}>{model.simulated && i ? '离线' : selected === car.id ? '已选' : '授权'}</span>
          </button>)}
          {!manage && <><Hint icon="shield">看不到车辆时，请在官方 App 检查共享状态。</Hint>
            <button className="btn accent" disabled={!selected} onClick={enterVehicle}>进入车辆</button></>}
        </>}
      {capacitySetup && <VehicleEnergySheet key={capacitySetup.id} setup onSave={enterHome}
        close={() => { model.skipBatterySetup(); enterHome(); }} />}
      {manage && model.mode === 'cloud' && model.operationScope && !model.expired && <Section title="动力类型">
        <Seg label="动力类型" options={[[ 'auto', '自动识别' ], [ 'bev', '纯电' ], [ 'reev', '增程' ]] as const}
          current={model.powertrainInfo.preference} choose={model.powertrainInfo.choose} />
        <p className="small muted">当前按{model.current.powertrain === 'reev' ? '增程' : '纯电'}显示。设置仅对本机当前账号的这辆车生效。</p>
      </Section>}
      {canEditEnergy && <Section title="电池与充电"><Row icon="battery" title="电池容量与充电效率"
        sub={model.energySettings.capacityKwh === null ? '选择车型配置或填写容量' :
          formatBatteryCapacity(model.energySettings.capacityKwh) + (model.energySettings.capacityBasis === 'published' ? ' kWh · 公开容量暂估' : ' kWh 可用容量')}
        onClick={() => setSettings({ setting: 'energy' })} /></Section>}
      {canEditEnergy && settings.get('setting') === 'energy' &&
        <VehicleEnergySheet key={model.vehicleId} close={() => setSettings({}, { replace: true })} />}
      {manage && <Section title="安全"><Link className="btn ghost" to="/operation-pin">操作密码</Link></Section>}
    </div>
  </>;
}

function VehicleEnergySheet({ close, onSave = close, setup = false }: { close: () => void; onSave?: () => void; setup?: boolean }) {
  const model = useModelContext();
  const [draft, setDraft] = useState(model.energySettings);
  const [issue, setIssue] = useState('');
  const [open, setOpen] = useState(false);
  const listId = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  const capacityInput = useRef<HTMLInputElement>(null);
  const choices = model.batteryPacks.choices;
  const preset = choices.find(pack => pack.kwh === draft.capacityKwh && pack.basis === draft.capacityBasis);
  function save() {
    const { capacityKwh, acEfficiency, dcEfficiency } = draft;
    if (setup && capacityKwh === null) {
      setIssue('请选择车型容量或手动填写。');
    } else if (capacityKwh !== null && !(capacityKwh >= capacityLimits.min && capacityKwh <= capacityLimits.max)) {
      setIssue(`电池可用容量须为 ${capacityLimits.min}–${capacityLimits.max} kWh。`);
    } else if (!validChargeEfficiency(acEfficiency) || !validChargeEfficiency(dcEfficiency)) {
      setIssue('交流和直流充电效率须为 50%–100%。');
    } else {
      model.setEnergySettings(draft);
      onSave();
    }
  }
  return <Sheet title={setup ? '选择电池容量' : '电池容量与充电效率'} sub={model.name} close={close} showClose={!setup} className="vehicle-energy-sheet">
    <p className="small muted">{setup ? '电池容量用于估算行程耗电和充入电量。稍后可在车辆管理修改。' :
      '可用容量用于按电量变化估算充入和消耗的电量。充电效率用于估算电网取电量和电费。'}</p>
    {choices.length > 0 && <div className="battery-picker" onKeyDown={event => {
      if (!open || event.key !== 'Escape') return;
      event.preventDefault();
      setOpen(false);
      trigger.current?.focus();
    }}>
      <div className="tiny muted">车型容量参考</div>
      <button type="button" className="battery-picker-trigger" ref={trigger} aria-expanded={open} aria-controls={listId}
        aria-label="车型容量参考" onClick={() => setOpen(!open)}>
        <span className="battery-picker-icon"><Icon name="battery" size={18} /></span>
        <span className="battery-picker-label">{preset?.label ?? (draft.capacityKwh === null ? '选择车型配置' : '手动填写')}</span>
        {preset && <b className="num">{formatBatteryCapacity(preset.kwh)} <small>kWh</small></b>}
        <Icon name="chevrond" size={15} />
      </button>
      <div className="battery-picker-options" id={listId} hidden={!open} role="group" aria-label="车型配置">
        {choices.map(pack => <button type="button" className="battery-picker-option" key={pack.label} aria-pressed={pack === preset}
          onClick={() => {
            setDraft(current => ({ ...current, capacityKwh: pack.kwh, capacityBasis: pack.basis }));
            setIssue('');
            setOpen(false);
            trigger.current?.focus();
          }}>
          <span><b>{pack.label}</b><small>{pack.basis === 'published' ? '公开容量' : '可用容量参考'}</small></span>
          <b className="num">{formatBatteryCapacity(pack.kwh)} <small>kWh</small></b>
          <span className="battery-picker-check">{pack === preset && <Icon name="check" size={14} />}</span>
        </button>)}
        <button type="button" className="battery-picker-option" onClick={() => {
          if (preset) setDraft(current => ({ ...current, capacityKwh: null, capacityBasis: undefined }));
          setIssue('');
          setOpen(false);
          capacityInput.current?.focus();
        }}><span>手动填写</span><Icon name="chevron" size={14} /></button>
      </div>
    </div>}
    <div className="tariff-grid">
      <label>{draft.capacityBasis === 'published' ? '容量估算值' : '电池可用容量'} · kWh
        <input ref={capacityInput} type="number" inputMode="decimal" step="0.01" min={capacityLimits.min} max={capacityLimits.max}
          value={draft.capacityKwh ?? ''} onChange={e => setDraft({ ...draft,
            capacityKwh: e.currentTarget.value ? e.currentTarget.valueAsNumber : null, capacityBasis: undefined })} /></label>
      {!setup && ([['acEfficiency', '交流充电效率 · %'], ['dcEfficiency', '直流充电效率 · %']] as const).map(([key, label]) =>
        <label key={key}>{label}<input type="number" inputMode="decimal" min="50" max="100" step="0.1"
          value={Number.isFinite(draft[key]) ? draft[key] : ''} onChange={e => setDraft({ ...draft, [key]: e.currentTarget.valueAsNumber })} /></label>)}
    </div>
    {choices.some(pack => pack.basis === 'published') && <p className="tiny muted">公开容量用于暂估电量，有实测可用容量时可直接填写。</p>}
    {issue && <p className="tiny error" role="alert">{issue}</p>}
    <SheetButtons cancel={close} action={save} cancelLabel={setup ? '稍后设置' : undefined} label={setup ? '保存并进入' : '保存设置'} />
  </Sheet>;
}

export function VehicleAccess() {
  const model = useModelContext();
  const { state } = useLocation();
  const [note, setNote] = useState('');
  const back = typeof state?.from === 'string' ? state.from : model.vehicle ? '/mine' : '/vehicles';
  async function refresh() {
    setNote('');
    try { await model.refreshVehicles(); setNote('授权已刷新。'); }
    catch { setNote('无法刷新授权，请稍后重试。'); }
  }
  return <><AppBar title="车辆授权" back={back} sub={model.vehicle ? model.name : undefined} /><div className="page no-nav">
    {model.expired ? <><Hint kind="warn">会话已失效。重新登录后可查看授权。</Hint><Link className="btn accent" to="/login">重新登录</Link></> :
    !model.vehicle ? <><Hint>{model.vehiclesLoading ? '正在读取车辆授权…' : '请选择车辆后查看授权。'}</Hint><Link className="btn secondary" to="/vehicles">选择车辆</Link></> : <>
    <h2 className="page-title">共享功能</h2>
    {model.vehiclesError && <Hint kind="warn">暂时无法刷新，正在显示上次获取的授权。</Hint>}
    <ul className="shared-grants">{grantsList.map(([key, icon, name, description]) => <li key={key}>
      <Icon name={icon as IconName} size={19} /><div><b>{name}</b><p>{description}</p></div>
      <span className={'pill ' + (key === 'basic' || model.canSee(key) ? 'green' : '')}>{key === 'basic' ? '必选' : model.canSee(key) ? '已授权' : '未授权'}</span>
    </li>)}</ul>
    {model.vehicle.shared && <p className="shared-grants-note">请联系主账号在官方 App 中调整共享权限。</p>}
    </>}
    {model.mode === 'cloud' && !model.expired && <>
      <button className="btn secondary sm" onClick={() => void refresh()} disabled={model.vehiclesLoading}>{model.vehiclesLoading ? '正在读取授权…' : '刷新授权'}</button>
      {note && <p className="tiny muted" role="status">{note}</p>}
    </>}
  </div></>;
}
