import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { verifyHarmonyReleasePaths } from '../scripts/harmony-release-paths.mjs';

test('release gate accepts clean archives and rejects paths without exposing them', () => {
  const dir = mkdtempSync(join(tmpdir(), 'harmony-gate-'));
  try {
    writeFileSync(join(dir, 'clean.txt'), 'fixture');
    assert.equal(spawnSync('zip', ['-q', 'clean.hap', 'clean.txt'], { cwd: dir }).status, 0);
    assert.doesNotThrow(() => verifyHarmonyReleasePaths(join(dir, 'clean.hap')));
    const privatePath = '/Users/example-user/private-project';
    writeFileSync(join(dir, 'leak.txt'), privatePath);
    assert.equal(spawnSync('zip', ['-q', 'leak.hap', 'leak.txt'], { cwd: dir }).status, 0);
    assert.throws(() => verifyHarmonyReleasePaths(join(dir, 'leak.hap')), (error: Error) =>
      error.message.includes('leak.txt') && !error.message.includes(privatePath));
    const compilerFlags = '-ffile-prefix-map=/private/var/folders/xx/example/T/build=.';
    writeFileSync(join(dir, 'flags.txt'), compilerFlags);
    assert.equal(spawnSync('zip', ['-q', 'flags.hap', 'flags.txt'], { cwd: dir }).status, 0);
    assert.throws(() => verifyHarmonyReleasePaths(join(dir, 'flags.hap')), (error: Error) =>
      error.message.includes('flags.txt') && !error.message.includes('/var/folders/'));
    assert.throws(() => verifyHarmonyReleasePaths(join(dir, 'missing.hap')));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('CLI reports status and rejects a leaking archive without printing its value', () => {
  const dir = mkdtempSync(join(tmpdir(), 'harmony-cli-'));
  try {
    const privatePath = '/home/example-user/private-project';
    writeFileSync(join(dir, 'leak.txt'), privatePath);
    assert.equal(spawnSync('zip', ['-q', 'leak.hap', 'leak.txt'], { cwd: dir }).status, 0);
    const cli = new URL('../scripts/harmony-release-paths.mjs', import.meta.url).pathname;
    const result = spawnSync(process.execPath, [cli, join(dir, 'leak.hap')], { encoding: 'utf8' });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /leak\.txt/);
    assert.ok(!result.stderr.includes(privatePath));
    assert.equal(spawnSync(process.execPath, [cli]).status, 2);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('OpenSSL builder rejects untrusted tarball before creating output', () => {
  const dir = mkdtempSync(join(tmpdir(), 'harmony-builder-'));
  try {
    const archive = join(dir, 'source.tar.gz');
    writeFileSync(archive, 'invalid');
    const script = new URL('../scripts/build-harmony-openssl.sh', import.meta.url).pathname;
    const result = spawnSync(script, [archive, join(dir, 'output')], { encoding: 'utf8' });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /SHA-256 mismatch/);
    assert.throws(() => verifyHarmonyReleasePaths(join(dir, 'output')));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
