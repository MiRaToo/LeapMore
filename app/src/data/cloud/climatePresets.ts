export const climatePresets = [
  ['极速降温', 'snow', { mode: 'cool', temp: 18, fan: 7 }],
  ['极速升温', 'flame', { mode: 'heat', temp: 32, fan: 7 }],
  ['快速除味', 'whirl', { mode: 'vent', temp: 24, fan: 4 }],
  ['风挡除霜', 'wind', { mode: 'def', temp: 24, fan: 7 }],
] as const;

export type PreparationClimate = typeof climatePresets[number][2]['mode'];
export const findClimatePreset = (mode?: PreparationClimate) => climatePresets.find(p => p[2].mode === mode);

export function quickClimatePreset(action: string) {
  return climatePresets.find(([, , settings]) => action === 'climate-' + settings.mode);
}
