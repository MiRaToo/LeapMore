import { useEffect, useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { currentEntities, invalidateHAWork, testConnection } from './ha/client';
import { historyKey, syncHistory } from './ha/history';
import { archivePointer, archiveVehicles, entityRegistry, syncArchive } from './ha/archive';
import { haChargeSessions, haOlderChargeSessions, haTripHistory, ledgerKeys, readLedger, readSavedLedger, syncLedger } from './ha/ledger';
import { periodStart, type RecordPeriod } from './recordPeriod';
import { chargeWindowStart } from './tariff';
import { candidateVehicles, discoverVehicles, isVehicleVin, normalizedVin, permittedFields, targetVin, vehicleByVin } from './ha/discovery';
import { framesOf, numberOf, withChargePositions } from './ha/measurements';
import { entityIdOf, HA_KEY, samplesOf } from './ha/schema';
import { secureGet, secureRemove, secureSet } from '../platform/secure';
import { NetworkError } from '../platform/network';
import { deleteDataset, deleteDatasetsWithPrefix, readDataset } from './localDatabase';
import { trackPrefix } from './ha/cacheKeys';
import { useSetting } from './preferences';
import type { HAConfig, Mapping, Token } from './ha/schema';
import type { History } from './ha/history';

const emptyMapping: Mapping = {};
const emptyRecords = { trips: [], charges: [] };
interface Binding { vin: string; mapping: Mapping; archiveId: string }
interface HATarget { vehicleId: string; cloudVin?: string; standalone: boolean; location: boolean; mileage: boolean; enabled: boolean; viewingSettings: boolean; viewingRecords: boolean; viewingCharging: boolean; recordPeriod: RecordPeriod; recordTab: 'trips' | 'charges' | 'energy' | null; suspended?: boolean }
function mergeHistory<T extends { id: string; startedAt: number }>(older: T[], recent: T[]) {
  return [...new Map([...older, ...recent].map(row => [row.id, row])).values()].sort((a,b) => b.startedAt-a.startedAt);
}
export function useHA({ vehicleId, cloudVin = '', standalone, location, mileage, enabled, viewingSettings, viewingRecords, viewingCharging, recordPeriod, recordTab, suspended }: HATarget) {
  const qc = useQueryClient();
  const [config, setConfig] = useSetting<HAConfig | null>('haSettings', null);
  const [selectedCars, setSelectedCars] = useSetting<Record<string, string>>('haSelectedCars.v2', {});
  const [bindings, setBindings] = useSetting<Record<string, Binding>>('haAutoBindings.v2', {});
  const [ready, setReady] = useState(false);
  const [hasToken, setHasToken] = useState(false);
  useEffect(() => {
    if (ready && hasToken && config && !config.localScope) {
      setConfig(current => current && !current.localScope ? { ...current, localScope: crypto.randomUUID() } : current);
    }
  }, [ready, hasToken, config, setConfig]);
  useEffect(() => {
    if (suspended) return;
    secureGet<Token>(HA_KEY).then(token => setHasToken(!!token)).catch(() => {}).finally(() => setReady(true));
  }, [suspended]);
  const url = config?.url ?? '';
  const bindingKey = JSON.stringify([config?.localScope, url, vehicleId]);
  const cachedBinding = bindings[bindingKey];
  const active = ready && hasToken && !!config?.localScope;
  const discover = active && (enabled || viewingSettings);
  const refreshInterval = enabled && config?.auto ? 30_000 : false;
  const liveInterval = viewingRecords && mileage && refreshInterval;
  const retry = (count: number, error: unknown) => count < 2 && !(error instanceof NetworkError && [401, 403].includes(error.status));
  const states = useQuery({
    queryKey: ['ha', 'states', config?.url],
    enabled: discover, queryFn: ({ signal }) => currentEntities(config!, signal),
    staleTime: 120_000, refetchInterval: liveInterval || (viewingCharging && refreshInterval) || (refreshInterval && !standalone && 120_000), retry,
  });
  const registry = useQuery({
    queryKey: ['ha', 'entity-registry', url], enabled: discover,
    queryFn: ({ signal }) => entityRegistry(config!, signal), retry: false,
    refetchInterval: refreshInterval && 120_000,
  });
  const archives = useQuery({
    queryKey: ['ha', 'archive-vehicles', url], enabled: discover && mileage,
    queryFn: ({ signal }) => archiveVehicles(config!, signal), retry: false,
    refetchInterval: refreshInterval && 120_000,
  });
  const archivesAvailable = mileage && !archives.isError ? archives.data : undefined;
  const discovered = useMemo(() => registry.data && states.data ? discoverVehicles(registry.data.entries, registry.data.catalog, states.data) : [],
    [registry.data, states.data]);
  const candidates = candidateVehicles(discovered, [...(registry.data?.catalog ?? []), ...(archivesAvailable ?? [])]);
  const selectionKey = JSON.stringify([config?.localScope, url]);
  const selectedVin = selectedCars[selectionKey] || '';
  const canChooseDefault = !!registry.data && (registry.data.catalog.length > 0 ||
    registry.data.registryReadable && !!states.data && (!mileage || !archives.isPending));
  const liveVin = standalone && !selectedVin && !canChooseDefault ? '' : targetVin(candidates, cloudVin, standalone, selectedVin);
  const metadataPending = !registry.data && !archivesAvailable;
  const canUseBinding = active && !!cachedBinding && (standalone ? !selectedVin || normalizedVin(selectedVin) === cachedBinding.vin : normalizedVin(cloudVin) === cachedBinding.vin);
  const storedVin = canUseBinding ? cachedBinding.vin : standalone && isVehicleVin(selectedVin) ? normalizedVin(selectedVin) : '';
  const vin = active ? liveVin || (metadataPending ? storedVin : '') : '';
  const readableRegistry = !!registry.data?.registryReadable && !!states.data;
  const found = readableRegistry ? vehicleByVin(discovered, vin)?.mapping ?? emptyMapping :
    metadataPending && canUseBinding && cachedBinding.vin === vin ? cachedBinding.mapping : emptyMapping;
  const visibleFields = useMemo(() => permittedFields(location, mileage), [location, mileage]);
  const mapping = useMemo<Mapping>(() => Object.fromEntries(visibleFields.flatMap(field => found[field] ? [[field, found[field]]] : [])), [found, visibleFields]);
  const hasMapping = Object.values(mapping).some(Boolean);
  const matchingArchives = vin ? archivesAvailable?.filter(row => normalizedVin(row.vin) === vin) : undefined;
  const archiveId = !mileage || !vin ? '' : matchingArchives?.length === 1 ? matchingArchives[0].vehicle_id :
    !archivesAvailable && !archives.isError && canUseBinding && cachedBinding.vin === vin ? cachedBinding.archiveId : '';
  const identified = candidates.some(candidate => candidate.vin === vin);
  useEffect(() => {
    if (!discover || !vin || !identified || mileage && archives.isPending) return;
    const entry = { vin, mapping: readableRegistry ? mapping : canUseBinding ? cachedBinding.mapping : emptyMapping, archiveId };
    setBindings(current => JSON.stringify(current[bindingKey]) === JSON.stringify(entry) ? current : { ...current, [bindingKey]: entry });
  }, [archiveId, archives.isPending, bindingKey, cachedBinding, canUseBinding, discover, identified, mapping, mileage, readableRegistry, setBindings, vin]);
  const readable = active && mileage && !!vin;
  const recordsEnabled = readable && enabled;
  const history = useQuery({
    queryKey: ['ha', 'history', url, vehicleId, vin, mapping, config?.days],
    enabled: active && enabled && !!vin && hasMapping && (mileage || location),
    queryFn: ({ signal }) => syncHistory(config!, vehicleId, vin, mapping, signal),
    refetchInterval: refreshInterval && 120_000, retry,
  });
  const cachedHistory = useQuery({
    queryKey: ['ha', 'cached', url, vehicleId, vin, mapping],
    enabled: !!config && !!vin && hasMapping, networkMode: 'always',
    queryFn: async () => (await readDataset<History>(historyKey(config!, vehicleId, vin))) ?? null,
  });
  const archive = useQuery({
    queryKey: ['ha', 'archive', config?.url, archiveId],
    enabled: recordsEnabled && !!archiveId && !!archivesAvailable,
    queryFn: ({ signal }) => syncArchive(config!, archiveId!, signal),
    refetchInterval: refreshInterval && 120_000, retry,
  });
  const ledger = useQuery({
    queryKey: ['ha', 'ledger', url, vin, config?.days],
    enabled: recordsEnabled,
    queryFn: ({ signal }) => syncLedger(config!, vin, signal),
    refetchInterval: refreshInterval && (liveInterval || 120_000), retry,
  });
  const cachedLedger = useQuery({
    queryKey: ['ha', 'cached-ledger', config?.localScope, url, vin, config?.days], enabled: readable, networkMode: 'always',
    queryFn: async () => await readLedger(config!, vin) ?? null,
  });

  const frames = useMemo(() => framesOf(history.data?.entries ?? cachedHistory.data?.entries ?? [], mapping),
    [history.data, cachedHistory.data, mapping]);
  const currentFrames = useMemo(() => framesOf(samplesOf(states.data ?? []).sort((a, b) => a.at - b.at), mapping),
    [states.data, mapping]);
  const current = currentFrames.at(-1);
  const batteryFrame = currentFrames.find(frame => frame.changed.includes('batteryMinTemp'));
  const batteryMinTemp = numberOf(batteryFrame?.data.batteryMinTemp);
  const batteryEntity = entityIdOf(mapping.batteryMinTemp);
  const batteryHeating = states.data?.find(state => state.entity_id === batteryEntity)?.attributes?.battery_heating;
  const batteryTemperature = batteryFrame && batteryMinTemp !== null && !states.isError
    ? { celsius: batteryMinTemp, at: batteryFrame.at, source: 'ha' as const, heating: batteryHeating === true } : null;
  const synced = ledger.data ?? cachedLedger.data ?? emptyRecords;
  const currentReading = states.isError ? undefined : current?.data;
  const statsHistory = recordTab === 'energy' && numberOf(currentReading?.used) === null;
  const from = statsHistory ? 0 : periodStart(recordPeriod);
  const syncTripStart = chargeWindowStart(config?.days ?? 30);
  const syncChargeStart = chargeWindowStart(Math.min(config?.days ?? 30, 30));
  const recentView = viewingRecords && recordPeriod === 'recent';
  const latestOnly = recordTab === 'trips' && recentView;
  const moreTrips = recordsEnabled && (statsHistory || recordTab === 'trips' && (latestOnly
    ? !ledger.isLoading && !synced.trips.length && !ledger.data?.activeTrip
    : from < syncTripStart || synced.trips.length >= 500));
  const historyTrips = useQuery({ queryKey: ['ha', 'trip-list', url, vin, from, latestOnly], enabled: moreTrips,
    queryFn: ({ signal }) => haTripHistory(config!, vin, from, signal, latestOnly), retry: false, staleTime: 120_000 });
  const showCharges = recordsEnabled && recordTab === 'charges';
  const extendCharges = showCharges && from < syncChargeStart && (!recentView || !ledger.isLoading && !synced.charges.length);
  const recentCharges = useQuery({ queryKey: ['ha', 'cost-charges', url, vin], enabled: extendCharges,
    queryFn: ({ signal }) => haChargeSessions(config!, vin, 31, signal), retry: false, staleTime: 120_000 });
  const moreCharges = showCharges && from < chargeWindowStart(31) && (!recentView ||
    extendCharges && !recentCharges.isFetching && !recentCharges.data?.length);
  const olderCharges = useQuery({ queryKey: ['ha', 'record-charge-archive', url, vin, from], enabled: moreCharges,
    queryFn: ({ signal }) => haOlderChargeSessions(config!, vin, signal, from), retry: false, staleTime: 120_000 });
  const saved = useQuery({ queryKey: ['ha', 'saved-records', config?.localScope, url, vin], enabled: readable, networkMode: 'always',
    queryFn: async () => await readSavedLedger(config!, vin) ?? null });
  const reloadSaved = saved.refetch;
  useEffect(() => {
    if (readable) void reloadSaved();
  }, [readable, reloadSaved, enabled, recordTab, ledger.dataUpdatedAt, historyTrips.dataUpdatedAt, recentCharges.dataUpdatedAt, olderCharges.dataUpdatedAt]);
  const records = useMemo(() => {
    if (!readable) return emptyRecords;
    const haveTripWindow = ledger.data?.tripsRead ?? !!cachedLedger.data;
    const haveChargeWindow = ledger.data?.chargesRead ?? !!cachedLedger.data;
    // 正常同步的窗口优先，扩展历史只补窗口以外的数据，防止已移除的记录重新出现。
    const tripBoundary = synced.trips.length >= 500 ? Math.min(...synced.trips.map(row => row.startedAt)) : syncTripStart;
    const earlierTrips = mergeHistory(saved.data?.trips ?? [], moreTrips ? historyTrips.data ?? [] : [])
      .filter(row => !haveTripWindow || row.startedAt < tripBoundary);
    const earlierCharges = mergeHistory(saved.data?.charges ?? [], [
      ...(moreCharges ? olderCharges.data?.charges ?? [] : []), ...(extendCharges ? recentCharges.data ?? [] : []),
    ]).filter(row => !haveChargeWindow || row.startedAt < syncChargeStart);
    const charges = mergeHistory(earlierCharges, synced.charges).map(row =>
      !recordsEnabled && row.active ? { ...row, active: false, partial: true } : row);
    return { trips: mergeHistory(earlierTrips, synced.trips),
      charges: location ? withChargePositions(charges, frames) : charges };
  }, [readable, recordsEnabled, saved.data, synced, ledger.data, cachedLedger.data, syncTripStart, syncChargeStart, moreTrips, extendCharges, moreCharges, historyTrips.data, recentCharges.data, olderCharges.data, location, frames]);
  const rangePartial = moreTrips && historyTrips.isError || extendCharges && recentCharges.isError ||
    moreCharges && (olderCharges.isError || olderCharges.data && olderCharges.data.coverage !== 'complete');
  const rangeLoading = moreTrips && historyTrips.isFetching || extendCharges && recentCharges.isFetching || moreCharges && olderCharges.isFetching;
  const restoringRecords = !ready || active && (
    !vin && (registry.isLoading || archives.isLoading || states.isLoading) ||
    readable && (saved.isLoading || synced === emptyRecords && (ledger.isLoading || cachedLedger.isLoading))
  );
  const trip = recordsEnabled && ledger.data?.tripsRead && !ledger.isError ? ledger.data.activeTrip : null;
  const odometer = numberOf(currentReading?.odometer);
  const startOdometer = trip?.startOdometerKm ?? null;
  const activeTrip = trip && { record: trip, speedKmh: numberOf(currentReading?.speed),
    distanceKm: odometer !== null && startOdometer !== null && odometer >= startOdometer ? odometer - startOdometer : trip.distanceKm };
  const session = recordsEnabled && ledger.data?.chargesRead && !ledger.isError ? ledger.data.charges.find(charge => charge.active) : undefined;
  const activeCharge = session && { id: session.id, soc: session.socEnd, kwh: session.kwh, powerKw: session.powerTimeline?.at(-1)?.value };

  async function connect(url: string, token: Token, auth: HAConfig['auth']) {
    await testConnection(url, token);
    const previous = await secureGet<Token>(HA_KEY);
    const sameAuthorization = config?.url === url && !!previous &&
      (previous.access === token.access || !!previous.refresh && previous.refresh === token.refresh);
    await qc.cancelQueries({ queryKey: ['ha'] });
    invalidateHAWork();
    await secureSet(HA_KEY, token);
    qc.removeQueries({ queryKey: ['ha'] });
    const localScope = sameAuthorization && config?.localScope ? config.localScope : crypto.randomUUID();
    setConfig(config?.url === url ? { ...config, auth, localScope } : { url, mappings: {}, days: 30, auto: true, auth, localScope });
    setHasToken(true);
  }
  async function disconnect() {
    invalidateHAWork();
    await qc.cancelQueries({ queryKey: ['ha'] });
    await secureRemove(HA_KEY);
    setHasToken(false);
    qc.removeQueries({ queryKey: ['ha', 'states'] });
    qc.removeQueries({ queryKey: ['ha', 'entity-registry'] });
    qc.removeQueries({ queryKey: ['ha', 'archive-vehicles'] });
  }
  async function clearHistory() {
    await qc.cancelQueries({ queryKey: ['ha'] });
    if (config) {
      await deleteDataset(historyKey(config, vehicleId));
      const cacheVin = vin || cachedBinding?.vin;
      if (cacheVin) await Promise.all([deleteDatasetsWithPrefix(trackPrefix(config, cacheVin)),
        ...[historyKey(config, vehicleId, cacheVin), ...ledgerKeys(config, cacheVin)].map(deleteDataset)]);
      const linkedId = archiveId || cachedBinding?.archiveId;
      if (linkedId) {
        const pointer = archivePointer(config, linkedId);
        const archiveKey = await readDataset<string>(pointer);
        if (archiveKey) await deleteDataset(archiveKey);
        await deleteDataset(pointer);
      }
    }
    qc.removeQueries({ queryKey: ['ha'], predicate: q => q.queryKey[1] !== 'states' });
  }
  async function refresh() {
    const options = { cancelRefetch: false };
    return Promise.all([
      states.refetch(options), registry.refetch(options), ...(mileage ? [archives.refetch(options)] : []),
      ...(vin && enabled && hasMapping && (mileage || location) ? [history.refetch(options)] : []),
      ...(recordsEnabled ? [ledger.refetch(options), qc.invalidateQueries({ queryKey: ['ha', 'energy', url, vin] })] : []),
      ...(recordsEnabled && archiveId && archivesAvailable ? [archive.refetch(options)] : []),
    ]);
  }
  const fields = visibleFields.map(field => ({ field, available: (field === 'tracker' ? current?.data.position : current?.data[field]) != null }));
  const lastSync = Math.max(history.data?.cursor ?? cachedHistory.data?.cursor ?? 0, archive.dataUpdatedAt, ledger.data?.lastSync ?? cachedLedger.data?.lastSync ?? 0);
  const identifying = registry.isFetching || (mileage && archives.isFetching);
  const recordSyncing = history.isFetching || archive.isFetching || ledger.isFetching;
  const tripUnavailable = ledger.isError || ledger.data?.tripsRead === false;
  const chargeUnavailable = ledger.isError || ledger.data?.chargesRead === false;
  const error = states.error;
  return {
    config, setConfig, ready, connected: active, hasToken, connect, disconnect, clearHistory, refresh, vin, candidates, fields,
    selectVehicle: (vin: string) => setSelectedCars(cars => ({ ...cars, [selectionKey]: vin })),
    frames, records, syncedTripCount: synced.trips.length, syncedChargeCount: synced.charges.length, currentReading, batteryTemperature, batteryEntity,
    rangePartial, rangeLoading, activeTrip, activeCharge, recordSyncing, ledgerSyncing: ledger.isFetching, identifying, tripUnavailable, chargeUnavailable,
    restoringTrips: restoringRecords || moreTrips && historyTrips.isLoading,
    restoringCharges: restoringRecords || extendCharges && recentCharges.isLoading || moreCharges && olderCharges.isLoading,
    registryUnavailable: registry.isError || registry.data?.registryReadable === false,
    archiveUnavailable: archives.isError || archive.isError, historyUnavailable: history.isError,
    lastSync, syncing: states.isFetching || identifying || ledger.isFetching,
    error: error instanceof Error ? error.message : '',
    expired: error instanceof NetworkError && error.status === 401,
  };
}
