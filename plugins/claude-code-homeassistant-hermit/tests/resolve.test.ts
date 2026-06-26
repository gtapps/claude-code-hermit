// Unit tests for the phrase -> entity_id resolver (src/resolve.ts) plus a couple
// of CLI-level cases for `ha resolve-entity`.

import { afterEach, expect, test } from 'bun:test';

import { AppConfig } from '../src/config';
import { main } from '../src/cli';
import { normalizePhrase, resolveEntity, scoreEntity } from '../src/resolve';
import { captureOutput, cleanupTmp, makeHaRoot, tmpPath } from './helpers';

afterEach(cleanupTmp);

function ent(entity_id: string, friendly_name: string, state = 'off') {
  return { entity_id, state, attributes: { friendly_name } };
}

// A small but representative entity_index: accents, hyphens, an ambiguous
// "sala" cluster, a per-domain "quarto" pair, and a script.
const INDEX: Record<string, Record<string, unknown>> = {
  'light.luz_da_sala': ent('light.luz_da_sala', 'Luz da Sala', 'on'),
  'light.luz_sala_teto': ent('light.luz_sala_teto', 'Luz Sala Teto'),
  'light.luz_sala_tv': ent('light.luz_sala_tv', 'Luz Sala TV'),
  'light.luz_cozinha': ent('light.luz_cozinha', 'Luz Cozinha'),
  'light.luz_salao': ent('light.luz_salao', 'Luz Salão'),
  'light.luz_quarto': ent('light.luz_quarto', 'Luz Quarto'),
  'climate.ar_condicionado_quarto': ent('climate.ar_condicionado_quarto', 'Ar-condicionado Quarto'),
  'cover.estore_sala': ent('cover.estore_sala', 'Estore Sala'),
  'script.bom_dia': ent('script.bom_dia', 'Bom Dia'),
};

test('normalizePhrase: lowercases, strips accents, drops PT stopwords', () => {
  expect(normalizePhrase('a Luz da Saláo')).toEqual(['luz', 'salao']);
  expect(normalizePhrase('Ar-condicionado')).toEqual(['ar', 'condicionado']);
  expect(normalizePhrase('   ')).toEqual([]);
});

test('scoreEntity: exact=3, superset=2, partial=1, none=0', () => {
  expect(scoreEntity(['luz', 'sala'], ['luz', 'sala'])).toBe(3);
  expect(scoreEntity(['luz', 'sala'], ['luz', 'sala', 'teto'])).toBe(2);
  expect(scoreEntity(['luz', 'cozinha'], ['luz', 'sala'])).toBe(1);
  expect(scoreEntity(['quarto'], ['luz', 'sala'])).toBe(0);
});

test('exact match wins over superset siblings', () => {
  // "luz da sala" -> [luz, sala]; luz_da_sala is exact, the *_teto/*_tv are supersets.
  const r = resolveEntity(INDEX, 'luz da sala', { domain: 'light' });
  expect(r).toEqual({ match: 'light.luz_da_sala' });
});

test('accent-insensitive + superset auto-match', () => {
  // "salao" matches "Luz Salão" (accent stripped), unique superset.
  expect(resolveEntity(INDEX, 'salao', { domain: 'light' })).toEqual({ match: 'light.luz_salao' });
});

test('stopword-insensitive match', () => {
  expect(resolveEntity(INDEX, 'a luz da cozinha', { domain: 'light' })).toEqual({
    match: 'light.luz_cozinha',
  });
});

test('ambiguous top tier returns candidates, never a guess', () => {
  const r = resolveEntity(INDEX, 'sala', { domain: 'light' });
  expect('candidates' in r).toBe(true);
  if ('candidates' in r) {
    const ids = r.candidates.map((c) => c.entity_id).sort();
    expect(ids).toEqual(['light.luz_da_sala', 'light.luz_sala_teto', 'light.luz_sala_tv']);
  }
});

test('single partial overlap still returns candidates (never auto-match)', () => {
  // Only luz_cozinha shares a token with the query, but not all -> partial -> candidates.
  const r = resolveEntity(INDEX, 'cozinha inexistente', { domain: 'light' });
  expect('candidates' in r).toBe(true);
  if ('candidates' in r) {
    expect(r.candidates.map((c) => c.entity_id)).toEqual(['light.luz_cozinha']);
  }
});

test('--domain scopes resolution', () => {
  expect(resolveEntity(INDEX, 'quarto', { domain: 'light' })).toEqual({ match: 'light.luz_quarto' });
  expect(resolveEntity(INDEX, 'quarto', { domain: 'climate' })).toEqual({
    match: 'climate.ar_condicionado_quarto',
  });
});

test('scripts excluded unless --include-scripts', () => {
  expect(resolveEntity(INDEX, 'bom dia')).toEqual({ none: true });
  expect(resolveEntity(INDEX, 'bom dia', { includeScripts: true })).toEqual({
    match: 'script.bom_dia',
  });
});

test('no overlap returns none (snapshot present)', () => {
  expect(resolveEntity(INDEX, 'geladeira')).toEqual({ none: true });
});

test('falls back to object_id when friendly_name is absent', () => {
  const idx = { 'fan.varanda': { entity_id: 'fan.varanda', state: 'off' } };
  expect(resolveEntity(idx, 'varanda', { domain: 'fan' })).toEqual({ match: 'fan.varanda' });
});

// --- CLI-level ---

function runResolve(root: string, argv: string[]) {
  const cfg = new AppConfig(root, 'http://ha.local:8123', null, null, 'tok', 5, 0);
  return captureOutput(() =>
    main(argv, {
      loadConfig: () => cfg,
      createClient: async () => {
        throw new Error('resolve-entity must not create an HA client');
      },
    }),
  );
}

test('CLI: resolve-entity matches against the snapshot, no HA client', async () => {
  const root = makeHaRoot({ entity_index: INDEX });
  const { code, out } = await runResolve(root, ['ha', 'resolve-entity', 'luz da sala', '--domain', 'light']);
  expect(code).toBe(0);
  expect(JSON.parse(out)).toEqual({ match: 'light.luz_da_sala' });
});

test('CLI: missing snapshot returns none with no_snapshot reason', async () => {
  const root = tmpPath(); // fresh dir, no snapshot written
  const { code, out } = await runResolve(root, ['ha', 'resolve-entity', 'luz']);
  expect(code).toBe(0);
  expect(JSON.parse(out)).toEqual({ none: true, reason: 'no_snapshot' });
});
