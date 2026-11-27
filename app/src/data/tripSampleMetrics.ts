import type { MetricSample, Trip } from './ha/measurements.ts';

export const tripSampleGap = 180_000;

export function tripSampleMetrics(trip: Trip, samples: MetricSample[]) {
  let highestSpeed: number | null = null, stoppedMs: number | null = null;
  let previous: MetricSample | undefined;
  for (const sample of samples) {
    if (sample.value == null || !Number.isFinite(sample.value) || sample.value < 0) {
      previous = undefined;
      continue;
    }
    highestSpeed = Math.max(highestSpeed ?? 0, sample.value);
    if (previous) {
      const interval = sample.at - previous.at;
      if (interval > 0 && interval <= tripSampleGap) {
        stoppedMs = (stoppedMs ?? 0) + (previous.value === 0 && sample.value === 0 ? interval : 0);
      }
    }
    previous = sample;
  }
  const rangeStart = trip.rangeStartKm != null && trip.rangeStartKm >= 0 ? trip.rangeStartKm : null;
  const rangeEnd = trip.rangeEndKm != null && trip.rangeEndKm >= 0 ? trip.rangeEndKm : null;
  const consumed = rangeStart !== null && rangeEnd !== null ? rangeStart - rangeEnd : 0;
  const achievement = trip.rangeComparable !== false && consumed > 0 && trip.distanceKm !== null && trip.distanceKm >= 0
    ? trip.distanceKm / consumed * 100 : null;
  return { highestSpeed, stoppedMs, rangeStart, rangeEnd, achievement };
}
