import { noteRecording } from '../recordingDiagnostics';
import { hasBackgroundRecorder } from '../../platform/recorder';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { deleteDataset, readDataset, updateDataset } from '../localDatabase';
import type { CarState } from '../types';
import type { Charge, Frame } from '../ha/measurements';
import { deriveTrips, numberOf, withChargePositions } from '../ha/measurements';
import type { LiveVehicleClient } from './LiveClient';
import { appendCloudFrame, cloudFrame, dayStart, mergeTripFrames, RepeatedReportParking } from './records';
import { reconcileCharges, sampledCharges } from './charges';
import type { VehicleEnergySettings } from '../vehicleEnergy';

const empty: Frame[] = [];
const chargeCacheTime = 6 * 60 * 60_000;
type ChargeCache = { at: number; rows: Charge[] };

export function useCloudRecords(key: string, vehicle: string, client: LiveVehicleClient | null,
  recording: boolean, location: boolean, state: CarState | undefined, settings: VehicleEnergySettings, observedAt: number, manualTrips = false, nativeSampling = false, pollIntervalMs?: number) {
  const readable = !!key;
  const frameKey = 'cloud-frames:' + key;
  const chargeKey = 'cloud-charges:' + key;
  const [saved, setSaved] = useState<{ key: string; frames: Frame[] }>();
  const [issue, setIssue] = useState('');
  const writing = useRef(Promise.resolve());
  const blocked = useRef(false);
  const parking = useMemo(() => new RepeatedReportParking(), [frameKey, recording]);

  const scope = useRef(frameKey);
  scope.current = frameKey;
  const importFrames = useCallback((batch: Frame[]) => {
    const commit = writing.current.catch(() => {}).then(async () => {
      if (blocked.current || scope.current !== frameKey) throw new Error('记录范围已变更');
      const frames = await updateDataset<Frame[]>(frameKey, prior => mergeTripFrames(prior ?? [], batch));
      if (!blocked.current && scope.current === frameKey) setSaved({ key: frameKey, frames });
    });
    writing.current = commit;
    return commit;
  }, [frameKey]);

  useEffect(() => {
    if (!readable) return;
    let current = true;
    let retry: ReturnType<typeof setTimeout> | undefined;
    blocked.current = false;
    setIssue('');
    async function restore() {
      await writing.current.catch(() => {});
      if (!current || blocked.current) return;
      try {
        const frames = await readDataset<Frame[]>(frameKey);
        if (!current || blocked.current) return;
        setSaved({ key: frameKey, frames: frames ?? empty });
        setIssue('');
        if (retry !== undefined && hasBackgroundRecorder()) noteRecording(key, ['storageRestored']);
      } catch (error) {
        if (!current || blocked.current) return;
        setIssue('无法读取本机车况采样，稍后自动重试。');
        if (hasBackgroundRecorder()) noteRecording(key, ['storageReadFailed'], { error });
        retry = setTimeout(restore, 30_000);
      }
    }
    void restore();
    return () => { current = false; clearTimeout(retry); };
  }, [readable, key, frameKey]);

  useEffect(() => {
    if (!recording || nativeSampling || blocked.current || saved?.key !== frameKey || !state || state.vehicleId !== vehicle) return;
    const report = cloudFrame(state, location && (!manualTrips || state.charging === 'charging'), Date.now(), pollIntervalMs);
    if (!report) return;
    const frame = !manualTrips && parking.observe(report, observedAt) || report;
    if (manualTrips) frame.chargeOnly = true;
    const frames = appendCloudFrame(saved.frames, frame);
    if (frames === saved.frames) return;
    setSaved({ key: frameKey, frames });
    writing.current = writing.current.catch(() => {}).then(async () => {
      let inserted = false;
      const committed = await updateDataset<Frame[]>(frameKey, prior => {
        const existing = prior ?? saved.frames;
        const next = appendCloudFrame(existing, frame);
        inserted = existing !== next;
        return next;
      });
      if (inserted && hasBackgroundRecorder()) noteRecording(key, frame.data.charge === 'charging'
        ? ['committed', 'chargingCommitted'] : ['committed']);
      if (manualTrips && !blocked.current && scope.current === frameKey) setSaved({ key: frameKey, frames: committed });
    });
    void writing.current.catch(error => {
      if (scope.current === frameKey) setIssue('无法保存本机车况采样。');
      if (hasBackgroundRecorder()) noteRecording(key, ['writeFailed'], { error });
    });
  }, [recording, key, frameKey, location, saved, state, vehicle, manualTrips, nativeSampling, pollIntervalMs, observedAt, parking]);

  const charges = useQuery({ queryKey: ['cloud', 'charges', key, location], enabled: recording, staleTime: chargeCacheTime, retry: false,
    queryFn: async ({ signal }) => {
      const at = Date.now(), from = dayStart(at) - 89 * 86_400_000;
      const rows = await client!.getCharges(vehicle, signal, location).catch(error => {
        if (!signal.aborted && hasBackgroundRecorder()) noteRecording(key, ['officialFailed'], { error });
        throw error;
      });
      signal.throwIfAborted();
      if (hasBackgroundRecorder()) noteRecording(key, ['officialRead']);
      const result = await updateDataset<ChargeCache>(chargeKey, prior => ({ at, rows: [...new Map([
        ...(prior?.rows ?? []).filter(row => row.startedAt < from), ...rows,
      ].map(row => [row.id, row])).values()] })).catch(() => ({ rows }));
      return result.rows;
    }, refetchInterval: chargeCacheTime });
  const cachedCharges = useQuery({ queryKey: ['cloud', 'cached-charges', key], enabled: readable, networkMode: 'always', staleTime: Infinity,
    queryFn: () => readDataset<ChargeCache>(chargeKey).then(value => value ?? null) });
  const frames = readable && saved?.key === frameKey ? saved.frames : empty;
  const localCharges = useMemo(() => sampledCharges(frames, settings.capacityKwh, Date.now()),
    [frames, settings.capacityKwh, observedAt]);
  const latestFrame = frames.at(-1);
  const tripFrame = useMemo(() => {
    if (!manualTrips) return frames.at(-1);
    for (let i = frames.length - 1; i >= 0; i--) if (!frames[i].chargeOnly) return frames[i];
  }, [frames, manualTrips]);
  const trips = useMemo(() => deriveTrips(frames, 'live', settings.capacityKwh, Date.now()), [frames, settings.capacityKwh, observedAt]);
  const completedTrips = useMemo(() => trips.filter(record => record.endedAt !== null), [trips]);
  const liveTripFrame = tripFrame && Date.now() - tripFrame.at <= 90_000 ? tripFrame : undefined;
  const liveFrame = latestFrame && Date.now() - latestFrame.at <= 90_000 ? latestFrame : undefined;
  const trip = trips[0];
  const activeTrip = recording && liveTripFrame && trip?.endedAt === null ? {
    id: trip.id,
    record: { ...trip, durationMin: (liveTripFrame.at - trip.startedAt) / 60_000 },
    speedKmh: numberOf(liveTripFrame.data.speed),
    distanceKm: trip.distanceKm ?? (trip.startedAt === liveTripFrame.at && numberOf(liveTripFrame.data.odometer) !== null ? 0 : null),
  } : null;
  const session = localCharges.at(-1);
  const activeCharge = recording && liveFrame?.data.charge === 'charging' && session?.active ? {
    id: session.id,
    soc: session.socEnd,
    kwh: session.kwh ?? (settings.capacityKwh !== null && session.socStart !== null && session.socStart === session.socEnd ? 0 : null),
    powerKw: session.powerTimeline?.at(-1)?.value,
  } : null;
  const official = readable ? charges.data ?? cachedCharges.data?.rows : undefined;
  const rows = useMemo<Charge[]>(() => {
    const sessions = reconcileCharges(official ?? [], localCharges, settings);
    return location ? withChargePositions(sessions, frames) : sessions.map(({ position, ...row }) => row);
  }, [official, localCharges, settings, location, frames]);
  const latestCharge = useRef({ key, state: state?.charging });
  const refetch = charges.refetch;
  useEffect(() => {
    const previous = latestCharge.current;
    latestCharge.current = { key, state: state?.charging };
    if (recording && previous.key === key && previous.state === 'charging' && state?.charging && !['unknown', 'charging'].includes(state.charging)) {
      void refetch({ cancelRefetch: false });
    }
  }, [recording, key, state?.charging, refetch]);
  async function clear() {
    blocked.current = true;
    await writing.current.catch(() => {});
    try {
      if (key) await Promise.all([deleteDataset(frameKey), deleteDataset(chargeKey), deleteDataset('cloud-energy:' + key)]);
      if (scope.current === frameKey) setSaved({ key: frameKey, frames: empty });
    } finally { if (scope.current === frameKey) blocked.current = false; }
  }
  return { trips: completedTrips, charges: rows, frames, activeTrip, activeCharge, loading: readable && (cachedCharges.isLoading || recording && charges.isFetching),
    restoringFrames: readable && saved?.key !== frameKey && !issue && !blocked.current,
    error: charges.error, issue, clear, importFrames, refreshCharges: refetch };
}
