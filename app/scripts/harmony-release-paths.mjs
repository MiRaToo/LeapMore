import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

// Inspect the actual package after assembly. Never print the matched path: it can
// contain a developer's name. This is a gate, not a binary rewriting tool.
export function verifyHarmonyReleasePaths(hapPath) {
  const run = (args, maxBuffer = 64 * 1024 * 1024) => {
    const result = spawnSync('unzip', args, { encoding: null, maxBuffer });
    if (result.error || result.status !== 0) throw new Error('Unable to inspect Harmony release archive');
    return result.stdout;
  };
  const names = run(['-Z1', hapPath]).toString('utf8').split('\n').filter(Boolean);
  if (!names.length || new Set(names).size !== names.length) throw new Error('Invalid Harmony release archive entries');
  const findings = [];
  for (const name of names) {
    if (name.endsWith('/')) continue;
    // An archive entry with glob characters would be interpreted as an unzip pattern.
    if (/[\[\]*?]/.test(name)) throw new Error('Unsupported Harmony archive entry name');
    const data = run(['-p', hapPath, name]);
    const text = data.toString('latin1');
    const matches = [...text.matchAll(/(?:\/Users\/|\/home\/|\/var\/folders\/|[A-Za-z]:\\Users\\)[^\x00\s"'<>]{1,512}/g)];
    if (!matches.length) continue;
    const sections = elfSections(data);
    const locations = new Set(matches.map(match => sections.find(section => match.index >= section.start && match.index < section.end)?.name ?? 'file data'));
    findings.push(`${name}: ${[...locations].sort().join(', ')}`);
  }
  if (findings.length) throw new Error(`Harmony release contains build-machine paths:\n${findings.join('\n')}`);
}

function elfSections(data) {
  if (data.length < 64 || data.readUInt32BE(0) !== 0x7f454c46 || data[4] !== 2 || data[5] !== 1) return [];
  try {
    const offset = Number(data.readBigUInt64LE(40));
    const size = data.readUInt16LE(58), count = data.readUInt16LE(60), stringsIndex = data.readUInt16LE(62);
    if (size < 64 || !count || stringsIndex >= count || offset + size * count > data.length) return [];
    const sections = Array.from({ length: count }, (_, i) => {
      const at = offset + i * size;
      return { type: data.readUInt32LE(at + 4), nameOffset: data.readUInt32LE(at), start: Number(data.readBigUInt64LE(at + 24)), length: Number(data.readBigUInt64LE(at + 32)) };
    });
    const table = sections[stringsIndex];
    if (table.start + table.length > data.length) return [];
    for (const section of sections) {
      const start = table.start + section.nameOffset;
      const end = data.indexOf(0, start);
      section.name = start < table.start + table.length && end >= start && end < table.start + table.length ? data.toString('ascii', start, end) : 'ELF section';
      section.end = section.start + section.length;
    }
    return sections.filter(section => section.type !== 8);
  } catch { return []; }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv.length !== 3) {
    console.error('Usage: node harmony-release-paths.mjs <release.hap>');
    process.exitCode = 2;
  } else {
    try { verifyHarmonyReleasePaths(process.argv[2]); console.log('Harmony release path check passed'); }
    catch (error) { console.error(error.message); process.exitCode = 1; }
  }
}
