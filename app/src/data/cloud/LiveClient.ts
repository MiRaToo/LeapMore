import type { LoginStage } from '../serviceFailure';
import { ServiceFailure } from '../serviceFailure';
import md5 from 'blueimp-md5';
import { diagnosticFamily, diagnosticYear } from '../modelDiagnostics';
import type { ModelTrace } from '../modelDiagnostics';
import type { Capability, CarState, EnergyDay, Vehicle, VehicleClient } from '../types';
import { numberOf } from '../ha/measurements';
import { displayedRange, namedPowertrain, powertrainRanges } from '../powertrain';
import { energyRankOf } from '../energyRank';
import { periodStart } from '../recordPeriod';
import { maskPhone } from '../phoneMask';
import { socPercent } from '../vehicleEnergy';
import type { Charge } from '../ha/measurements';
import { readDataset, saveDataset } from '../localDatabase';
import { cloudDay, dayStart, energyParts, officialCharge, vehicleTimestamp } from './records';
import { CloudRateLimited, vehicleRateLimited } from './polling';
import { ACCOUNT_BASE, APP_SUBVERSION, APP_VERSION, GLOBAL_HOST, GLOBAL_BASE, CAR_BASE, deriveHkdfKeyHex, hmacSha256Hex, randomDeviceId, rsaEncryptPhone, sha256Hex, sortAndConcat } from './liveCrypto';
import { requestBinary, requestJson, vehicleServiceOrigin } from './liveHttp';
import { chargePlanState, chargeRepeatDays, encodeRemote, encryptOperationPin, needsParkingSentry, OperationPinRejected, RemoteCommandError } from './remote';
import type { ChargePlanPatch, RemoteCommand } from './remote';
import { hasT03Telemetry, normalizeT03, t03Timestamp } from './t03';
import { allowsPreparationContent, applyPreparationEdit, permitsCommand, readPreparationPlans } from './preparation';
import { allowsPreheat, preheatCommandId, preparePreheatEdit, readPreheatEntries } from './preheat';

const REGION = 'CN';
const LANGUAGE = 'zh-CN';

export interface AccountLogin {
  token: string;
  userId: string;
  refreshToken?: string;
  accountNumber?: string;
  maskedPhone?: string;
  expiresAt: number;
}

export interface CarLogin {
  accessToken: string;
  refreshToken?: string;
  hkdfKeyHex: string;
  expiresAt: number;
}

const cloudAuthErrors = new Set([401, 302002004, 302010202, 302010219]);
export class CloudSessionExpired extends ServiceFailure {
  constructor(status?: number, code?: number) { super('auth', status, code); }
}
export class CarPictureOnly extends Error {
  constructor() { super('零跑云本次仅提供 2D 外观。'); }
}
export class RemoteDeliveryUnknown extends Error {}
const remoteTimeout = 6_000;
function requireCloudResponse(response: Record<string, unknown>) {
  const code = Number(response.code ?? response.result ?? response._status);
  const status = Number(response._status) || undefined;
  const business = Number(response.code ?? response.result);
  const safeCode = Number.isSafeInteger(business) && Math.abs(business) <= 999999999 ? business : undefined;
  if (status === 401 || cloudAuthErrors.has(code)) throw new CloudSessionExpired(status, safeCode);
  if (vehicleRateLimited(response)) throw new CloudRateLimited(status, safeCode);
  if (status === 403 || code === 403) throw new ServiceFailure('forbidden', status, safeCode);
  if (status && (status < 200 || status >= 300)) throw new ServiceFailure('service', status, safeCode);
  if (response._raw) throw new ServiceFailure('response', status);
  if (Number.isFinite(code) && code !== 0 && code !== 200) throw new ServiceFailure('service', status, safeCode);
}
function permissionCodes(value: unknown): string[] {
  const codes = Array.isArray(value) ? value : typeof value === 'string' ? value.split(',') : [];
  return codes.flatMap(code => ['number', 'string'].includes(typeof code) && String(code).trim() ? [String(code).trim()] : []);
}

function sharedGrants(raw: Record<string, unknown>) {
  // The current sharing UI uses module codes. Command IDs in rightList are a separate catalog.
  if (typeof raw.moduleRights === 'string' || Array.isArray(raw.moduleRights)) {
    const modules = new Set(permissionCodes(raw.moduleRights));
    return { control: modules.has('200'), location: modules.has('300'), mileage: modules.has('400') };
  }
  const commands = new Set(permissionCodes(raw.rightList));
  const views = new Set(permissionCodes(raw.viewPermissionList ?? raw.carPermissionList ?? raw.permissionList));
  return {
    control: ['120', '130', String(preheatCommandId), '170', '190', '230', '240', '301', '320', '360', '361', '370', '440', '480'].some(code => commands.has(code)),
    location: views.has('310'),
    mileage: views.has('305'),
  };
}

export interface LiveVehicles {
  vehicles: Vehicle[];
  account: AccountLogin;
  car: CarLogin;
  deviceId: string;
}

function accountHeaders(deviceId: string): Record<string, string> {
  return {
    APPPlatform: 'Android',
    APPVersion: APP_VERSION,
    'C-VERSIONS': 'APP',
    'Content-Type': 'application/json;charset=UTF-8',
    APPImei: deviceId,
  };
}

export async function sendSmsCode(phone: string, deviceId = randomDeviceId()): Promise<void> {
  phone = phone.replace(/\D/g, '');
  const url = ACCOUNT_BASE + '/applogin/compliance/sendmessagecode?phoneNo=' + encodeURIComponent(rsaEncryptPhone(phone));
  const res = await requestJson('GET', url, { headers: accountHeaders(deviceId), timeoutMs: 20000 });
  requireCloudResponse(res);
  const code = Number(res.code);
  if (!Number.isFinite(code) || (code !== 0 && code !== 200)) throw new Error('验证码发送失败。');
}

export async function loginWithSms(phone: string, smsCode: string, deviceId = randomDeviceId()): Promise<AccountLogin> {
  phone = phone.replace(/\D/g, '');
  smsCode = smsCode.trim();
  const accountNumber = rsaEncryptPhone(phone);
  const query = new URLSearchParams({
    phoneNoCiphertext: accountNumber,
    smsCode,
    os: 'android',
    pageUrl: '精选',
    deviceID: deviceId,
  });
  const res = await requestJson('POST', ACCOUNT_BASE + '/applogin/check_login_with_phone?' + query.toString(), {
    headers: accountHeaders(deviceId), timeoutMs: 20000,
  });
  requireCloudResponse(res);
  const data = (res.data && typeof res.data === 'object' ? res.data : {}) as Record<string, unknown>;
  const vo = ['appLoginVO', 'appOneLoginVO', 'appOtherLoginVO']
    .map((k) => data[k]).find((x) => x && typeof x === 'object') as Record<string, unknown> | undefined
    ?? (data.token ? data : undefined);
  const token = String(vo?.token || vo?.accessToken || '');
  const userId = String(vo?.accountId || vo?.userId || vo?.id || '');
  if (!token || !userId) throw new ServiceFailure('response', Number(res._status) || undefined);
  const ttl = Number(vo?.tokenExpired || vo?.expiresIn || 21600);
  return {
    token, userId, refreshToken: vo?.refreshToken ? String(vo.refreshToken) : undefined, accountNumber, maskedPhone: maskPhone(phone),
    expiresAt: Date.now() + (Number.isFinite(ttl) && ttl > 0 ? ttl : 21600) * 1000,
  };
}

export async function refreshAccountToken(account: AccountLogin, deviceId: string): Promise<AccountLogin> {
  if (!account.refreshToken || !account.accountNumber) throw new CloudSessionExpired();
  const timespan = String(Date.now());
  const nonce = String(Math.floor(1000000 + Math.random() * 8999999));
  const values: Record<string, string> = {
    accountId: account.userId,
    accountNumber: account.accountNumber,
    deviceID: deviceId,
    nonce,
    refreshtoken: account.refreshToken,
    timespan,
  };
  const signStr = md5(Object.keys(values).sort().map((k) => values[k]!).join('')).slice(8, 24);
  const query = new URLSearchParams({
    timespan, nonce, deviceID: deviceId, accountId: account.userId,
    accountNumber: account.accountNumber, signStr,
  });
  const res = await requestJson('GET', ACCOUNT_BASE + '/appuseroperate/getnewtoken?' + query.toString(), {
    headers: { ...accountHeaders(deviceId), 'XFX-CDN-CROSS-REFRESH-NODE': account.refreshToken },
    timeoutMs: 20000,
  });
  requireCloudResponse(res);
  const data = (res.data && typeof res.data === 'object' ? res.data : {}) as Record<string, unknown>;
  const token = String(data.token || '');
  if (!token) throw new Error('续期响应缺少 token');
  const ttl = Number(data.tokenExpired || 21600);
  return { ...account, token, refreshToken: data.refreshToken ? String(data.refreshToken) : account.refreshToken, expiresAt: Date.now() + (Number.isFinite(ttl) && ttl > 0 ? ttl : 21600) * 1000 };
}

export async function exchangeCarToken(account: AccountLogin, deviceId: string): Promise<CarLogin> {
  if (!account.userId) throw new Error('账号登录响应缺少 accountId');
  const timestamp = String(Date.now());
  const core: Record<string, string> = {
    acceptLanguage: LANGUAGE,
    channel: '1',
    deviceType: 'android',
    source: 'leapmotor',
    timestamp,
    version: APP_VERSION,
    nonce: String(Math.floor(1000000 + Math.random() * 8999999)),
  };
  const body = { identifier: account.userId, security: account.token, identifierType: '1' };
  const merged = { ...core, ...body };
  const variants: Array<{ sign: string | null }> = [
    { sign: (await sha256Hex(sortAndConcat(merged))).toUpperCase() },
    { sign: await sha256Hex(sortAndConcat(merged)) },
    { sign: null },
  ];
  let last: Record<string, unknown> = {};
  for (const variant of variants) {
    const headers: Record<string, string> = {
      ...core,
      'x-region': REGION,
      'x-subversion': APP_SUBVERSION,
      'x-api-signature-version': '2.0',
      'Content-Type': 'application/json; charset=utf-8',
    };
    if (variant.sign) { headers.sign = variant.sign; headers.digest = variant.sign; }
    const res = await requestJson('POST', GLOBAL_HOST + '/base/base-user/account/v1/login', {
      headers, body: JSON.stringify(body), timeoutMs: 20000,
    });
    last = res;
    const data = (res.data && typeof res.data === 'object' ? res.data : {}) as Record<string, unknown>;
    const accessToken = String(data.accessToken || '');
    if (accessToken) {
      const signParam = (data.signParam && typeof data.signParam === 'object' ? data.signParam : {}) as { r2?: string; r3?: string };
      return {
        accessToken,
        refreshToken: data.refreshToken ? String(data.refreshToken) : undefined,
        hkdfKeyHex: deriveHkdfKeyHex(accessToken, signParam),
        expiresAt: Date.now() + Number(data.tokenExpireTime || 7200) * 1000,
      };
    }
  }
  requireCloudResponse(last);
  throw new Error('车端登录暂不可用。');
}

async function signedHeaders(car: CarLogin, account: AccountLogin, deviceId: string, payload: Record<string, unknown>, vin?: string, carType?: string): Promise<Record<string, string>> {
  const signed: Record<string, string> = {
    acceptLanguage: LANGUAGE,
    channel: '1',
    deviceType: 'android',
    source: 'leapmotor',
    timestamp: String(Date.now()),
    version: APP_VERSION,
    deviceId,
  };
  const sign = await hmacSha256Hex(car.hkdfKeyHex, sortAndConcat({ ...payload, ...signed }));
  return {
    ...signed,
    'x-region': REGION,
    'x-subversion': APP_SUBVERSION,
    'x-api-signature-version': '2.0',
    token: car.accessToken,
    userId: account.userId,
    ...(vin ? { carvin: vin } : {}),
    ...(carType ? { cartype: carType } : {}),
    sign,
    digest: sign,
    'Content-Type': 'application/x-www-form-urlencoded',
  };
}

function num(v: unknown): number | null {
  return numberOf(v);
}
function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
function rawNum(raw: Record<string, unknown>, id: string): number | null {
  return num(raw[id]);
}

function heatingSwitch(raw: Record<string, unknown>, id: string): boolean | null {
  const reading = raw[id];
  if (typeof reading === 'boolean') return reading;
  const value = rawNum(raw, id);
  return value === 0 ? false : value === 1 || value === 2 ? true : null;
}

function climateSetpoint(raw: Record<string, unknown>) {
  for (const id of ['2183', '2184']) {
    const degrees = rawNum(raw, id);
    if (degrees !== null && degrees >= 16 && degrees <= 32) return degrees;
  }
  return null;
}

function mapVehicle(raw: Record<string, unknown>): Vehicle {
  const type = String(raw.carType || raw.carTypeCode || raw.series || '');
  const abilities = raw.carPer ?? raw.abilities ?? raw.ability;
  return {
    id: String(raw.carId || raw.id || raw.vin || ''),
    vin: String(raw.vin || raw.carVin || raw.carvin || ''),
    nickname: String(raw.nickName || raw.vinNickname || raw.name || '我的零跑'),
    model: String(raw.seriesName || type || '零跑'),
    carType: typeof raw.carType === 'string' && raw.carType.trim() ? raw.carType.trim().toUpperCase() : undefined,
    abilities: permissionCodes(abilities),
    commandRights: permissionCodes(raw.rightList),
    year: Number(raw.year || 0),
    declaredPowertrain: namedPowertrain(type + ' ' + String(raw.seriesName ?? '')),
    source: 'live',
  };
}

function mapState(vehicleId: string, vin: string, payload: Record<string, unknown>, t03: boolean): CarState {
  const data = record(payload.data);
  const signalMap = record(data.signalMap);
  const signal = record(data.signal);
  const source = Object.keys(signalMap).length ? signalMap : t03 ? (Object.keys(signal).length ? signal : data) : signalMap;
  if ([data.vin, source.vin].some(value => value && String(value).trim().toUpperCase() !== vin.toUpperCase())) {
    throw new ServiceFailure('mismatch');
  }
  const raw = t03 ? normalizeT03(source) : source;
  const mirrorLeft = heatingSwitch(raw, '49'), mirrorRight = heatingSwitch(raw, '50');
  const soc = socPercent(rawNum(raw, '100003')) ?? socPercent(rawNum(raw, '1204'));
  const ranges = powertrainRanges(raw);
  const range = displayedRange(ranges.evidence ? 'reev' : 'bev', ranges);
  const fuel = rawNum(raw, '3235');
  const speed = rawNum(raw, '1319');
  const gear = rawNum(raw, '1010');
  const windowPercent = ['644', '865', '645', '866'].map(id => rawNum(raw, id)).map(value => value !== null && value >= 0 && value <= 100 ? value : null);
  const windows = ['1693', '1694', '1695', '1696'].map((id, i) => rawNum(raw, id) ?? windowPercent[i] ?? null);
  if (!(t03 ? hasT03Telemetry(raw) : Object.keys(raw).some(key => /^\d+$/.test(key)))) throw new ServiceFailure('empty');
  const tirePressureKpa = ['2646', '2653', '2660', '2667'].map(id => rawNum(raw, id));
  const plug = rawNum(raw, '47');
  const connection = rawNum(raw, '1149');
  const voltage = rawNum(raw, '1177');
  const current = rawNum(raw, '1178');
  const dc = rawNum(raw, '1197');
  const chargePower = voltage !== null && current !== null && voltage > 0 ? Math.abs(voltage * current) / 1000 : null;
  const isDriving = gear === 1 || gear === 3 || (speed !== null && speed > 0);
  const stationaryGear = gear === 0 || gear === 2;
  const parked = !isDriving && (stationaryGear || speed === 0);
  const connected = plug === 1 || dc === 1 || (connection !== null && connection >= 1 && connection <= 4);
  const charging = !isDriving && (connection === 1 || parked && connection === null && connected && chargePower !== null && chargePower > 0 && chargePower <= 400)
    ? 'charging' as const
    : (!isDriving && connected ? 'plugged' as const : 'unplugged' as const);
  const lock = rawNum(raw, '1298');
  const trunk = rawNum(raw, '1281');
  const sunshade = rawNum(raw, '1724');
  const latitude = rawNum(raw, '3') ?? rawNum(raw, '3725') ?? rawNum(raw, '2190');
  const longitude = rawNum(raw, '2') ?? rawNum(raw, '3724') ?? rawNum(raw, '2191');
  const timestamp = t03 ? t03Timestamp : vehicleTimestamp;
  const reportedAt = timestamp(raw.sts) ?? timestamp(data.sts);
  const updated = timestamp(data.collectTimeMs) ?? timestamp(data.collectTime)
    ?? (t03 ? timestamp(source.collectTimeMs) ?? timestamp(source.collectTime) : null) ?? reportedAt ?? 0;
  return {
    vehicleId,
    updatedAt: updated, reportedAt,
    ...(t03 && raw.sts == null && data.sts == null && updated > 0 ? { recordingFallbackAt: updated } : {}),
    freshness: !updated ? 'unknown' : Date.now() - updated > 30 * 60_000 ? 'stale' : 'fresh',
    soc, rangeKm: range.km, rangeReadings: ranges,
    fuelPercent: fuel,
    fuelRangeKm: ranges.fuel,
    sentry: rawNum(raw, '3636') === 1 ? true : rawNum(raw, '3636') === 0 ? false : null,
    locked: lock == null ? null : lock === 1,
    trunkOpen: trunk == null ? null : trunk === 1,
    windowOpen: [...windows, ...windowPercent].some(x => x !== null && x > 0) ? true : windows.every(x => x === 0) ? false : null,
    windowPercent,
    sunshadeOpen: sunshade === null || sunshade < 0 || sunshade > 100 ? null : sunshade > 0,
    sunshadePercent: sunshade,
    insideTempC: rawNum(raw, '1349'),
    batteryMinTempC: rawNum(raw, '1182'),
    batteryHeating: raw['1186'] === true || rawNum(raw, '1186') === 1,
    outsideTempC: null,
    tirePressureKpa,
    charging: [plug, connection, dc].every(x => x === null) ? 'unknown' : charging,
    chargingPowerKw: charging === 'charging' && chargePower !== null && chargePower > 0 && chargePower <= 400 ? chargePower : null,
    chargeType: dc === 1 ? 'dc' : dc === 0 && plug === 1 ? 'ac' : undefined,
    remainingChargeMinutes: rawNum(raw, '1200'),
    healthCharging: rawNum(raw, '48') === null ? null : rawNum(raw, '48') === 1,
    climateOn: rawNum(raw, '1938') === null ? null : rawNum(raw, '1938') === 1,
    climateTempC: climateSetpoint(raw), climateFan: rawNum(raw, '1941'),
    seatHeat: rawNum(raw, '2100'), seatVent: rawNum(raw, '2101'),
    steeringHeat: heatingSwitch(raw, '1816'),
    mirrorHeat: mirrorLeft === true || mirrorRight === true ? true : mirrorLeft === false && mirrorRight === false ? false : null,
    isDriving: isDriving || parked ? isDriving : null, parked, stationaryGear, gear, ready: rawNum(raw, '1258') === 1,
    odometer: rawNum(raw, '1318'),
    speedKmh: speed,
    latitude: latitude !== null && Math.abs(latitude) <= 90 ? latitude : null,
    longitude: longitude !== null && Math.abs(longitude) <= 180 ? longitude : null,
  };
}

export class LiveVehicleClient implements VehicleClient {
  private readonly vehiclesById = new Map<string, Vehicle>();
  private readonly standardT03 = new Set<string>();
  private readonly t03Routes = new Map<string, { base: string; form: boolean; expires: number }>();
  private readonly t03ProbeAfter = new Map<string, number>();
  private readonly appointmentRoutes = new Map<string, { base: string; expires: number }>();
  constructor(private readonly car: CarLogin, private readonly account: AccountLogin, private readonly deviceId: string, vehicles: Vehicle[] = []) {
    for (const vehicle of vehicles) this.vehiclesById.set(vehicle.id, vehicle);
  }

  async getVehicles(): Promise<Vehicle[]> {
    const headers = await signedHeaders(this.car, this.account, this.deviceId, {});
    const res = await requestJson('GET', GLOBAL_BASE + 'v1/vehicle/list', { headers, timeoutMs: 20000 });
    const data = (res.data && typeof res.data === 'object' ? res.data : {}) as Record<string, unknown>;
    const items: Vehicle[] = [];
    requireCloudResponse(res);
    for (const key of ['sharedcars', 'bindcars', 'cars', 'list', 'vehicleList']) {
      const list = data[key];
      if (Array.isArray(list)) for (const raw of list) {
        if (!raw || typeof raw !== 'object') continue;
        const vehicle = mapVehicle(raw);
        if (!vehicle.id || !vehicle.vin) continue;
        const existing = items.findIndex(item => item.id === vehicle.id || item.vin.toUpperCase() === vehicle.vin.toUpperCase());
        if (existing !== -1) {
          if (key === 'bindcars' && items[existing].shared) items[existing] = { ...vehicle, id: items[existing].id, shared: false, boundOwner: true };
          continue;
        }
        items.push({ ...vehicle, boundOwner: key === 'bindcars', shared: key === 'sharedcars', grants: key === 'sharedcars' ? sharedGrants(raw as Record<string, unknown>) : undefined });
      }
    }
    const vehicles = items;
    this.vehiclesById.clear();
    for (const vehicle of vehicles) this.vehiclesById.set(vehicle.id, vehicle);
    return vehicles;
  }

  private async resolveVin(vehicleId: string): Promise<string> {
    if (!this.vehiclesById.has(vehicleId)) {
      try { await this.getVehicles(); } catch { /* 保持原值，交给服务端报错 */ }
    }
    return this.vehiclesById.get(vehicleId)?.vin ?? vehicleId;
  }

  private async carGet(path: string, params: Record<string, string>, vin: string, allowEmpty = false, timeoutMs = 20_000, carType?: string, base = CAR_BASE): Promise<Record<string, unknown>> {
    const headers = await signedHeaders(this.car, this.account, this.deviceId, params, vin, carType);
    const query = new URLSearchParams(params).toString();
    const response = await requestJson('GET', base + '/carownerservice/' + path + '?' + query, { headers, timeoutMs });
    if (!allowEmpty || Number(response.code ?? response.result) !== 100 && !/未找到数据|no data/i.test(String(response.message ?? ''))) {
      requireCloudResponse(response);
    }
    return response;
  }

  async getState(vehicleId: string, timeoutMs = 20_000): Promise<CarState> {
    const vin = await this.resolveVin(vehicleId);
    const vehicle = this.vehiclesById.get(vehicleId);
    const carType = vehicle?.carType;
    const t03 = (carType || vehicle?.model?.trim().toUpperCase()) === 'T03';
    const payload = { vin };
    const read = async (base: string, form: boolean) => {
      const headers = await signedHeaders(this.car, this.account, this.deviceId, payload, vin, t03 ? 'T03' : carType);
      return requestJson('POST', base + '/app/app-signal-service/signal/info/query', {
        headers: { ...headers, 'Content-Type': form ? 'application/x-www-form-urlencoded' : 'application/json' },
        body: form ? new URLSearchParams(payload).toString() : JSON.stringify(payload), timeoutMs,
      });
    };
    const parse = (response: Record<string, unknown>) => {
      requireCloudResponse(response);
      return mapState(vehicleId, vin, response, t03);
    };
    const cached = t03 ? this.t03Routes.get(vin) : undefined;
    if (cached && cached.expires > Date.now()) return parse(await read(cached.base, cached.form));
    const response = await read(CAR_BASE, true);
    try {
      const state = parse(response);
      if (t03) this.standardT03.add(vin);
      return state;
    } catch (error) {
      const code = Number(response.code ?? response.result);
      if (error instanceof CloudRateLimited || !t03 || this.standardT03.has(vin) || ![0, 100, 302002002, 302010205, 39].includes(code)
        || Date.now() < (this.t03ProbeAfter.get(vin) ?? 0)) throw error;
      const expires = Date.now() + 3_600_000;
      this.t03ProbeAfter.set(vin, expires);
      const headers = await signedHeaders(this.car, this.account, this.deviceId, payload, vin, 'T03');
      const route = await requestJson('GET', GLOBAL_BASE + 'v1/vehicle/getCarRoute?' + new URLSearchParams(payload), { headers, timeoutMs });
      if (vehicleRateLimited(route)) throw new CloudRateLimited();
      requireCloudResponse(route);
      const data = record(route.data);
      const base = vehicleServiceOrigin(data.appRegion);
      if (!base || (data.vin && data.vin !== vin)) throw error;
      for (const form of base === CAR_BASE ? [false] : [false, true]) {
        const reply = await read(base, form);
        try {
          const state = parse(reply);
          this.t03Routes.set(vin, { base, form, expires });
          return state;
        } catch (probeError) {
          if (probeError instanceof CloudRateLimited || ![0, 100].includes(Number(reply.code ?? reply.result))) throw probeError;
        }
      }
      throw error;
    }
  }

  private pictureCarType(vehicleId: string) {
    const vehicle = this.vehiclesById.get(vehicleId);
    return vehicle?.carType || diagnosticFamily(vehicle?.model);
  }

  async getCarPicture(vehicleId: string): Promise<string | null> {
    const vin = await this.resolveVin(vehicleId);
    const res = await this.carGet('v3/api/carpicture/key', { vin }, vin, false, undefined, this.pictureCarType(vehicleId));
    for (const payload of [record(res.data), res]) {
      for (const key of ['shareBindUrl', 'url', 'imageUrl', 'picUrl', 'carPic']) {
        const value = payload[key];
        if (typeof value === 'string' && /^https?:\/\//i.test(value.trim())) return value.trim().replace(/^http:/i, 'https:');
      }
    }
    return null;
  }

  private async getChargePlan(vehicleId: string, timeoutMs = 20_000) {
    const vin = await this.resolveVin(vehicleId);
    const res = await this.carGet('v3/api/vehicleinfo/commonConfig', { vin }, vin, false, timeoutMs, this.vehiclesById.get(vehicleId)?.carType);
    return record(record(record(res.data).config)['3']);
  }

  async getChargingConfig(vehicleId: string) {
    const c = await this.getChargePlan(vehicleId);
    const time = (value: unknown) => typeof value === 'string' && /^\d\d:\d\d/.test(value) ? value.slice(0, 5) : '';
    const enabled = num(c.isEnable), limit = num(c.percent);
    return { percent: limit !== null && limit >= 50 && limit <= 100 ? limit : null,
      beginTime: time(c.beginTime), endTime: time(c.endTime), enabled: enabled === null ? null : enabled === 1,
      days: chargeRepeatDays(num(c.circulation), c.cycles) };
  }

  private async readPreheatControls(vehicle: Vehicle, timeoutMs: number) {
    if (!allowsPreheat(vehicle) || vehicle.shared && !vehicle.grants?.control) {
      throw new RemoteCommandError('当前车辆没有授予电池预热预约权限。');
    }
    return readPreheatEntries(await this.readAppointment(vehicle, preheatCommandId, timeoutMs));
  }

  private async appointmentOrigin(vehicle: Vehicle, timeoutMs: number) {
    const { vin, carType } = vehicle;
    let route = this.appointmentRoutes.get(vin);
    if (!route || route.expires <= Date.now()) {
      const params = { vin };
      const headers = await signedHeaders(this.car, this.account, this.deviceId, params, vin, carType);
      const response = await requestJson('GET', GLOBAL_BASE + 'v1/vehicle/getCarRoute?' + new URLSearchParams(params), { headers, timeoutMs });
      requireCloudResponse(response);
      const data = record(response.data);
      const base = vehicleServiceOrigin(data.appCenter);
      if (!base || data.vin && String(data.vin).trim().toUpperCase() !== vin.toUpperCase()) {
        throw new RemoteCommandError('车辆的预约服务暂不可用。');
      }
      route = { base, expires: Date.now() + 300_000 };
      this.appointmentRoutes.set(vin, route);
    }
    return route.base;
  }

  private async readAppointment(vehicle: Vehicle, id: number, timeoutMs: number) {
    const { vin, carType } = vehicle;
    const base = await this.appointmentOrigin(vehicle, timeoutMs);
    const params = { carvin: vin, cmdid: String(id), timespan: String(Date.now()),
      nonce: String(1_000_000 + crypto.getRandomValues(new Uint32Array(1))[0]! % 9_000_000), deviceID: this.deviceId };
    const signStr = md5(sortAndConcat({ ...params, token: this.account.token })).slice(8, 24);
    const query = { ...params, signStr };
    const headers = await signedHeaders(this.car, this.account, this.deviceId, query, vin, carType);
    const res = await requestJson('GET', base + '/carownerservice/v3/api/appremotectl/getappointment?' + new URLSearchParams(query), { headers, timeoutMs });
    const code = num(res.code ?? res.result);
    if (cloudAuthErrors.has(code ?? num(res._status) ?? 0)) throw new CloudSessionExpired();
    if (code !== 0 || Number(res._status) >= 400 || res._raw) throw new RemoteCommandError(id === 361 ? '暂时无法读取预约备车。' : '暂时无法读取电池预热预约。');
    return res.data;
  }

  async getPreparationSchedules(vehicleId: string, timeoutMs = 20_000) {
    const vehicle = this.vehiclesById.get(vehicleId) ?? (await this.getVehicles()).find(item => item.id === vehicleId);
    if (!vehicle || !permitsCommand(vehicle, 361) || vehicle.shared && !vehicle.grants?.control) {
      throw new RemoteCommandError('预约备车未授权。');
    }
    return readPreparationPlans(await this.readAppointment(vehicle, 361, timeoutMs));
  }

  async getPreheatSchedules(vehicleId: string, timeoutMs = 20_000) {
    const vehicle = this.vehiclesById.get(vehicleId) ?? (await this.getVehicles()).find(item => item.id === vehicleId);
    if (!vehicle) throw new RemoteCommandError('没有找到当前车辆的预热预约。');
    return (await this.readPreheatControls(vehicle, timeoutMs)).map(entry => entry.plan);
  }

  async get3DInfo(vehicleId: string): Promise<{ modelType: number; previewUrl: string | null }> {
    const { data } = await this.get3DManifest(vehicleId);
    const url = typeof data.shareBindUrl === 'string' ? data.shareBindUrl.replace(/^http:/, 'https:') : null;
    return { modelType: Number(data.modelType || 0), previewUrl: url };
  }

  async get3DManifest(vehicleId: string, trace?: ModelTrace) {
    trace?.('key');
    const vin = await this.resolveVin(vehicleId);
    const carType = this.pictureCarType(vehicleId);
    const endpoint = 'v3/api/carpicture/3d/key';
    const manifest = async (params: Record<string, string>) => {
      const response = await this.carGet(endpoint, params, vin, true, undefined, carType);
      const data = record(response.data), model = record(data.modelParam);
      const modelType = Number(data.modelType), version = String(data.modelVersion ?? '');
      trace?.('manifest', { httpStatus: num(response._status) ?? undefined, modelType: [1, 2, 3].includes(modelType) ? modelType : undefined,
        modelVersion: /^\d{1,4}(?:\.\d{1,4}){0,3}$/.test(version) ? version : undefined,
        hasH5Key: !!data.h5Key, hasSrcKey: !!data.srcKey, hasCarType: !!model.carType, hasYear: model.year != null && model.year !== '',
        family: diagnosticFamily(model.carType), year: diagnosticYear(model.year) });
      return data;
    };
    let data = await manifest({ vin, deviceID: this.deviceId, osVersion: '120.0.6099.230' });
    if (![data.h5Key, data.srcKey, Object.keys(record(data.modelParam)).length, data.modelType, data.modelVersion].some(Boolean)) {
      trace?.('fallback');
      data = await manifest({ vin });
    }
    return { data, vin, carType };
  }

  async get3DPackages(vehicleId: string, trace?: ModelTrace): Promise<{ h5: ArrayBuffer; src: ArrayBuffer; modelParam: Record<string, unknown> }> {
    const { data, vin, carType } = await this.get3DManifest(vehicleId, trace);
    const h5Key = String(data.h5Key || '');
    const srcKey = String(data.srcKey || '');
    const modelParam = record(data.modelParam);
    if (Number(data.modelType) === 2) {
      trace?.('unavailable');
      throw new CarPictureOnly();
    }
    if (Number(data.modelType) === 1 || !h5Key || !srcKey || !modelParam.carType || modelParam.year == null || modelParam.year === '') {
      trace?.('unavailable');
      throw new Error('零跑云未提供本车的 3D 素材。');
    }
    const getZip = async (key: string, kind: 'h5' | 'src'): Promise<ArrayBuffer> => {
      trace?.(kind);
      const params = { vin, key };
      const headers = await signedHeaders(this.car, this.account, this.deviceId, params, vin, carType);
      let httpStatus: number | undefined;
      const bytes = await requestBinary(CAR_BASE + '/carownerservice/v3/api/carpicture/key/package?' + new URLSearchParams(params).toString(),
        { headers, timeoutMs: 180000, onStatus: status => { httpStatus = status; } }).catch(error => {
          if (httpStatus) trace?.('received', { httpStatus });
          throw error;
        });
      const head = new Uint8Array(bytes, 0, Math.min(2, bytes.byteLength));
      trace?.('received', { httpStatus, bytes: bytes.byteLength,
        format: head[0] === 80 && head[1] === 75 ? 'zip' : head[0] === 31 && head[1] === 139 ? 'gzip' : 'other' });
      return bytes;
    };
    return { h5: await getZip(h5Key, 'h5'), src: await getZip(srcKey, 'src'), modelParam };
  }

  async getParkingPhoto(vehicleId: string): Promise<{ url: string | null; uploadTime: number | null }> {
    const vin = await this.resolveVin(vehicleId);
    const res = await this.carGet('v3/api/chassis/query', { vin }, vin);
    const data = (res.data && typeof res.data === 'object' ? res.data : {}) as Record<string, unknown>;
    const raw = typeof data.fileUrl === 'string' ? data.fileUrl : '';
    return { url: raw ? raw.replace(/^http:/, 'https:') : null, uploadTime: num(data.uploadTime) };
  }

  async getCapabilities(vehicleId: string): Promise<Capability[]> {
    const vehicle = this.vehiclesById.get(vehicleId);
    return [
      { key: 'lock', label: '车门锁', status: 'available' },
      { key: 'windows', label: '车窗', status: 'available' },
      { key: 'trunk', label: '后备箱', status: 'available' },
      { key: 'climate', label: '空调', status: 'available' },
      { key: 'seat_heat', label: '座椅加热', status: 'available' },
      { key: 'sentry', label: '哨兵模式', status: vehicle?.boundOwner && permitsCommand(vehicle, 400) ? 'available' : 'unavailable' },
      { key: 'tpms', label: '胎压', status: 'signal_missing' },
    ];
  }

  async sendCommand(vehicleId: string, command: RemoteCommand, pin: string, signal: AbortSignal, preparing: () => void, pinVerified?: () => Promise<void>, expectedVin?: string) {
    const vehicle = (await this.getVehicles()).find(item => item.id === vehicleId);
    signal.throwIfAborted();
    if (!vehicle || expectedVin && vehicle.vin !== expectedVin || vehicle.shared && command.kind !== 'lock' && !vehicle.grants?.control
      || vehicle.shared && command.kind === 'navigation' && !vehicle.grants?.location) {
      throw new RemoteCommandError('当前车辆没有授予此项操作权限。');
    }
    if (command.kind === 'preheat' && !allowsPreheat(vehicle)) throw new RemoteCommandError('当前车辆没有授予电池预热预约权限。');
    const { vin, carType } = vehicle;
    const before = await this.getState(vehicleId, remoteTimeout);
    signal.throwIfAborted();
    if (before.isDriving || !before.stationaryGear) throw new RemoteCommandError('未确认车辆已驻车。请停车挂 P 挡并刷新车况。');
    if (command.kind === 'cabinHeat' && before[command.feature] == null) throw new RemoteCommandError('车辆暂未返回此项加热功能的状态。');
    if (command.kind === 'sentry' && (!vehicle.boundOwner || !permitsCommand(vehicle, 400) || before.sentry == null)) {
      throw new RemoteCommandError('哨兵模式需要主账号授权和有效的车辆状态。');
    }
    if (command.kind === 'sentry' && command.onlyWhenParkedOff && !needsParkingSentry(before)) {
      throw new RemoteCommandError(before.sentry ? '车辆哨兵已开启。' : '未确认本次驻车的哨兵状态。');
    }
    const preparation = command.kind === 'prepare' || command.kind === 'prepareSchedule';
    if (preparation && !permitsCommand(vehicle, command.kind === 'prepare' ? 360 : 361)) throw new RemoteCommandError('本账号没有此项备车权限。');
    if (command.kind === 'prepare' && !allowsPreparationContent(vehicle, command.content, false, !vehicle.shared || !!vehicle.grants?.location)) {
      throw new RemoteCommandError('当前车辆或账号不支持预设中的操作。');
    }
    const base = preparation ? await this.appointmentOrigin(vehicle, remoteTimeout) : CAR_BASE;
    const planPatch = command.kind === 'charge' && 'plan' in command ? command.plan : null;
    const plan = planPatch ? await this.getChargePlan(vehicleId, remoteTimeout) : {};
    const standard = command.kind === 'preheat' || command.kind === 'prepareSchedule' ? null : encodeRemote(command, plan);
    const password = await encryptOperationPin(pin, this.car.accessToken);
    const post = async (path: string, payload: Record<string, string>, sending = false) => {
      const headers = await signedHeaders(this.car, this.account, this.deviceId, payload, vin, carType);
      signal.throwIfAborted();
      if (sending) preparing();
      return requestJson('POST', base + '/carownerservice/' + path, {
        headers: { ...headers, 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams(payload).toString(), timeoutMs: remoteTimeout,
      });
    };
    const requireApproval = (response: Record<string, unknown>, verifying: boolean) => {
      const code = Number(response.code ?? response.result ?? response._status);
      if (code === 70) throw new RemoteCommandError('操作密码已锁定，请 5 分钟后再试。');
      if (code === 4) throw new OperationPinRejected('零跑操作密码错误，请核对后再试。');
      if (code === 40 || code === 403) throw new RemoteCommandError('零跑拒绝了本次操作，请核对共享车辆授权。');
      if (cloudAuthErrors.has(code)) throw new CloudSessionExpired();
      if (response._raw || Number(response._status) >= 500 || !Number.isFinite(code)) {
        if (!verifying) throw new RemoteDeliveryUnknown();
        throw new RemoteCommandError('暂时无法验证操作密码，请稍后再试。');
      }
      if (code !== 0 || Number(response._status) >= 400 || response.result === false || response.data === false) {
        throw new RemoteCommandError(verifying ? '零跑未通过操作密码校验。' : '零跑拒绝了本次操作，请检查车辆状态和授权。');
      }
    };
    const verification = await post('v3/api/appoperate/verifyoperatepwdnew', { vin, oprpwd: password });
    requireApproval(verification, true);
    signal.throwIfAborted();
    await pinVerified?.();
    signal.throwIfAborted();
    const preheat = command.kind === 'preheat'
      ? preparePreheatEdit(await this.readPreheatControls(vehicle, remoteTimeout), command.edit, vin) : null;
    const schedule = command.kind === 'prepareSchedule'
      ? applyPreparationEdit(await this.getPreparationSchedules(vehicleId, remoteTimeout), command.edit, vin) : null;
    if (schedule?.target?.enable && !allowsPreparationContent(vehicle, schedule.target.datacontent, true, !vehicle.shared || !!vehicle.grants?.location)) {
      throw new RemoteCommandError('当前车辆或账号不支持预约中的操作。');
    }
    const encoded = standard ?? (schedule ? { id: 361, state: { controls: schedule.controls } } : { id: preheatCommandId, state: { controls: preheat!.controls } });
    const nonce = String(1_000_000 + crypto.getRandomValues(new Uint32Array(1))[0]! % 9_000_000);
    const sentAt = Date.now();
    const payload: Record<string, string> = { cmdid: String(encoded.id), state: JSON.stringify(encoded.state), carvin: vin, nonce, oppwd: password };
    if (preparation) {
      Object.assign(payload, { timespan: String(sentAt), deviceID: this.deviceId });
      payload.signStr = md5(sortAndConcat({ ...payload, token: this.account.token })).slice(8, 24);
    }
    const response = await (encoded.id === null
      ? post('v3/api/healthyCharging/control', { carvin: vin, state: String(encoded.state), oppwd: password }, true)
      : post('v3/api/appremotectl', payload, true));
    requireApproval(response, false);
    const msgId = typeof response.data === 'string' ? response.data : record(response.data).msgID ?? record(response.data).msgId;
    return { vehicleId, vin, carType, before, sentAt, base, planPatch, plan, preparationTarget: schedule, preheatTarget: preheat?.plan, msgId: typeof msgId === 'string' ? msgId : null };
  }

  async queryCommand(receipt: Awaited<ReturnType<LiveVehicleClient['sendCommand']>>) {
    if (!receipt.msgId) return 'pending';
    const res = await this.carGet('v3/api/appremotectl/query', { msgID: receipt.msgId }, receipt.vin, false, remoteTimeout, receipt.carType, receipt.base);
    const data = record(res.data);
    const value = data.status ?? data.result;
    const status = String(value ?? '').toLowerCase();
    if (['success', 'true'].includes(status)) return 'confirmed';
    if (['fail', 'failed', 'false'].includes(status)) return 'failed';
    return 'pending';
  }

  async confirmChargePlan(vehicleId: string, patch: ChargePlanPatch, before: Record<string, unknown>) {
    const current = await this.getChargePlan(vehicleId, remoteTimeout);
    const compare = (state: ReturnType<typeof chargePlanState>) => ({ ...state,
      cycles: chargeRepeatDays(state.circulation, state.cycles)?.join(',') ?? state.cycles });
    const intended = compare(chargePlanState(patch, before));
    const previous = compare(chargePlanState({}, before));
    const updated = compare(chargePlanState({}, current));
    return (Object.keys(intended) as Array<keyof typeof intended>).some(key => previous[key] !== intended[key])
      && (Object.keys(intended) as Array<keyof typeof intended>).every(key => intended[key] === updated[key]);
  }
  async getEnergy(vehicleId: string, days = 7, signal?: AbortSignal): Promise<EnergyDay[]> {
    const vin = await this.resolveVin(vehicleId);
    const end = Date.now();
    const today = dayStart(end);
    const begin = today - (Math.min(31, Math.max(1, days)) - 1) * 86400_000;
    const statusKey = `cloud-energy:${this.account.userId}:${vehicleId}`;
    type DayCache = Record<string, { kwh: number; fetched: number }>;
    const cache = await readDataset<DayCache>(statusKey).catch(() => undefined) ?? {};
    const res = await this.carGet('v3/api/drivingrecord/mileage/energy/detail', {
      vin, begintime: String(begin), endtime: String(end),
    }, vin, true).catch(error => {
      if (error instanceof CloudSessionExpired) throw error;
      return null;
    });
    const data = record(res?.data);
    const detail = Array.isArray(data.detail) ? data.detail : [];
    const mileage = new Map(detail.map(item => {
      const row = record(item);
      const km = num(row.accumulatedMileage);
      return [String(row.day ?? '').slice(0, 10), km !== null && km >= 0 ? km : null];
    }));
    const rows: EnergyDay[] = [];
    let unavailable = false;
    for (let at = today; at >= begin; at -= 86400_000) {
      signal?.throwIfAborted();
      const day = cloudDay(at);
      const cached = cache[day];
      const km = mileage.get(day) ?? null;
      let kwh = cached?.kwh ?? null;
      if (!unavailable && (!cached || at === today && end - cached.fetched >= 30 * 60_000)) {
        try {
          const reply = await this.carGet('v3/api/drivingrecord/getLastweekEC', {
            carvin: vin, begintime: String(Math.floor(at / 1000)), endtime: String(Math.floor(Math.min(end, at + 86_400_000 - 1) / 1000)),
          }, vin, true);
          const total = energyParts(record(reply.data)).total;
          if (total !== null) {
            kwh = total;
            cache[day] = { kwh, fetched: end };
          }
        } catch (error) {
          if (error instanceof CloudSessionExpired) throw error;
          unavailable = true;
        }
      }
      rows.push({ day, km, kwh, efficiency: km !== null && km > 0 && kwh !== null ? kwh / km * 100 : null });
    }
    const keepDays = cloudDay(today - 400 * 86_400_000);
    signal?.throwIfAborted();
    await saveDataset(statusKey, Object.fromEntries(Object.entries(cache).filter(([day]) => day >= keepDays))).catch(() => {});
    if (!res && rows.every(row => row.kwh === null)) throw new Error('暂时无法读取零跑云能耗。');
    return rows.reverse();
  }
  async getMileageSummary(vehicleId: string, signal: AbortSignal) {
    const vin = await this.resolveVin(vehicleId);
    const end = Date.now(), monthStart = periodStart('month', end);
    const read = async (from: number) => {
      signal.throwIfAborted();
      const response = await this.carGet('v3/api/drivingrecord/mileage/energy/detail', {
        vin, begintime: String(from), endtime: String(end),
      }, vin, true);
      requireCloudResponse(response);
      return record(response.data);
    };
    const month = await read(monthStart);
    const nonnegative = (v: unknown) => { const n = num(v); return n !== null && n >= 0 ? n : null; };
    const deliveryDays = nonnegative(month.deliveryDays);
    let totalEnergy: number | null = null;
    if (deliveryDays !== null) {
      const delivered = dayStart(end) - Math.ceil(deliveryDays) * 86_400_000;
      try {
        const entire = delivered >= monthStart ? month : await read(delivered);
        totalEnergy = nonnegative(entire.totalEnergy);
      } catch (error) { if (signal.aborted || error instanceof CloudSessionExpired) throw error; }
    }
    return { deliveryDays, totalKm: nonnegative(month.totalmileage), totalEnergy, monthKm: nonnegative(month.totalAccumulatedMileage),
      daily: Array.isArray(month.detail) ? month.detail.map(item => {
        const row = record(item);
        return { day: String(row.day ?? '').slice(0, 10), km: nonnegative(row.accumulatedMileage) };
      }) : [] };
  }
  async getEnergyRank(vehicleId: string) {
    const vin = await this.resolveVin(vehicleId);
    const response = await this.carGet('v3/api/drivingrecord/getLastNweeks100kmECAndRank', { carvin: vin }, vin);
    const result = record(record(response.data).rankResult);
    return { rank: energyRankOf(result.rank), efficiency: num(result.hundredKmEC) };
  }
  async getEnergyFacts(vehicleId: string, withFuel: boolean) {
    const vin = await this.resolveVin(vehicleId);
    const today = dayStart(Date.now());
    const monday = today - (new Date(today + 8 * 3_600_000).getUTCDay() + 6) % 7 * 86_400_000;
    const start = monday - 7 * 86_400_000;
    const splitQuery = this.carGet('v3/api/drivingrecord/getLastweekEC', {
      carvin: vin, begintime: String(start / 1000), endtime: String(monday / 1000 - 1),
    }, vin, true);
    const fuelQuery = withFuel ? this.carGet('v3/api/drivingrecord/getPlugInLastNweeks100kmEC', { carvin: vin }, vin) : Promise.resolve(null);
    const [splitInfo, fuelInfo] = await Promise.allSettled([splitQuery, fuelQuery]);
    const read = (result: PromiseSettledResult<Record<string, unknown> | null>) =>
      result.status === 'fulfilled' && result.value?.data && typeof result.value.data === 'object'
        ? result.value.data as Record<string, unknown> : {};
    const split = read(splitInfo);
    const energy = read(fuelInfo).hundredKmEC as Record<string, unknown> | undefined;
    return {
      breakdown: energyParts(split),
      fuel: num(energy?.oc100km ?? read(fuelInfo).oc100km),
    };
  }
  async getCharges(vehicleId: string, signal?: AbortSignal, includeLocation = false): Promise<Charge[]> {
    const vin = await this.resolveVin(vehicleId);
    const end = Date.now();
    const request = { vin, timeZone: 'UTC+8', startTime: cloudDay(end - 89 * 86_400_000), endTime: cloudDay(end), pageSize: 100 };
    const charges = new Map<string, Charge>();
    let received = 0;
    for (let pageNum = 1; pageNum <= 10; pageNum++) {
      signal?.throwIfAborted();
      const body = { ...request, pageNum };
      const headers = await signedHeaders(this.car, this.account, this.deviceId, body, vin);
      const response = await requestJson('POST', CAR_BASE + '/carownerservice/charge/daily/detail/page', {
        headers: { ...headers, 'Content-Type': 'application/json;charset=UTF-8' }, body: JSON.stringify(body),
      });
      requireCloudResponse(response);
      const data = record(response.data);
      if (!Array.isArray(data.list)) throw new Error('充电记录暂不可用。');
      for (const raw of data.list) {
        const charge = officialCharge(record(raw), includeLocation);
        if (charge) charges.set(charge.id, charge);
      }
      const total = num(data.total);
      received += data.list.length;
      if (data.list.length === 0 || (total !== null ? received >= total : data.list.length < (num(data.pageSize) ?? request.pageSize))) break;
    }
    return [...charges.values()].sort((a, b) => b.startedAt - a.startedAt);
  }
}

export async function connectLive(phone: string, code: string, deviceId = randomDeviceId(), onStage?: (stage: LoginStage) => void): Promise<LiveVehicles> {
  onStage?.('sms-verify');
  const account = await loginWithSms(phone, code, deviceId);
  onStage?.('vehicle-auth');
  const car = await exchangeCarToken(account, deviceId);
  const client = new LiveVehicleClient(car, account, deviceId);
  onStage?.('vehicle-list');
  const vehicles = await client.getVehicles();

  return { vehicles, account, car, deviceId };
}
