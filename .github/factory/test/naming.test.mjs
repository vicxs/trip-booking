import assert from 'node:assert/strict';
import { test } from 'node:test';
import { agentBranch, archiveNames, classifyBranches, slugify } from '../lib/naming.mjs';

test('slugify keeps ascii words, drops accents and punctuation, caps length on a word boundary', () => {
  assert.equal(slugify('Walking skeleton: Next.js + Fastify + Postgres/Prisma, bilingual UI, CI'), 'walking-skeleton-next-js-fastify');
  assert.equal(slugify('a'.repeat(50)), 'a'.repeat(40));
  assert.equal(slugify('Añadir viajeros a un Viaje'), 'anadir-viajeros-a-un-viaje');
  assert.equal(slugify('!!!'), 'ticket');
});

test('agentBranch is agent/<issue>-<slug>', () => {
  assert.equal(agentBranch(17, 'Edit a Trip'), 'agent/17-edit-a-trip');
});

test('classifyBranches ignores other issues that share a numeric prefix', () => {
  const r = classifyBranches(17, ['agent/17-x', 'agent/170-y', 'agent/17-x-attempt-2', 'agent/1-z']);
  assert.deepEqual(r, { active: ['agent/17-x'], attempts: [2] });
});

test('archiveNames numbers after the highest existing attempt', () => {
  assert.deepEqual(archiveNames(4, ['agent/4-a', 'agent/4-a-attempt-1', 'agent/4-old-attempt-3']), [
    { from: 'agent/4-a', to: 'agent/4-a-attempt-4' },
  ]);
  assert.deepEqual(archiveNames(4, ['agent/4-a']), [{ from: 'agent/4-a', to: 'agent/4-a-attempt-1' }]);
  assert.deepEqual(archiveNames(4, []), []);
});
