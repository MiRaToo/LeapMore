import { useEffect, useRef, useState } from 'react';
import { Capacitor, registerPlugin } from '@capacitor/core';
import { focusManager } from '@tanstack/react-query';
import { updateDataset } from '../../data/localDatabase';
import { useSetting } from '../../data/preferences';
import { cloudDay, dayStart } from '../../data/cloud/records';
import { checkInSigned, performCheckIn, type CheckInResult, type PageStep } from '../../data/cloud/checkIn';
import { requestJson } from '../../data/cloud/liveHttp';
import { loadCloudSession } from '../account/session';
import { CloudSessionExpired } from '../../data/cloud/LiveClient';

const page = registerPlugin<{
  checkInOpen(run: { run: string; account: string }): Promise<void>;
  checkInStep(run: { run: string; submit: boolean }): Promise<{ state: PageStep }>;
  checkInClose(run: { run: string }): Promise<void>;
}>('LeapCheckIn');
type Entry = { day: string; at: number; state: CheckInResult | 'checking'; submitted?: boolean; owner?: string };
const dayMs = 86_400_000;
const labels = { done: '今日已签到', manual: '请前往零跑 App 完成今日签到或验证', unconfirmed: '今日签到结果待确认',
  checking: '正在检查今日签到', offline: '暂时无法查询签到状态，稍后打开 App 时重试', login: '请重新登录零跑账号' };

async function signed(account: string, active: () => boolean) {
  let rejected: string | undefined;
  for (let attempt = 0; attempt < 2; attempt++) {
    const session = await loadCloudSession(false, { rejectedToken: rejected });
    if (!session || session.account.userId !== account || !active()) throw new Error('login');
    const token = session.account.token;
    const response = await requestJson('GET', 'https://app-front-gateway.leapmotor.cn/app-usergrow/app/user-growth/h5-info',
      { headers: { 'XFX-CDN-CROSS-NODE': token, 'C-VERSIONS': 'H5' } });
    try { return checkInSigned(response); }
    catch (error) {
      if (!(error instanceof Error && error.message === 'login') || attempt) throw error;
      rejected = token;
    }
  }
  throw new Error('login');
}

export function useAutoCheckIn(scope: string, account: string, eligible: boolean) {
  const [preferences, setPreferences] = useSetting<Record<string, boolean>>('experiments.autoCheckIn', {});
  const enabled = !!scope && preferences[scope] === true;
  const [display, setDisplay] = useState<{ scope: string; entry: Entry }>();
  const cancel = useRef<() => void>();
  useEffect(() => {
    if (!enabled || !eligible || !scope) return;
    let live = true, busy = false, wakeAgain = false;
    let currentRun = '';
    const key = 'daily-checkin:' + scope;
    const paused = () => !live || document.hidden || !focusManager.isFocused();
    let midnight: ReturnType<typeof setTimeout>, leaseTimer: ReturnType<typeof setTimeout>;
    async function run() {
      if (paused()) return;
      if (busy) { wakeAgain = true; return; }
      busy = true;
      const now = Date.now(), day = cloudDay(now);
      const owner = now.toString(36) + '-' + Math.random().toString(36).slice(2);
      currentRun = owner;
      const active = () => !paused() && cloudDay(Date.now()) === day;
      const show = (entry: Entry) => { if (live) setDisplay({ scope, entry }); };
      let claimed = false, submitted = false;
      const finish = async (state: CheckInResult, at = Date.now()) => {
        const saved = await updateDataset<Entry>(key, old => old?.owner === owner
          ? { day, at, state, submitted } : old!);
        if (saved) show(saved);
      };
      try {
        const entry = await updateDataset<Entry>(key, previous => {
          if (previous?.day === day && (previous.state === 'done' ||
              now - previous.at < (previous.state === 'checking' ? 90_000 : 15 * 60_000))) return previous;
          return { day, at: now, state: 'checking', owner, submitted: previous?.day === day && (previous.submitted || previous.state === 'manual') };
        });
        claimed = entry.owner === owner;
        submitted = !!entry.submitted;
        show(entry);
        if (!claimed) {
          if (entry.state === 'checking' && live) {
            clearTimeout(leaseTimer);
            leaseTimer = setTimeout(wake, Math.max(100, entry.at + 90_100 - Date.now()));
          }
          return;
        }
        if (!active()) throw new Error('cancelled');
        let result: CheckInResult;
        if (scope === 'demo') result = 'done';
        else if (submitted) result = await signed(account, active) ? 'done' : 'manual';
        else result = await performCheckIn({
          signed: () => signed(account, active), active,
          open: () => page.checkInOpen({ run: owner, account }),
          step: async submit => (await page.checkInStep({ run: owner, submit })).state,
          close: () => page.checkInClose({ run: owner }), pause: () => new Promise(resolve => setTimeout(resolve, 650)),
          beforeSubmit: async () => {
            const saved = await updateDataset<Entry>(key, old => old?.owner === owner ? { ...old, submitted: true } : old!);
            if (saved?.owner !== owner) throw new Error('cancelled');
            submitted = true;
          },
        });
        await finish(result);
      } catch (error) {
        const state = submitted ? 'unconfirmed' : error instanceof CloudSessionExpired || (error instanceof Error && error.message === 'login') ? 'login' : 'offline';
        if (claimed) await finish(state, !active() && !submitted ? 0 : Date.now()).catch(() => {});
        else show({ day, at: now, state });
      } finally {
        busy = false; currentRun = '';
        if (wakeAgain) { wakeAgain = false; void run(); }
      }
    }
    const wake = () => {
      clearTimeout(midnight);
      if (paused()) return;
      void run();
      midnight = setTimeout(wake, dayStart(Date.now()) + dayMs + 1000 - Date.now());
    };
    const stop = () => {
      live = false;
      clearTimeout(leaseTimer);
      if (account && currentRun) void page.checkInClose({ run: currentRun }).catch(() => {});
    };
    cancel.current = stop;
    wake();
    const unsub = focusManager.subscribe(wake);
    window.addEventListener('online', wake);
    document.addEventListener('visibilitychange', wake);
    return () => { stop(); clearTimeout(midnight); unsub(); window.removeEventListener('online', wake); document.removeEventListener('visibilitychange', wake); };
  }, [scope, account, enabled, eligible]);
  const entry = display?.scope === scope && display.entry.day === cloudDay(Date.now()) ? display.entry : undefined;
  return { enabled, available: !!scope && (scope === 'demo' || Capacitor.isNativePlatform()),
    status: enabled && eligible && entry ? labels[entry.state] : '',
    toggle: () => {
      if (!scope) return;
      if (enabled) cancel.current?.();
      setPreferences(old => ({ ...old, [scope]: !enabled }));
    } };
}
