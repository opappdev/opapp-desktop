import assert from 'node:assert/strict';
import {mkdtemp, writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  parsePinnedFrontendRefFile,
  resolvePublicFrontendRef,
} from './resolve-public-frontend-ref.mjs';

test('parsePinnedFrontendRefFile skips comments and blank lines', () => {
  assert.equal(
    parsePinnedFrontendRefFile('\n# comment\n  \nabc123\n# trailing comment\n'),
    'abc123',
  );
});

test('resolvePublicFrontendRef prefers OPAPP_FRONTEND_REF override', async () => {
  assert.equal(
    await resolvePublicFrontendRef({
      env: {OPAPP_FRONTEND_REF: 'feature/nightly'},
      pinnedRefPath: 'does-not-matter',
    }),
    'feature/nightly',
  );
});

test('resolvePublicFrontendRef falls back to pinned file', async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'opapp-frontend-ref-'));
  const pinnedRefPath = path.join(tempDir, 'opapp-frontend-ref.txt');
  await writeFile(pinnedRefPath, '# pinned ref\nf364aff\n', 'utf8');

  assert.equal(
    await resolvePublicFrontendRef({
      env: {},
      pinnedRefPath,
    }),
    'f364aff',
  );
});
