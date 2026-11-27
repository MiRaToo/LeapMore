import { Capacitor, registerPlugin } from '@capacitor/core';
import type { PluginListenerHandle } from '@capacitor/core';

export interface RecorderSession {
  startedAt: number; stoppedAt?: number; reason?: string; ticks: number; lastTickAt?: number;
  processExitAt?: number; processExitReason?: number;
  maxGapMs?: number; maxGapEndedAt?: number; delayMs: number; hours: { at: number; ticks: number }[];
}
interface RecorderPlugin {
  getDiagnostics(options: { scope: string }): Promise<{ running: boolean; sessions: RecorderSession[] }>;
  start(options: { delay: number; scope: string }): Promise<void>;
  stop(options?: { reason: 'scope-change' }): Promise<void>;
  setDelay(options: { delay: number }): Promise<void>;
  clear(options: { vehicle: string }): Promise<void>;
  addListener(event: 'poll', callback: (tick: { scope?: string }) => void): Promise<PluginListenerHandle>;
  addListener(event: 'status', callback: (status: { running: boolean; reason: string; scope?: string }) => void): Promise<PluginListenerHandle>;
}
export const recorder = registerPlugin<RecorderPlugin>('LeapRecorder');
export const hasBackgroundRecorder = () => Capacitor.getPlatform() === 'android' && Capacitor.isPluginAvailable('LeapRecorder');
export async function clearLegacyPhoneRecording(vehicle: string) {
  if (Capacitor.isPluginAvailable('LeapRecorder')) await recorder.clear({ vehicle });
}
