import { Picker } from '../../ui/Picker';
import { supportsManualTrips } from '../../platform/iosTrip';
import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AboutSheet } from './AppUpdates';
import { RewardSheet } from './RewardSheet';
import { App } from '@capacitor/app';
import { Capacitor } from '@capacitor/core';
import { Directory, Filesystem } from '@capacitor/filesystem';
import { useModelContext } from '../context';
import { disclaimer } from '../account/pages';
import { AmapKeySheet, useAmapKey } from '../vehicle/AmapKey';
import { biometricsAvailable, secureGet, secureRemove, secureSet } from '../../platform/secure';
import { biometricAvailabilityKey, forgetOperationPin, operationAuth, operationAuthKey, setOperationAuth } from '../../platform/operationAuth';
import { nativeSettings } from '../../platform/settings';
import type { AndroidBackgroundCheck, AppIcon } from '../../platform/settings';
import type { OperationMode } from '../../platform/operationAuth';
import { themeAccents, themeModes, useSetting } from '../../data/preferences';
import type { ThemeAccent, ThemeMode } from '../../data/preferences';
import { AppBar, Hint, Row, Section, Seg, Sheet, SheetButtons, Switch, asset, stamp } from '../../ui/components';
import { Icon } from '../../ui/Icon';
import { Diagnostics } from './Diagnostics';
import { AccountProfile } from './AccountProfile';

const appIcons = [
  ['simple', '白底简洁版', 'leaplink-icon-simple.png'], ['original', '原版', 'leaplink-icon.png'],
] as const;

function AppIconSettings() {
  const qc = useQueryClient();
  const queryKey = ['app-icon'];
  const native = Capacitor.isNativePlatform() && Capacitor.isPluginAvailable('LeapSettings');
  const current = useQuery({ queryKey, queryFn: () => nativeSettings.getAppIcon(), enabled: native, retry: false });
  const change = useMutation({ mutationFn: (icon: AppIcon) => nativeSettings.setAppIcon({ icon }),
    onSuccess: (_, icon) => qc.setQueryData(queryKey, { icon, canChange: true }) });
  const selected = current.data?.icon ?? 'simple';
  return <Section title="应用图标">
    <div className="app-icon-options" role="group" aria-label="应用图标" aria-busy={change.isPending || current.isFetching}>
      {appIcons.map(([icon, label, image]) => <button key={icon} type="button" className="app-icon-option" aria-pressed={selected === icon}
        disabled={!current.data?.canChange || change.isPending} onClick={() => { if (selected !== icon) change.mutate(icon); }}>
        <img src={asset(image)} alt="" width="48" height="48" /><span>{label}</span>
        {selected === icon && <Icon name="check" size={16} />}
      </button>)}
    </div>
    {current.isError || change.isError ? <p className="tiny muted" role="status">暂时无法更换应用图标，请重试。</p> :
      !native ? <p className="tiny muted">在手机 App 中切换桌面图标。</p> :
      current.data?.canChange === false && <p className="tiny muted">当前系统不支持更换桌面图标。</p>}
  </Section>;
}

export function Experiments() {
  const { autoCheckIn, mode, expired } = useModelContext();
  const note = mode === 'ha' ? '登录零跑账号后可使用自动签到。' : expired ? '请重新登录零跑账号。'
    : !autoCheckIn.available ? '请在手机 App 中使用自动签到。' : mode === 'demo' ? '演示账号模拟每日签到。'
    : '每天打开或返回 App 时，通过零跑官方页面为当前账号签到。';
  return <><AppBar title="实验功能" back="/mine" /><div className="page no-nav">
    <div className="list-card"><Row list icon="calendar" title="自动签到" right={<Switch label="自动签到" checked={autoCheckIn.enabled}
      disabled={!autoCheckIn.enabled && (!autoCheckIn.available || expired)} action={autoCheckIn.toggle} />} /></div>
    <p className="tiny muted" role="status">{autoCheckIn.status ? (mode === 'demo' ? '演示 · ' : '') + autoCheckIn.status : note}</p>
  </div></>;
}

export function AppAppearance() {
  const { theme, setTheme, themeAccent, setThemeAccent, colorScheme } = useModelContext();
  return <><AppBar title="外观" back="/mine" /><div className="page no-nav">
    <Section title="主题" className="app-theme-modes">
      <Seg current={theme} options={Object.entries(themeModes) as [ThemeMode, string][]} choose={setTheme} label="主题" />
    </Section>
    <Section title="主题色">
      <div className="swatches theme-swatches" role="group" aria-label="主题色">
        {(Object.entries(themeAccents) as [ThemeAccent, typeof themeAccents[ThemeAccent]][]).map(([key, color]) =>
          <button key={key} type="button" className="swatch" aria-pressed={themeAccent === key} onClick={() => setThemeAccent(key)}>
            <i style={{ backgroundColor: color[colorScheme] }} /><span><Icon name="check" size={12} /></span><small>{color.name}</small>
          </button>)}
      </div>
    </Section>
    <AppIconSettings />
  </div></>;
}

export function Mine() {
  const m = useModelContext();
  const navigate = useNavigate();
  const { key } = useAmapKey();
  const [sheet, setSheet] = useState<'logout' | 'about' | 'reward' | 'privacy' | 'cache' | 'amap' | 'demo' | null>(null);
  const [note, setNote] = useState('');
  const qc = useQueryClient();
  const close = () => { setSheet(null); setNote(''); };
  async function clearCache() {
    try {
      if (Capacitor.isNativePlatform()) {
        await Filesystem.rmdir({ path: 'cloud3d2', directory: Directory.Data, recursive: true }).catch(() => {});
      }
      qc.removeQueries({ queryKey: ['cloud', '3d'] });
      qc.removeQueries({ queryKey: ['geocode'] });
      setNote('已清理外观和地址查询缓存。');
    } catch { setNote('无法清理缓存。'); }
  }
  return <><AppBar title="我的" back="/home" /><div className="page settings-page">
    <AccountProfile key={m.profileScope} />
    {m.demo && <div className="list-card"><Row list icon="climatePresets" title="演示情景" onClick={() => setSheet('demo')} /></div>}
    <div className="list-card"><Row list icon="car" title="车辆管理" right={m.vehicles.length + ' 辆'} to="/vehicle-manage" />
      <Row list icon="key" title="车辆授权" to="/vehicle-access" /></div>
    <div className="list-card"><Row list icon="sun" title="外观" right={themeModes[m.theme]} to="/mine/appearance" />
      {Capacitor.getPlatform() === 'android' && <Row list icon="gear" title="快捷控制" to="/quick-controls" />}
      <Row list icon="spark" title="实验功能" to="/mine/experiments" />
      <Row list icon="layout" title="桌面卡片预览" to="/widgets?from=mine" />
      <Row list icon="map" title="高德地图 Key" right={key ? '已配置' : '未配置'} onClick={() => setSheet('amap')} />
      <Row list icon="file" title="缓存管理" onClick={() => setSheet('cache')} /></div>
    <div className="list-card"><Row list icon="shield" title="隐私与免责声明" onClick={() => setSheet('privacy')} />
      <Row list icon="file" title="故障诊断与导出" to="/states" />
      <Row list icon="star" title="关于 LeapMore" onClick={() => setSheet('about')} />
      <Row list icon="heart" title="赞赏作者" onClick={() => setSheet('reward')} /></div>
    <div className="list-card"><Row list icon="logout" title="退出登录" onClick={() => setSheet('logout')} /></div>
    <p className="tiny muted settings-footer">LeapMore 是免费提供的非官方项目</p>
    {sheet === 'amap' && <AmapKeySheet close={close} />}
    {sheet === 'demo' && m.demo && <DemoSettings close={close} />}
    {sheet === 'logout' && <Sheet title="退出登录？" close={close}><p className="confirm-desc">退出后需重新登录。本机的记录与设置会保留。</p>
      <SheetButtons cancel={close} label="退出登录" action={() => { void m.logout().then(() => navigate('/login', { replace: true })).catch(() => setNote('退出失败，请重试。')); }} />{note && <p role="status">{note}</p>}</Sheet>}
    {sheet === 'privacy' && <Sheet title="隐私与免责声明" close={close}><p className="confirm-desc">{disclaimer}</p><p className="confirm-desc">系统版本将授权凭据保存在平台安全存储。脱敏 CSV 只包含日期与记录摘要。</p><button className="btn ghost" onClick={close}>关闭</button></Sheet>}
    {sheet === 'cache' && <Sheet title="缓存管理" close={close}><p className="confirm-desc">清理车模下载和地址查询缓存。</p><SheetButtons cancel={close} label="清理缓存" action={() => void clearCache()} />{note && <p role="status">{note}</p>}</Sheet>}
    {sheet === 'about' && <AboutSheet close={close} />}
    {sheet === 'reward' && <RewardSheet close={close} />}
  </div></>;
}

export function AmapSettings() {
  const navigate = useNavigate();
  return <><Mine /><AmapKeySheet close={() => navigate('/mine', { replace: true })} /></>;
}
export function OperationPin() {
  const { mode, operationScope } = useModelContext();
  if (mode === 'cloud' && operationScope) return <CloudOperationPin key={operationScope} scope={operationScope} />;
  if (mode === 'demo') return <DemoOperationPin />;
  return <><AppBar title="操作密码" back="/vehicle-manage" /><div className="page no-nav"><Hint>登录零跑账号并选择车辆后可设置。</Hint></div></>;
}

function CloudOperationPin({ scope }: { scope: string }) {
  const qc = useQueryClient();
  const auth = useQuery({ queryKey: operationAuthKey(scope), queryFn: () => operationAuth(scope), staleTime: Infinity });
  const biometric = useQuery({ queryKey: biometricAvailabilityKey, queryFn: biometricsAvailable, staleTime: 0 });
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState('');
  const options = [
    ['reuse', '直接确认', '首次验证后保存密码，之后每次点「确认发送」即可。'],
    ['verify', '每次验证', biometric.data ? '可用操作密码或系统指纹、面容验证。' : '使用零跑操作密码验证。'],
    ['instant', '发送前不确认', '保存密码后，点控车按钮即发送指令，容易误触。'],
  ] as const;
  async function update(mode?: OperationMode) {
    setBusy(true);
    setNote('');
    try {
      const prefs = mode ? await setOperationAuth(scope, mode) : await forgetOperationPin(scope);
      qc.setQueryData(operationAuthKey(scope), prefs);
      if (!mode) setNote('已移除本机保存的操作密码。');
      else if (mode !== 'verify' && !prefs.saved) setNote('下次验证通过后加密保存操作密码。');
    } catch {
      void qc.invalidateQueries({ queryKey: operationAuthKey(scope) });
      setNote('无法更新本机控车设置，请重试。');
    } finally { setBusy(false); }
  }
  return <><AppBar title="操作密码" back="/vehicle-manage" /><div className="page no-nav">
    <Section title="发送前验证">
      {options.map(([mode, title, detail]) => <button type="button" className={'source-opt' + (auth.data?.mode === mode ? ' on' : '')} key={mode}
        aria-pressed={auth.data?.mode === mode} disabled={busy || auth.isLoading}
        onClick={() => void update(mode)}><span className="radio" /><span className="so-body"><b>{title}</b>
          <small className={mode === 'instant' ? 'operation-warning' : undefined}>{detail}</small></span></button>)}
      {(auth.data?.saved || auth.data?.biometric) && <button className="btn ghost sm" disabled={busy} onClick={() => void update()}>移除本机密码</button>}
      {note && <p role="status" className="tiny muted">{note}</p>}
    </Section>
  </div></>;
}

function DemoOperationPin() {
  const navigate = useNavigate();
  const { vehicleId } = useModelContext();
  const key = 'operation-pin:' + vehicleId;
  const [pin, setPin] = useState('');
  const [again, setAgain] = useState('');
  const [saved, setSaved] = useState(false);
  const [note, setNote] = useState('');
  useEffect(() => { void secureGet(key).then(x => setSaved(!!x)).catch(() => {}); }, [key]);
  async function save() {
    if (!/^\d{4}$/.test(pin) || pin !== again) { setNote('请输入两次一致的 4 位操作密码。'); return; }
    try {
      const salt = crypto.getRandomValues(new Uint8Array(16));
      const data = await crypto.subtle.importKey('raw', new TextEncoder().encode(pin), 'PBKDF2', false, ['deriveBits']);
      const proof = await crypto.subtle.deriveBits({ name: 'PBKDF2', salt, iterations: 180_000, hash: 'SHA-256' }, data, 256);
      await secureSet(key, { salt: Array.from(salt), proof: Array.from(new Uint8Array(proof)) });
      setPin(''); setAgain(''); setSaved(true);
      setNote('操作密码已保存。');
    } catch { setNote('操作密码无法安全保存。'); }
  }
  return <><AppBar title="操作密码" back="/vehicle-manage" /><div className="page no-nav"><Section title={saved ? '已加密保存 · 4 位' : '未设置'}>
    <div className="field"><input type="password" inputMode="numeric" maxLength={4} value={pin} onChange={e => setPin(e.target.value)} placeholder="设置 4 位操作密码" aria-label="设置操作密码" /></div>
    <div className="field"><input type="password" inputMode="numeric" maxLength={4} value={again} onChange={e => setAgain(e.target.value)} placeholder="再次输入密码" aria-label="确认操作密码" /></div>
    <button className="btn accent" onClick={() => void save()}>{saved ? '更新操作密码' : '保存操作密码'}</button>
    <p className="tiny muted">密码校验值仅存本机。模拟指令确认后直接发送。</p><p role="status">{note}</p>
    <button className="btn ghost" onClick={() => navigate('/vehicle-manage')}>完成</button>
  </Section></div></>;
}

const backgroundBrands = {
  xiaomi: { label: '小米 / Redmi / POCO', path: '在设置中搜索「自启动」，并在 LeapMore 的应用电池设置中选择「无限制」。' },
  huawei: { label: '华为 / 荣耀', path: '在设置中搜索「应用启动管理」，打开 LeapMore 的自动启动与后台活动设置。' },
  oppo: { label: 'OPPO / 一加 / realme', path: '在设置中搜索「自启动」或「应用耗电管理」，检查 LeapMore 的后台运行权限。' },
  vivo: { label: 'vivo / iQOO', path: '在设置或 i 管家中搜索「自启动」，并检查 LeapMore 的后台耗电管理。' },
  samsung: { label: '三星', path: '在设置中搜索「后台使用限制」，将 LeapMore 加入「永不自动休眠的应用」。' },
  native: { label: '其他 Android', path: '在 LeapMore 的应用信息中打开电池设置，检查后台使用权限。' },
} as const;
type BackgroundBrand = keyof typeof backgroundBrands;
function detectedBackgroundBrand(check: AndroidBackgroundCheck | undefined): BackgroundBrand {
  const device = `${check?.manufacturer ?? ''} ${check?.brand ?? ''}`.toLowerCase();
  if (/xiaomi|redmi|poco/.test(device)) return 'xiaomi';
  if (/huawei|honor/.test(device)) return 'huawei';
  if (/oppo|oneplus|realme/.test(device)) return 'oppo';
  if (/vivo|iqoo/.test(device)) return 'vivo';
  if (/samsung/.test(device)) return 'samsung';
  return 'native';
}

function CheckPill({ positive, labels }: { positive: boolean | null | undefined; labels: [string, string] }) {
  return <span className={'pill' + (positive == null ? '' : positive ? ' green' : ' warn')}>
    {positive == null ? '无法读取' : labels[positive ? 0 : 1]}
  </span>;
}

export function BackgroundGuide() {
  return Capacitor.getPlatform() === 'ios' ? <IOSBackgroundGuide /> : <BackgroundRecorderGuide />;
}

function IOSBackgroundGuide() {
  const m = useModelContext();
  return <><AppBar title="后台记录设置" back="/records-source" /><div className="page no-nav">
    <Section title="iPhone 记录方式">
      {supportsManualTrips() ? <><p>选择「手机记录」或「手机记录 + HA 同步」会向 iOS 申请后台记录。运行时间由系统决定。中断前的采样会保存在本机，可在数据源、行程或充电页点「继续记录」。</p>
        <p>后台记录运行时，可在锁定屏幕查看进度，或长按灵动岛展开。停车等候下一次行程或充电时，实时活动也可能继续显示。点「结束记录」会同时停止手机后台采样。</p>
        <Row icon="route" title="前往行程记录" to="/records?tab=trips" /></> : <><p>打开 LeapMore 并保持在前台时，手机可以采集车辆上报。锁屏或切换 App 后，iOS 可能挂起采样。</p>
      <p className="small muted">iOS 没有为车况轮询提供永久常驻开关。</p></>}
    </Section>
    <Section title="锁屏期间持续记录">
      <p>在持续运行的 Home Assistant 中配置零跑车辆集成，并启用历史记录。然后在 LeapMore 连接 Home Assistant，在「记录与数据源」选择「HA 同步」或「手机记录 + HA 同步」。</p>
      <Row icon="server" title={m.ha.connected && !m.ha.expired ? '管理 Home Assistant 连接' : '连接 Home Assistant'} to="/ha" />
      <Row icon="route" title="选择记录数据源" to="/records-source" />
    </Section>
  </div></>;
}

function BackgroundRecorderGuide() {
  const m = useModelContext();
  const [brand, setBrand] = useSetting<BackgroundBrand | 'auto'>('backgroundBrandOverride', 'auto');
  const [note, setNote] = useState('');
  const supported = m.background.supported;
  const check = useQuery({ queryKey: ['android-background-check'], enabled: supported,
    queryFn: () => nativeSettings.checkBackground(), retry: false, refetchOnMount: 'always', refetchOnWindowFocus: 'always' });
  const { refetch } = check;
  useEffect(() => { if (supported) void refetch({ cancelRefetch: false }); }, [m.background.active, refetch, supported]);
  const status = check.isError ? undefined : check.data;
  const detected = detectedBackgroundBrand(status);
  const guide = backgroundBrands[brand === 'auto' ? detected : brand] ?? backgroundBrands[detected];
  const running = status?.recording;
  async function open(target: string) {
    setNote('');
    try { await nativeSettings.open({ target }); }
    catch { setNote('请在系统设置中打开 LeapMore 的权限页。'); }
  }
  return <><AppBar title="后台常驻设置" back="/records-source" sub={status ? `${status.brand} · Android ${status.release}` : undefined} /><div className="page no-nav">
    <Hint>手机记录通过零跑云查询车辆车况。轨迹使用车辆上报的位置，需要车辆定位授权。</Hint>
    {supported && <>
      <Section className="background-check" title="后台检查">
        <div className="background-lock-note"><Icon name="lock" size={18} />
          <div><strong>在最近任务中锁住 LeapMore</strong>
            <p>打开手机的最近任务，长按 LeapMore 卡片或点卡片菜单。若有「锁定」或「保持打开」，请选中它，减少一键清理打断后台记录的情况。</p></div>
        </div>
        <Row icon="refresh" title="后台轮询服务" right={<CheckPill positive={running} labels={['运行中', '未运行']} />}
          sub={m.background.lastPollAt ? '最近后台查询成功 ' + stamp(m.background.lastPollAt) : undefined} />
        <Row icon="clock" title="最近本机车况采样" right={stamp(m.cloudRecords.frames.at(-1)?.at)} />
        {m.cloudRecords.issue && <Hint kind="warn">{m.cloudRecords.issue}</Hint>}
        <Row icon="bell" title="记录通知" onClick={() => void open('notifications')}
          right={<CheckPill positive={status?.notifications} labels={['已允许', '已关闭']} />} />
        <Row icon="battery" title="电池优化" onClick={() => void open('battery')}
          right={<CheckPill positive={status?.batteryUnrestricted} labels={['已豁免', '优化中']} />} />
        <Row icon="power" title="后台限制" onClick={() => void open('app')}
          right={<CheckPill positive={status?.backgroundRestricted == null ? undefined : !status.backgroundRestricted} labels={['未限制', '已限制']} />} />
        <Row icon="battery" title="系统省电模式" right={<CheckPill positive={status ? !status.powerSave : undefined} labels={['已关闭', '已开启']} />} />
        <button type="button" className="btn secondary sm" disabled={check.isFetching} onClick={() => void refetch()}>
          {check.isFetching ? '正在检查…' : '重新检查'}
        </button>
        {check.isError && <Hint kind="warn">无法读取系统状态。可打开对应设置手动核对。</Hint>}
      </Section>
      <Section title="应用自启动">
        <Picker className="setting-select" aria-label="手机品牌" value={brand} onValue={v => setBrand(v as BackgroundBrand | 'auto')}>
          <option value="auto">{status ? `自动识别 · ${backgroundBrands[detected].label}` : '自动识别'}</option>
          {Object.entries(backgroundBrands).map(([key, item]) => <option value={key} key={key}>{item.label}</option>)}
        </Picker>
        <p className="small muted">厂商的自启动开关需手动核对。{guide.path}</p>
        <button type="button" className="btn secondary sm" onClick={() => void open('app')}>打开应用设置</button>
      </Section>
      {status && status.sdk >= 35 && <Hint>Android 15 及以上对后台数据同步服务设有时限。到达时限后，可回到 App 重新开启。</Hint>}
    </>}
    {!supported && <Hint>此平台在应用前台时采集车况。需要持续记录时，可使用 HA 同步。</Hint>}
    {m.mode !== 'cloud' ? <Link className="btn accent" to="/login">登录零跑账号</Link> :
      supported && <>
        <button className={'btn ' + (m.background.active ? 'ghost' : 'accent')}
          disabled={m.background.busy || !m.usesPhone || !m.canSee('mileage')}
          onClick={() => { setNote(''); void m.background.setActive(!m.background.active); }}>
          {m.background.active ? '停止后台记录' : '开始后台记录'}
        </button>
        <p role="status" className="tiny muted">{note || m.background.notice}</p>
      </>}
  </div></>;
}

function DemoSettings({ close }: { close: () => void }) {
  const m = useModelContext();
  return <Sheet title="演示情景" close={close} showClose className="demo-settings-sheet">
      <label className="mapping-row"><span>数据状态</span>
      <Picker aria-label="数据状态" value={m.debug.scenario} onValue={v => { const scenario = v as typeof m.debug.scenario; m.setDebug(s => ({ ...s, scenario })); }}>
        <option value="normal">正常</option><option value="stale">过期</option><option value="offline">断网</option><option value="pending">待确认</option></Picker></label>
      <label className="mapping-row"><span>账号</span><Picker aria-label="账号情景" value={m.debug.account} onValue={v => { const account = v as typeof m.debug.account; m.setDebug(s => ({ ...s, account })); }}>
        <option value="normal">正常</option><option value="expired">会话失效</option><option value="empty">无授权车辆</option></Picker></label>
      <label className="mapping-row"><span>能源类型</span><Picker aria-label="能源类型" value={m.debug.powertrain} onValue={v => { const powertrain = v as typeof m.debug.powertrain; m.setDebug(s => ({ ...s, powertrain })); }}>
        <option value="bev">纯电</option><option value="reev">增程</option></Picker></label>
      <label className="mapping-row"><span>充电状态</span><Picker aria-label="充电情景" value={m.debug.charging} onValue={v => { const charging = v as typeof m.debug.charging; m.setDebug(s => ({ ...s, charging })); }}>
        <option value="unplugged">未插枪</option><option value="plugged">已插枪</option><option value="charging">充电中</option><option value="done">充电完成</option></Picker></label>
      <div className="mapping-row"><span>行驶状态</span><div className="demo-driving"><span>{m.debug.driving ? '行驶中' : '已驻车'}</span>
        <Switch label="模拟行驶" checked={m.debug.driving} action={() => m.setDebug(s => ({ ...s, driving: !s.driving }))} /></div></div>
      <fieldset className="debug-grants"><legend>共享权限</legend><label><input type="checkbox" checked disabled />基础授权 · 解锁、闭锁</label>
        {([['control', '车辆控制'], ['location', '车辆定位'], ['mileage', '里程能耗']] as const).map(([key, label]) => <label key={key}>
          <input type="checkbox" checked={m.debug.grants[key]} onChange={e => m.setDebug(state => ({ ...state, grants: { ...state.grants, [key]: e.target.checked } }))} />{label}
        </label>)}</fieldset>
    <button type="button" className="btn secondary" onClick={close}>完成</button>
  </Sheet>;
}

export function States() {
  const m = useModelContext();
  const [platform, setPlatform] = useState(Capacitor.getPlatform());
  useEffect(() => { if (Capacitor.isNativePlatform()) void App.getInfo().then(info => setPlatform(Capacitor.getPlatform() + ' · ' + info.version)).catch(() => {}); }, []);
  return <><AppBar title="故障诊断" back={!m.mode || m.expired ? "/login" : !m.vehicle ? "/vehicles" : "/mine"} sub={platform} /><div className="page no-nav settings-page">
    <Diagnostics key={JSON.stringify([m.profileScope, m.cloudKey])} />
    <div className="card diagnostic-folds">
      <details className="diagnostic-fold" open={m.ha.error || m.expired || m.ha.expired ? true : undefined}>
        <summary>常见问题与处理<Icon name="chevrond" size={16} /></summary>
        <div className="diagnostic-fold-body diagnostic-help">
          <div><strong>车况未更新</strong><p>{m.ha.error || '断网时保留上次车况。可查看采集时间，恢复连接后刷新。'}</p>
            <button className="link" disabled={m.refreshing} onClick={() => void m.refresh(true)}>刷新车况</button></div>
          <div><strong>会话失效</strong><p>自动续期失败时，需要重新授权。</p>
            <Link className="link" to={m.ha.expired || m.mode === 'ha' ? '/ha' : '/login'}>重新登录</Link></div>
          <div><strong>功能或数据缺失</strong><p>共享权限、车辆状态和车型能力会影响可用功能。缺失字段显示「—」。</p>
            <Link className="link" to="/vehicle-access">查看车辆授权</Link></div>
          <div><strong>操作结果待确认</strong><p>车端尚未返回回执，可刷新车况核对结果。</p></div>
        </div>
      </details>
    </div>
  </div></>;
}
