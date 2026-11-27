import type { LoginStage } from '../../data/serviceFailure';
import { CloudSessionExpired, connectLive, exchangeCarToken, LiveVehicleClient, refreshAccountToken } from '../../data/cloud/LiveClient';
import type { LiveVehicles } from '../../data/cloud/LiveClient';
import type { Vehicle } from '../../data/types';
import { secureGet, secureRemove, secureSet } from '../../platform/secure';

const key = 'leapmotor-session';
let generation = 0;
let writes = Promise.resolve();
let renewal: Promise<LiveVehicles | null> | undefined;

export const hasCloudSession = async () => !!await secureGet<LiveVehicles>(key);

function writeSession(change: () => Promise<void>) {
  const result = writes.then(change);
  writes = result.catch(() => {});
  return result;
}

export async function loadCloudSession(force = false, checkIn?: { rejectedToken?: string }) {
  const expected = generation;
  const stored = await secureGet<LiveVehicles>(key);
  if (!stored || generation !== expected) return null;
  const refreshAccount = stored.account.token === checkIn?.rejectedToken;
  const needsAccount = !!checkIn && stored.account.expiresAt <= Date.now() + 60_000;
  if (!force && !refreshAccount && !needsAccount && stored.car.expiresAt > Date.now() + 60_000) return stored;
  if (!renewal) {
    const pending = renew(stored, expected, refreshAccount).finally(() => { if (renewal === pending) renewal = undefined; });
    renewal = pending;
  }
  try { return await renewal; }
  catch (error) {
    if (generation !== expected) return null;
    if (force || refreshAccount || error instanceof CloudSessionExpired) throw error;
    // Keep the vehicle selection available during a transient network failure.
    return stored;
  }
}

async function renew(stored: LiveVehicles, expected: number, refreshAccount: boolean) {
  let account = !refreshAccount && stored.account.expiresAt > Date.now() + 60_000
    ? stored.account : await refreshAccountToken(stored.account, stored.deviceId);
  let car;
  try { car = await exchangeCarToken(account, stored.deviceId); }
  catch (error) {
    if (!(error instanceof CloudSessionExpired) || account !== stored.account) throw error;
    account = await refreshAccountToken(account, stored.deviceId);
    car = await exchangeCarToken(account, stored.deviceId);
  }
  let session = { ...stored, car, account };
  await writeSession(async () => {
    if (generation !== expected) return;
    const latest = await secureGet<LiveVehicles>(key);
    if (generation !== expected) return;
    if (latest?.deviceId === stored.deviceId && latest.account.userId === stored.account.userId) session = { ...session, vehicles: latest.vehicles };
    await secureSet(key, session);
  });
  return generation === expected ? session : null;
}

export function cloudClient(session: LiveVehicles) {
  return new LiveVehicleClient(session.car, session.account, session.deviceId, session.vehicles);
}
export function rememberCloudVehicles(session: LiveVehicles, vehicles: Vehicle[]) {
  const expected = generation;
  return writeSession(async () => {
    const saved = await secureGet<LiveVehicles>(key);
    if (generation === expected && saved?.deviceId === session.deviceId && saved.account.userId === session.account.userId) {
      await secureSet(key, { ...saved, vehicles });
    }
  });
}
export async function authorizeCloud(phone: string, code: string, deviceId: string, onStage?: (stage: LoginStage) => void) {
  const session = await connectLive(phone, code, deviceId, onStage);
  onStage?.('session-store');
  generation++;
  renewal = undefined;
  await writeSession(() => secureSet(key, session));
  return session;
}
export function clearCloud() {
  generation++;
  renewal = undefined;
  return writeSession(() => secureRemove(key));
}
