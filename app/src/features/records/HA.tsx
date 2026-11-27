import { Picker } from '../../ui/Picker';
import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Capacitor } from '@capacitor/core';
import { Browser } from '@capacitor/browser';
import { useModelContext } from '../context';
import { beginAuth, consumeAuth, observeNativeCallback } from '../../data/ha/auth';
import { normalizeAddress } from '../../data/ha/client';
import { fields } from '../../data/ha/schema';
import { AppBar, Hint, Section, Seg, stamp, Switch } from '../../ui/components';
import { NetworkError } from '../../platform/network';
import { usesLocalSessionVault } from '../../platform/secure';
import { Icon } from '../../ui/Icon';

const callbackKey = 'leapmore.auth.callback';
export function HAConnect() {
  const model = useModelContext();
  const navigate = useNavigate();
  const [url, setUrl] = useState(model.ha.config?.url ?? '');
  const [manual, setManual] = useState(false);
  const [token, setToken] = useState('');
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState('');
  const [reauthorizing, setReauthorizing] = useState(false);
  const callback = useRef<(url: URL) => void>(() => {});
  callback.current = value => {
    setBusy(true);
    void consumeAuth(value).then(async result => {
      await model.ha.connect(result.server, result.token, 'oauth');
      await Browser.close().catch(() => {});
      setReauthorizing(false);
      if (!model.mode) model.chooseMode('ha');
      if (model.source !== 'hybrid') model.selectRecordSource('ha');
      navigate('/ha', { replace: true });
    }).catch(error => {
      setNote(error instanceof Error && /^授权/.test(error.message) ? error.message : 'HA 授权未完成，请检查服务器与网络后重试。');
    }).finally(() => setBusy(false));
  };
  useEffect(() => {
    const saved = sessionStorage.getItem(callbackKey);
    if (saved) {
      sessionStorage.removeItem(callbackKey);
      try { callback.current(new URL(saved)); } catch { setNote('授权回调无效，请重试。'); }
    }
    if (!Capacitor.isNativePlatform()) return;
    let remove: (() => unknown) | undefined, cancelled = false;
    void observeNativeCallback(url => callback.current(url)).then(stop => { if (cancelled) stop(); else remove = stop; }).catch(() => {});
    const browser = Browser.addListener('browserFinished', () => setBusy(false));
    return () => { cancelled = true; remove?.(); void browser.then(listener => listener.remove()).catch(() => {}); };
  }, []);
  const config = model.ha.config;
  useEffect(() => { if (config?.url) setUrl(config.url); }, [config?.url]);
  async function submit() {
    setBusy(true);
    setNote('');
    let server: string;
    try { server = normalizeAddress(url); } catch (error) {
      setBusy(false); setNote(error instanceof Error && error.message.includes('局域网') ? error.message : '请输入完整的 HTTP 或 HTTPS 地址。'); return;
    }
    try {
      if (!manual) {
        await beginAuth(server);
        if (Capacitor.isNativePlatform()) { setNote('请在授权窗口登录，完成后返回 LeapMore。'); setBusy(false); }
        return;
      }
      if (!token.trim()) { setNote('请输入长期访问令牌。'); return; }
      await model.ha.connect(server, { access: token.trim() }, 'manual');
      setToken('');
      setReauthorizing(false);
      if (!model.mode) model.chooseMode('ha');
      if (model.source !== 'hybrid') model.selectRecordSource('ha');
      navigate('/ha', { replace: true });
    } catch (error) {
      setNote(error instanceof NetworkError ? error.message : '无法连接 HA，请检查地址与认证信息。');
    } finally { if (manual) setBusy(false); else if (Capacitor.isNativePlatform()) setBusy(false); else window.setTimeout(() => setBusy(false), 1000); }
  }
  const { ha } = model;
  const hasClient = ha.connected && !ha.expired;
  const chooseCar = model.mode === 'ha' && ha.candidates.length > 1;
  const availableFields = ha.fields.filter(field => field.available).length;
  const vehicleStatus = ha.identifying ? '正在识别车辆…' : ha.registryUnavailable ? 'HA 实体注册表不可用' :
    !ha.vin ? chooseCar ? '请选择要同步的车辆。' : '未找到可识别的零跑车辆。' :
      availableFields ? `${availableFields} 项历史字段可识别` : '该车辆的历史采样实体不可用';
  return <><AppBar title="HA 同步设置" back={model.mode ? '/records-source' : '/login'} sub="行程、充电与历史采样" />
    <div className="page no-nav">
      {note && <Hint icon="info">{note}</Hint>}
      {model.ha.error && <Hint kind="warn" icon="alert">{model.ha.error}</Hint>}
      {hasClient && config && !reauthorizing ? <>
        <section className="card ha-connected"><div className="confirm-ic"><Icon name="check" size={24} /></div>
          <h2>{model.ha.error ? '连接中断 · 本机缓存可用' : '已连接'}</h2><p className="tiny muted">只读访问 · {config.auth === 'oauth' ? 'Home Assistant 官方授权' : '手动令牌'}</p>
          <p className="tiny muted">{ha.lastSync ? '记录同步于 ' + stamp(ha.lastSync) : '尚无记录同步时间'}</p>
        </section>
        <Section title="车辆与记录">
          {chooseCar && <label className="mapping-row"><span>HA 车辆</span><Picker aria-label="HA 车辆" value={ha.vin} onValue={v => ha.selectVehicle(v)}>
            <option value="" disabled>选择车辆</option>
            {ha.candidates.map(vehicle => <option key={vehicle.vin} value={vehicle.vin}>{vehicle.name || '零跑车辆'} · ••••{vehicle.vin.slice(-4)}</option>)}
          </Picker></label>}
          <p className="small" role="status">{vehicleStatus}</p>
          {model.canSee('mileage') && model.usesHA && ha.vin && <>
            <p className="small" role="status">{ha.ledgerSyncing || ha.recordSyncing && !ha.lastSync ? '正在同步行程与充电记录…' : `已读取 ${ha.syncedTripCount} 条行程 · ${ha.syncedChargeCount} 条充电记录`}</p>
            {ha.recordSyncing && !ha.ledgerSyncing && !!ha.lastSync && <p className="tiny muted">正在补齐历史记录…</p>}
            {(ha.tripUnavailable || ha.chargeUnavailable) && <p className="tiny muted">{ha.tripUnavailable && ha.chargeUnavailable ? 'LeapToHA 行程和充电记录暂不可用。' : ha.tripUnavailable ? 'LeapToHA 行程记录暂不可用。' : 'LeapToHA 充电记录暂不可用。'}</p>}
            {ha.historyUnavailable && <p className="tiny muted">HA Recorder 历史暂不可用。</p>}
            {ha.archiveUnavailable && <p className="tiny muted">零跑原始档案暂不可用。</p>}
            <Link to="/records" className="btn secondary sm">查看记录</Link>
          </>}
          <details className="inline-details"><summary>历史采样字段</summary>
            {ha.fields.map(({ field, available }) => <div className="mapping-row" key={field}><span>{fields[field]}</span><span className="muted">{available ? '可用' : '不可用'}</span></div>)}
          </details>
        </Section>
        <Section title="同步设置"><div className="ha-range"><span>Recorder 同步范围</span><Seg current={config.days} label="同步范围"
          options={[[7, '7 天'], [30, '30 天'], [90, '90 天']]} choose={days => model.ha.setConfig({ ...config, days })} /></div>
          <div className="filter-row"><span>自动同步</span><Switch label="自动同步" checked={config.auto} action={() => model.ha.setConfig({ ...config, auto: !config.auto })} /></div>
          <button className="btn secondary sm" onClick={() => { setNote(''); setManual(false); setReauthorizing(true); }}>重新登录 HA</button>
        </Section>
        <button className="btn accent" disabled={ha.syncing} onClick={() => { if (model.source !== 'hybrid') model.selectRecordSource('ha'); void ha.refresh(); }}>{ha.syncing ? '同步中…' : '立即同步'}</button>
        <button className="btn ghost" onClick={() => void model.ha.disconnect().catch(() => setNote('断开连接失败，请重试。'))}>断开连接</button>
      </> : <>
        <Section title={reauthorizing ? '重新登录 Home Assistant' : '连接 Home Assistant'}>
        <p className="tiny muted">填写服务器地址。在 Home Assistant 页面登录并授权，返回后会自动识别车辆并同步记录。</p>
        <form className="ha-login-form" onSubmit={e => { e.preventDefault(); void submit(); }}>
          <label htmlFor="ha-server">服务器地址</label>
          <div className="field"><input id="ha-server" aria-label="HA 地址" value={url} onChange={e => setUrl(e.target.value)} type="url" placeholder="http://homeassistant.local:8123" required spellCheck={false} /></div>
          {manual && <label className="field"><input type="password" aria-label="访问令牌" value={token} onChange={e => setToken(e.target.value)} required placeholder="长期访问令牌" autoComplete="off" /></label>}
          <button type="submit" className="btn accent" disabled={busy}>{busy ? '连接中…' : manual ? '连接并测试' : '登录 Home Assistant'}</button>
          <button type="button" className="btn ghost" disabled={busy} onClick={() => setManual(x => !x)}>{manual ? '返回官方授权' : '手动输入长期访问令牌'}</button>
          {reauthorizing && <button type="button" className="btn ghost" disabled={busy} onClick={() => setReauthorizing(false)}>返回同步设置</button>}
        </form>
        </Section>
        <Hint icon="shield">应用只读同步 HA 的行程、充电与历史采样。零跑档案接口需要 HA 管理员授权。</Hint>
        {manual && <Section title="怎么获取令牌"><p className="small">在 HA 网页版「个人资料 → 安全 → 长期访问令牌」创建，然后粘贴到这里。</p></Section>}
        {config && !model.ha.hasToken && <p className="tiny muted">本机配置已保留。{!Capacitor.isNativePlatform() &&
          (usesLocalSessionVault() ? '连接后会话加密保存于当前浏览器。' : '浏览器凭据仅保留于当前页面会话。')}</p>}
      </>}
    </div></>;
}
