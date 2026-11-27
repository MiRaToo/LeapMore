import { noteRecording, recordingScope } from './recordingDiagnostics';
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { focusManager } from '@tanstack/react-query';
import { hasBackgroundRecorder, recorder } from '../platform/recorder';

export function useBackgroundVehicleRecorder(scope: string, selection: { scope: string } | null, chosePhoneRecording: boolean,
  delay: number, poll: () => Promise<boolean>) {
  const [activeScope, setActiveScope] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [lastPoll, setLastPoll] = useState<{ scope: string; at: number }>();
  const supported = hasBackgroundRecorder();
  const requested = useRef('');
  const current = useRef({ scope, poll, delay });
  const handledSelection = useRef<typeof selection>(null);
  const revision = useRef(0);
  useLayoutEffect(() => { current.current = { scope, poll, delay }; }, [scope, poll, delay]);

  useEffect(() => {
    if (!supported) return;
    const polling = recorder.addListener('poll', tick => {
      const session = requested.current;
      if (!session || session !== current.current.scope || (tick?.scope && tick.scope !== recordingScope(session))) return;
      const background = !focusManager.isFocused() || document.hidden;
      noteRecording(session, [background ? 'backgroundPoll' : 'foregroundSkip']);
      if (background) {
        void current.current.poll().then(ok => {
          if (ok && requested.current === session) setLastPoll({ scope: session, at: Date.now() });
        }).catch(() => {});
      }
    });
    const status = recorder.addListener('status', result => {
      const session = current.current.scope;
      if (!session || (result.scope && result.scope !== recordingScope(session))) return;
      if (result.running) {
        if (requested.current !== session) return;
        setActiveScope(session);
        setNotice('后台车况轮询已启动。');
      } else {
        requested.current = '';
        setActiveScope('');
        setNotice(result.reason === 'timeout' ? '已达到系统后台运行时限。可重新开启后台记录。' :
          result.reason === 'failed' ? '系统未能开启后台车况轮询。' : '后台车况轮询已停止。');
      }
      setBusy(false);
    });
    return () => {
      void polling.then(listener => listener.remove()).catch(() => {});
      void status.then(listener => listener.remove()).catch(() => {});
    };
  }, [supported]);

  const active = !!scope && activeScope === scope;
  useEffect(() => {
    if (active) void recorder.setDelay({ delay }).catch(() => {});
  }, [active, delay]);

  const setActive = useCallback(async (value: boolean) => {
    const { scope, delay } = current.current;
    if (!supported || !scope || (value && requested.current === scope)) return;
    const request = ++revision.current;
    setBusy(true);
    setNotice('');
    try {
      if (value) {
        setLastPoll(undefined);
        requested.current = scope;
        await recorder.start({ delay, scope: recordingScope(scope) });
      } else {
        requested.current = '';
        await recorder.stop();
        if (revision.current === request) setActiveScope('');
      }
    } catch {
      if (revision.current === request) {
        requested.current = '';
        setActiveScope('');
        setNotice('无法切换后台车况轮询，请让应用在前台后重试。');
      }
    } finally { if (revision.current === request) setBusy(false); }
  }, [supported]);

  useEffect(() => {
    if (!supported) return;
    const request = ++revision.current;
    let live = true;
    const previous = requested.current;
    const switching = !!previous && previous !== scope;
    if (switching) {
      requested.current = '';
      setActiveScope('');
    }
    setBusy(false);
    setNotice('');
    async function applySource() {
      if (switching) await recorder.stop({ reason: 'scope-change' }).catch(() => {});
      if (!scope || !live || request !== revision.current || current.current.scope !== scope) return;
      const state = await recorder.getDiagnostics({ scope: recordingScope(scope) }).catch(() => undefined);
      if (!live || request !== revision.current || current.current.scope !== scope) return;
      const selected = selection?.scope === scope && selection !== handledSelection.current;
      handledSelection.current = selection;
      if (state?.running) {
        requested.current = scope;
        setActiveScope(scope);
        return;
      }
      // An explicit source selection resumes recording after a manual or notification stop.
      const last = state?.sessions?.at(-1);
      // Older releases persisted "hybrid" even when the source picker had never been used.
      if (selected || ((chosePhoneRecording || last) && last?.reason !== 'user' && last?.reason !== 'notification')) await setActive(true);
    }
    void applySource();
    return () => { live = false; };
  }, [scope, selection, chosePhoneRecording, supported, setActive]);

  return { active, busy, notice, supported, setActive, lastPollAt: lastPoll?.scope === scope ? lastPoll.at : undefined };
}
