export type CheckInResult = 'done' | 'manual' | 'unconfirmed' | 'offline' | 'login';
export type PageStep = 'waiting' | 'ready' | 'signed' | 'manual' | 'submitted';

// The account gateway is the authority for the day, including after an ambiguous submission.
export async function performCheckIn(io: {
  signed: () => Promise<boolean>; open: () => Promise<void>; step: (submit: boolean) => Promise<PageStep>;
  close: () => Promise<void>; pause: () => Promise<void>; active: () => boolean;
  beforeSubmit: () => Promise<void>;
}): Promise<CheckInResult> {
  const check = () => { if (!io.active()) throw new Error('cancelled'); };
  check();
  if (await io.signed()) return 'done';
  check();
  try {
    await io.open();
    for (let i = 0; i < 30; i++) {
      check();
      const state = await io.step(false);
      if (state === 'manual') return 'manual';
      if (state === 'signed') return await io.signed() ? 'done' : 'unconfirmed';
      if (state === 'ready') {
        await io.beforeSubmit();
        check();
        const submitted = await io.step(true);
        if (submitted !== 'submitted') return await io.signed() ? 'done' : 'manual';
        for (let j = 0; j < 12; j++) {
          await io.pause();
          check();
          const next = await io.step(false);
          if (next === 'manual') return 'manual';
          if (next === 'signed') break;
        }
        return await io.signed() ? 'done' : 'manual';
      }
      await io.pause();
    }
    return 'manual';
  } finally { await io.close().catch(() => {}); }
}

export function checkInSigned(response: Record<string, unknown>): boolean {
  if (response._status === 401 || response.code === 401 || response.code === '401') throw new Error('login');
  const data = response.data as { signInState?: unknown } | null;
  if (response._status !== 200 || Number(response.code) !== 200 || response.success === false) throw new Error('unavailable');
  if (data?.signInState === 1 || data?.signInState === '1') return true;
  if (data?.signInState === 0 || data?.signInState === '0') return false;
  throw new Error('unavailable');
}
