import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useModelContext } from '../context';
import { entityHistory } from '../../data/ha/client';
import { batteryTemperatureSamples, framesOf, mergeTemperatureSamples, type Charge, type Trip } from '../../data/ha/measurements';
import { MS_DAY, samplesOf } from '../../data/ha/schema';

function useOlderTemperatures(start: number | undefined, end: number | null | undefined, includeHA: boolean) {
  const { ha } = useModelContext();
  // Older ledger sessions can outlive the entity-history window stored on this phone.
  return useQuery({
    queryKey: ['ha', 'battery-temperature-history', ha.config?.localScope, ha.config?.url, ha.vin, ha.batteryEntity, start, end],
    enabled: includeHA && !!ha.config && !!ha.batteryEntity && start != null && end != null && start < Date.now() - ha.config.days * MS_DAY,
    staleTime: 24 * 3_600_000, retry: false,
    queryFn: async ({ signal }) => {
      const states = await entityHistory(ha.config!, [ha.batteryEntity], start!, end!, signal);
      const history = framesOf(samplesOf(states), { batteryMinTemp: { entity: ha.batteryEntity, attribute: 'battery_min_temp' } });
      return batteryTemperatureSamples(history, start!, end!);
    },
  });
}

export function useRecordTemperatures(record: Trip | Charge | undefined, active = false) {
  const m = useModelContext();
  const permitted = m.canSee('mileage');
  const includeHA = permitted && !!m.ha.vin && !m.simulated;
  const older = useOlderTemperatures(record?.startedAt, record?.endedAt, includeHA && m.usesHA);
  return useMemo(() => {
    if (!record || !permitted) return [];
    const lastSample = 'speeds' in record
      ? Math.max(record.startedAt + (record.durationMin ?? 0) * 60_000, record.speeds.at(-1)?.at ?? 0, record.route.at(-1)?.at ?? 0)
      : record.powerTimeline?.at(-1)?.at ?? record.powers.at(-1)?.at ?? record.startedAt;
    const start = record.startedAt;
    const end = record.endedAt ?? (active ? Date.now() : Math.max(lastSample, record.batteryTemperatures?.at(-1)?.at ?? 0));
    return mergeTemperatureSamples(start, end, includeHA ? older.data : undefined,
      includeHA ? batteryTemperatureSamples(m.ha.frames, start, end) : undefined,
      !m.simulated ? batteryTemperatureSamples(m.cloudRecords.frames, start, end) : undefined,
      record.batteryTemperatures);
  }, [record, active, permitted, includeHA, older.data, m.ha.frames, m.simulated, m.cloudRecords.frames]);
}
