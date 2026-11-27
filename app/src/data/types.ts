import type { RangeReadings } from './powertrain.ts';

/** 跨 UI 与数据层的稳定领域类型；真实字段以协议校对表为准。 */
export type DataSource = 'fixture' | 'live' | 'replay' | 'ha' | 'phone';
export type Powertrain = 'bev' | 'reev';
export type CapabilityStatus = 'available' | 'signal_missing' | 'unsupported' | 'unavailable' | 'pending';
export type Freshness = 'fresh' | 'stale' | 'offline' | 'unknown';

export interface Vehicle {
  id: string;
  vin: string;
  nickname: string;
  model: string;
  year: number;
  declaredPowertrain?: Powertrain;
  source: DataSource;
  shared?: boolean;
  boundOwner?: boolean;
  carType?: string;
  abilities?: string[];
  commandRights?: string[];
  grants?: { control: boolean; location: boolean; mileage: boolean };
}

export interface Capability {
  key: string;
  label: string;
  status: CapabilityStatus;
  reason?: string;
}

export interface CarState {
  vehicleId: string;
  updatedAt: number;
  reportedAt?: number | null;
  /** Collection time on legacy T03 reports that omit the vehicle timestamp. */
  recordingFallbackAt?: number;
  freshness: Freshness;
  soc: number | null;
  rangeKm: number | null;
  fuelPercent: number | null;
  fuelRangeKm: number | null;
  rangeReadings?: RangeReadings;
  locked: boolean | null;
  sentry?: boolean | null;
  trunkOpen: boolean | null;
  windowOpen: boolean | null;
  windowPercent?: (number | null)[];
  sunshadeOpen: boolean | null;
  sunshadePercent?: number | null;
  insideTempC: number | null;
  outsideTempC: number | null;
  tirePressureKpa: (number | null)[];
  charging: 'unplugged' | 'plugged' | 'charging' | 'done' | 'unknown';
  climateOn: boolean | null;
  climateTempC?: number | null;
  climateFan?: number | null;
  seatHeat?: number | null;
  seatVent?: number | null;
  steeringHeat?: boolean | null;
  mirrorHeat?: boolean | null;
  stationaryGear?: boolean;
  gear?: number | null;
  ready?: boolean;
  isDriving: boolean | null;
  parked?: boolean;
  odometer?: number | null;
  speedKmh?: number | null;
  chargingPowerKw?: number | null;
  batteryMinTempC?: number | null;
  batteryHeating?: boolean | null;
  chargeType?: 'ac' | 'dc';
  remainingChargeMinutes?: number | null;
  healthCharging?: boolean | null;
  latitude?: number | null;
  longitude?: number | null;
}

export interface AcTariff {
  peak: number;
  valley: number;
  valleyStart: string;
  valleyEnd: string;
  efficiency: number;
}

export interface DcTariffPeriod {
  start: string;
  end: string;
  price: number;
}

export interface Tariff {
  ac: AcTariff;
  dc: { periods: DcTariffPeriod[]; efficiency: number };
}

export interface EnergyDay {
  day: string;
  km: number | null;
  kwh: number | null;
  efficiency: number | null;
  pending?: boolean;
}

export interface TripSummary {
  id: string;
  startedAt: number;
  endedAt: number | null;
  distanceKm: number | null;
  durationMin: number | null;
  energyKwh: number | null;
  efficiency: number | null;
  avgSpeedKmh: number | null;
  pointCount: number | null;
  source: DataSource;
  complete: boolean;
}

export type ChargeType = 'ac' | 'dc' | 'unknown' | 'mixed';

export interface ChargeSession {
  id: string;
  startedAt: number;
  endedAt: number | null;
  type: ChargeType;
  kwh: number | null;
  gridKwh: number | null;
  socStart: number | null;
  socEnd: number | null;
  cost: number | null;
  partial: boolean;
  source: DataSource;
}

export type CommandStep = 'idle' | 'confirming' | 'sending' | 'accepted' | 'waiting' | 'confirmed' | 'unconfirmed' | 'failed';

export interface CommandRun {
  id: string;
  title: string;
  kind: string;
  step: CommandStep;
  startedAt: number;
  updatedAt: number;
  error?: string;
}

export interface DebugScenario {
  name: string;
  freshness: Freshness;
  driving: boolean;
  charging: CarState['charging'];
  recordSource: 'phone' | 'ha' | 'off';
  commandStep: CommandStep;
}

export interface VehicleClient {
  getVehicles(): Promise<Vehicle[]>;
  getState(id: string): Promise<CarState>;
  getCapabilities(id: string): Promise<Capability[]>;
  getEnergy(id: string, days: number): Promise<EnergyDay[]>;
  getCharges(id: string): Promise<ChargeSession[]>;
}
