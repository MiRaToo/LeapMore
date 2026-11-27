import { CloudSessionExpired, LiveVehicleClient, exchangeCarToken } from '../../src/data/cloud/LiveClient';
import type { LiveVehicles } from '../../src/data/cloud/LiveClient';
import { CloudRateLimited, VehiclePolling } from '../../src/data/cloud/polling';
import { cloudFrame, RepeatedReportParking } from '../../src/data/cloud/records';

// The recording host exposes only HTTP and the result callback. No control or password bridge is installed.
export function tripSampler(credentials: string, account: string, id: string, vin: string) {
  const session = JSON.parse(credentials) as LiveVehicles;
  let car = session.car;
  let client = new LiveVehicleClient(car, session.account, session.deviceId);
  let checkedAt = 0, mayLocate = false;
  const polling = new VehiclePolling();
  const startedAt = Date.now();
  const parking = new RepeatedReportParking();
  return async (locationAllowed: boolean) => {
    const finish = (result: object) => QuickHost.finish('', JSON.stringify(result));
    try {
      if (account !== session.account.userId || !vin || !id) throw new CloudSessionExpired();
      if (car.expiresAt <= Date.now() + 30_000) {
        if (session.account.expiresAt <= Date.now() + 30_000) throw new CloudSessionExpired();
        car = await exchangeCarToken(session.account, session.deviceId);
        client = new LiveVehicleClient(car, session.account, session.deviceId);
        checkedAt = 0;
      }
      if (Date.now() - checkedAt >= 60_000) {
        const vehicle = (await client.getVehicles()).find(v => v.id === id && v.vin.toUpperCase() === vin.toUpperCase());
        if (!vehicle || vehicle.shared && !vehicle.grants?.mileage) {
          finish({ interrupt: '车辆行程授权已变更' }); return;
        }
        mayLocate = !vehicle.shared || !!vehicle.grants?.location;
        checkedAt = Date.now();
      }
      const state = await client.getState(id, 6000);
      if (state.vehicleId !== id) { finish({ interrupt: '车辆信息不匹配' }); return; }
      polling.observe(state);
      const report = mayLocate && locationAllowed ? state : { ...state, latitude: null, longitude: null };
      const frame = cloudFrame(report, mayLocate && locationAllowed, Date.now(), polling.delay());
      const sample = frame && frame.at >= startedAt - 1000 ? parking.observe(frame, Date.now()) ?? frame : null;
      finish({ report, frame: sample, delay: polling.delay() });
    } catch (error) {
      if (error instanceof CloudSessionExpired) { finish({ interrupt: '请解锁并刷新登录后继续' }); return; }
      if (error instanceof CloudRateLimited) polling.rateLimit();
      finish({ delay: error instanceof CloudRateLimited ? polling.delay() : 30_000, note: '等待车辆服务恢复' });
    }
  };
}
