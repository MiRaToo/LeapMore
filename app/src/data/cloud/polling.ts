import { ServiceFailure } from '../serviceFailure.ts';
import type { CarState } from '../types.ts';

const fast = 6_000;
const parked = 60_000;
export const rateLimitedDelay = 120_000;
const cooldown = 15 * 60_000;
const launchWindow = 10 * 60_000;
const shortStopWindow = 5 * 60_000;

export class CloudRateLimited extends ServiceFailure {
  constructor(status?: number, code?: number) { super('rate', status, code); }
}

export const vehicleRateLimited = (response: Record<string, unknown>) =>
  Number(response._status) === 429 || [429, 1023].includes(Number(response.code ?? response.result)) ||
  /风控|频繁/.test(String(response.message ?? ''));

type VehicleSignal = Pick<CarState, 'reportedAt' | 'recordingFallbackAt' | 'isDriving' | 'parked' | 'speedKmh' | 'locked' | 'ready' | 'gear' | 'charging'>;

export const recordingTime = (state?: Pick<CarState, 'reportedAt' | 'recordingFallbackAt'>) =>
  state?.reportedAt ?? state?.recordingFallbackAt;

export class VehiclePolling {
  private reportedAt = 0;
  private driving = false;
  private charging = false;
  private launchHint = false;
  private launchUntil = 0;
  private shortStopUntil = 0;
  private limitedUntil = 0;
  private nextProbeAt = 0;

  observe(state: VehicleSignal, now = Date.now()) {
    const at = recordingTime(state);
    if (!at || at <= this.reportedAt || at > now + 60_000 || now - at > 90_000) return;
    this.reportedAt = at;
    const driving = state.isDriving === true || (state.speedKmh ?? 0) > 0;
    const charging = state.charging === 'charging';
    const launchHint = !driving && (state.locked === false || state.ready === true ||
      state.gear != null && state.gear !== 0 && state.gear !== 2);
    if (launchHint && !this.launchHint) this.launchUntil = now + launchWindow;
    if (this.driving && state.parked) this.shortStopUntil = now + shortStopWindow;
    this.driving = driving;
    this.charging = charging;
    this.launchHint = launchHint;
  }

  rateLimit(now = Date.now()) {
    this.limitedUntil = now + cooldown;
    this.nextProbeAt = now + rateLimitedDelay;
  }

  limited(now = Date.now()) { return now < this.limitedUntil; }

  beforeRequest(now = Date.now()) {
    if (!this.limited(now)) return;
    if (now < this.nextProbeAt) throw new CloudRateLimited();
    this.nextProbeAt = now + rateLimitedDelay;
  }

  delay(now = Date.now()) {
    if (this.limited(now)) return rateLimitedDelay;
    const driving = this.driving && now - this.reportedAt <= 90_000;
    const launching = this.launchHint && now < this.launchUntil;
    const shortStop = !this.charging && now < this.shortStopUntil;
    return driving || launching || shortStop ? fast : parked;
  }
}
