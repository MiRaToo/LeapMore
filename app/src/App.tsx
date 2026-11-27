import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import { App as NativeApp } from '@capacitor/app';
import { Capacitor } from '@capacitor/core';
import { focusManager } from '@tanstack/react-query';
import { Navigate, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import { Login, Subaccount, VehicleAccess, VehicleList } from './features/account/pages';
import { ChargingPage, ClimatePage, DrivingLock } from './features/vehicle/pages';
import { LocationPage } from './features/vehicle/Location';
import { VehicleSurfaces } from './features/appearance/VehicleSurfaces';
import { VehicleVisualProvider } from './features/appearance/VehicleModel';
import { ChargeDetail, RecordsPage, RecordsSource, TripDetail } from './features/records/pages';
import { EnergyPage } from './features/records/Energy';
import { HAConnect } from './features/records/HA';
import { AppUpdateProvider } from './features/settings/AppUpdates';
import { AmapSettings, AppAppearance, BackgroundGuide, Experiments, Mine, OperationPin, States } from './features/settings/pages';
import { PublishWidget, WidgetAction, WidgetControl, WidgetPreview } from './features/vehicle/Widgets';
import { CommandProvider } from './features/vehicle/commands';
import { PublishQuickControls, QuickAction, QuickControlSettings } from './features/vehicle/QuickControls';
import { VehicleControl } from './features/vehicle/VehicleControl';
import { ControlsProvider } from './features/vehicle/controls';
import { useModelContext } from './features/context';
import { SlidingSelector } from './ui/SlidingSelector';
import { usePageScroll } from './ui/usePageScroll';
import { Icon } from './ui/Icon';
import { Sheet, SheetButtons } from './ui/components';
import { widgetBridge } from './platform/widgets';
import type { WidgetControlRequest } from './platform/widgets';

const tabs = [
  ['/home', '车辆', 'car'], ['/records', '记录', 'route'], ['/energy', '统计', 'chart'], ['/mine', '我的', 'user'],
] as const;
const mineRoutes = ['/mine', '/mine/appearance', '/mine/experiments'];
const watchSize = (callback: () => void) => {
  const list = matchMedia('(max-width: 340px)');
  list.addEventListener('change', callback);
  return () => list.removeEventListener('change', callback);
};
const compactSize = () => matchMedia('(max-width: 340px)').matches;

function NativeLinks() {
  const navigate = useNavigate();
  const latestNavigate = useRef(navigate);
  useLayoutEffect(() => { latestNavigate.current = navigate; }, [navigate]);
  useEffect(() => {
    if (!Capacitor.isNativePlatform() || Capacitor.getPlatform() === 'openharmony') return;
    const listener = NativeApp.addListener('appStateChange', ({ isActive }) => focusManager.setFocused(isActive));
    return () => { focusManager.setFocused(undefined); void listener.then(x => x.remove()).catch(() => {}); };
  }, []);
  useEffect(() => {
    if (!Capacitor.isNativePlatform()) return;
    let receivedWidgetLink = false;
    let lastUrl = '', lastOpen = 0;
    const open = (url: string) => {
      const prefix = 'com.leapmore.app://widget/';
      if (!url.startsWith(prefix)) return;
      const now = Date.now();
      if (lastUrl === url && now - lastOpen < 400) return;
      lastUrl = url;
      lastOpen = now;
      // Older Android WebViews expose custom-scheme URLs as opaque paths.
      let intent: URL;
      try { intent = new URL('https://widget/' + url.slice(prefix.length)); } catch { return; }
      if (intent.pathname === '/quick' || intent.pathname === '/configure') {
        receivedWidgetLink = true;
        const path = intent.pathname === '/quick' ? '/quick-action' : '/quick-controls';
        latestNavigate.current(path + intent.search);
        return;
      }
      if (intent.pathname !== '/action') return;
      receivedWidgetLink = true;
      const action = intent.searchParams.get('action');
      if (action && ['lock', 'climate', 'trunk', 'find'].includes(action)) latestNavigate.current('/widget-action?action=' + action);
      else latestNavigate.current('/home');
    };
    let stopPolling = () => {};
    if (['openharmony', 'ios'].includes(Capacitor.getPlatform())) {
      let running = false;
      const take = () => {
        if (document.hidden || running) return;
        running = true;
        void widgetBridge.take().then(({ action, target }) => {
          if (action && target) open('com.leapmore.app://widget/quick?' + new URLSearchParams({ action, target }));
          else if (action) open('com.leapmore.app://widget/action?action=' + encodeURIComponent(action));
        }).catch(() => {}).finally(() => { running = false; });
      };
      const timer = setInterval(take, 1250);
      document.addEventListener('visibilitychange', take);
      stopPolling = () => { clearInterval(timer); document.removeEventListener('visibilitychange', take); };
    }
    if (Capacitor.getPlatform() === 'openharmony') return stopPolling;
    const listener = NativeApp.addListener('appUrlOpen', e => open(e.url));
    // A cold start can arrive before this listener, including when another plugin listener registered first.
    let active = true;
    void listener.then(() => NativeApp.getLaunchUrl()).then(event => {
      if (active && !receivedWidgetLink && event?.url) open(event.url);
    }).catch(() => {});
    return () => { active = false; stopPolling(); void listener.then(x => x.remove()).catch(() => {}); };
  }, []);
  return null;
}

function SessionExpiredPrompt({ account }: { account: 'cloud' | 'ha' }) {
  const navigate = useNavigate();
  const [dismissed, setDismissed] = useState(false);
  if (dismissed) return null;
  const ha = account === 'ha';
  return <Sheet title={ha ? 'Home Assistant 登录已失效' : '零跑账号登录已失效'} close={() => setDismissed(true)}>
    <p className="confirm-desc">{ha ? '重新授权后可以继续同步行程和充电记录。' : '请重新登录零跑账号，继续查看车况和使用车辆控制。'}</p>
    <SheetButtons cancelLabel="稍后" cancel={() => setDismissed(true)} label="重新登录" action={() => {
      setDismissed(true);
      navigate(ha ? '/ha' : '/login', { replace: true });
    }} />
  </Sheet>;
}

function Screen() {
  const m = useModelContext();
  const location = useLocation();
  const navigate = useNavigate();
  const path = location.pathname;
  const body = useRef<HTMLDivElement>(null);
  const scrollingPage = path === '/records' ? path + location.search : path;
  const atHome = path === '/home';
  const atEnergy = path === '/energy';
  const navigationHidden = usePageScroll(body, scrollingPage, { hideNavigation: path === '/records', rebound: !atHome });
  const compact = useSyncExternalStore(watchSize, compactSize);
  const tab = tabs.findIndex(t => t[0] === path);
  const preview = import.meta.env.DEV && new URLSearchParams(location.search).has('preview') && path === '/widgets';
  const authRoutes = ['/welcome', '/login', '/subaccount', '/ha'];
  const publicRoutes = [...authRoutes, '/vehicle-access', '/states'];
  const main = m.booted && !m.expired && m.vehicle && tab >= 0;
  const atAppearance = path === '/appearance';
  const diagnosticViewer = path === '/states' && new URLSearchParams(location.search).get('check') === '3d';
  const homeKey = m.booted && !m.expired && m.mode && m.vehicle ? JSON.stringify([m.mode, m.cloudKey, m.vehicle.id]) : '';
  const expiredAccount = m.expired ? 'cloud' :
    m.ha.connected && m.ha.expired && (m.mode === 'ha' || m.mode === 'cloud' && m.usesHA) ? 'ha' : null;
  const energyKey = homeKey && (m.mode === 'ha' ? JSON.stringify([homeKey, m.ha.config?.url, m.ha.vin]) : homeKey);
  const [openedEnergy, setOpenedEnergy] = useState('');
  useEffect(() => { if (atEnergy || !energyKey) setOpenedEnergy(energyKey); }, [atEnergy, energyKey]);
  const energyScroll = useRef({ key: '', top: 0 });
  const scrollKey = atEnergy ? energyKey : '';
  const focus = useRef(path);
  useLayoutEffect(() => {
    body.current?.scrollTo({ top: scrollKey && energyScroll.current.key === scrollKey ? energyScroll.current.top : 0 });
    if (focus.current !== path) body.current?.focus({ preventScroll: true });
    focus.current = path;
  }, [path, scrollingPage, scrollKey]);
  const [openedVehicle, setOpenedVehicle] = useState('');
  const vehicleView = atHome ? 'home' : atAppearance ? 'appearance' : null;
  useEffect(() => {
    if (diagnosticViewer) setOpenedVehicle('');
    else if (vehicleView || !homeKey) setOpenedVehicle(homeKey);
  }, [vehicleView, homeKey, diagnosticViewer]);

  return <div className={'screen app-screen' + (compact ? ' compact' : '') + (path === '/home' ? ' home-screen bg-sky' : '') + (main ? ' with-nav' : '')}>
    <div className="view app-view" ref={body} tabIndex={-1} onScroll={atEnergy ? event => {
      energyScroll.current = { key: energyKey, top: event.currentTarget.scrollTop };
    } : undefined}>
      <div className={'app-scroll-content' + (atAppearance ? ' appearance-scroll-content' : '')}>
      {homeKey && !diagnosticViewer && (vehicleView || openedVehicle === homeKey) && <VehicleSurfaces key={homeKey} view={vehicleView} />}
      {!m.booted && !authRoutes.includes(path) ? <Routes>
        <Route path="/trips/:id" element={<TripDetail restoringSession />} />
        <Route path="/charges/:id" element={<ChargeDetail restoringSession />} />
        <Route path="*" element={<p className="loading">正在读取会话…</p>} />
      </Routes> :
      !m.mode && !publicRoutes.includes(path) && !preview ? <Navigate to="/welcome" replace /> :
      m.expired && !['/login', '/vehicle-access', '/vehicles', '/states', ...mineRoutes].includes(path) ? <Navigate to="/login" replace /> :
      m.mode && !m.vehicle && ![...publicRoutes, '/vehicles', '/states', '/quick-action', '/quick-controls', ...mineRoutes].includes(path) ? <Navigate to="/vehicles" replace /> :
      <Routes>
        <Route path="/" element={<Navigate to={m.vehicle ? '/home' : '/vehicles'} replace />} />
        <Route path="/welcome" element={<Login />} />
        <Route path="/login" element={<Login />} />
        <Route path="/subaccount" element={<Subaccount />} />
        <Route path="/vehicles" element={<VehicleList />} />
        <Route path="/vehicle-access" element={<VehicleAccess />} />
        <Route path="/home" element={null} />
        <Route path="/control" element={<VehicleControl />} />
        <Route path="/control/:feature" element={<Navigate to="/control" replace />} />
        <Route path="/climate" element={<ClimatePage key={m.vehicleId} />} />
        <Route path="/charging" element={<ChargingPage key={m.vehicleId} />} />
        <Route path="/location" element={<LocationPage key={m.vehicleId} />} />
        <Route path="/appearance" element={null} />
        <Route path="/driving-lock" element={<DrivingLock />} />
        <Route path="/records" element={<RecordsPage />} />
        <Route path="/trips/:id" element={<TripDetail />} />
        <Route path="/charges/:id" element={<ChargeDetail />} />
        <Route path="/records-source" element={<RecordsSource />} />
        <Route path="/energy" element={null} />
        <Route path="/ha" element={<HAConnect />} />
        <Route path="/ha-mapping" element={<Navigate to="/ha" replace />} />
        <Route path="/mine" element={<Mine />} />
        <Route path="/mine/experiments" element={<Experiments />} />
        <Route path="/mine/appearance" element={<AppAppearance />} />
        <Route path="/vehicle-manage" element={<VehicleList manage />} />
        <Route path="/operation-pin" element={<OperationPin />} />
        <Route path="/background-guide" element={<BackgroundGuide />} />
        <Route path="/amap" element={<AmapSettings />} />
        <Route path="/states" element={<States />} />
        <Route path="/widgets" element={<WidgetPreview />} />
        <Route path="/quick-controls" element={<QuickControlSettings />} />
        <Route path="/quick-action" element={<QuickAction key={location.key} />} />
        <Route path="/widget-action" element={<WidgetAction />} />
        <Route path="*" element={<Navigate to={m.vehicle ? '/home' : '/vehicles'} replace />} />
      </Routes>}
      {energyKey && (atEnergy || openedEnergy === energyKey) && <EnergyPage key={energyKey} active={atEnergy} />}
      </div>
    </div>
    {main && <SlidingSelector nav concealed={navigationHidden} label="主导航" selected={tab} change={index => { if (index !== tab) navigate(tabs[index][0]); }}
      optionLabels={tabs.map(([, label]) => label)} options={tabs.map(([, , icon]) => <Icon name={icon} size={23} />)} />}
    {m.toast && <div className="toast app-toast" role="status">{m.toast}</div>}
    {m.booted && expiredAccount && <SessionExpiredPrompt key={expiredAccount === 'ha' ? 'ha:' + m.ha.config?.url : 'cloud:' + m.profileScope} account={expiredAccount} />}
  </div>;
}
export default function App({ widgetControl }: { widgetControl: WidgetControlRequest | null }) {
  if (widgetControl) return <CommandProvider onClose={widgetBridge.closeControl}><ControlsProvider>
    <WidgetControl request={widgetControl} />
  </ControlsProvider></CommandProvider>;
  return <CommandProvider><ControlsProvider><VehicleVisualProvider><NativeLinks /><PublishWidget /><PublishQuickControls /><AppUpdateProvider><Screen /></AppUpdateProvider></VehicleVisualProvider></ControlsProvider></CommandProvider>;
}
