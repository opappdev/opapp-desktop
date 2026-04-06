import assert from 'node:assert/strict';
import {mkdtemp, writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  parseRemoteFrontendRefOutput,
  parsePinnedFrontendRefFile,
  resolveLatestPublicFrontendRef,
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

test('parseRemoteFrontendRefOutput reads the requested branch head sha', () => {
  assert.equal(
    parseRemoteFrontendRefOutput(
      [
        '1111111111111111111111111111111111111111\trefs/heads/release',
        '2222222222222222222222222222222222222222\trefs/heads/main',
      ].join('\n'),
      'main',
    ),
    '2222222222222222222222222222222222222222',
  );
});

test('resolveLatestPublicFrontendRef uses git ls-remote output', async () => {
  const calls = [];
  const ref = await resolveLatestPublicFrontendRef({
    remoteUrl: 'https://example.com/opapp-frontend.git',
    branch: 'main',
    execFileImpl: async (...args) => {
      calls.push(args);
      return {
        stdout:
          'abcdefabcdefabcdefabcdefabcdefabcdefabcd\trefs/heads/main\n',
        stderr: '',
      };
    },
  });

  assert.equal(ref, 'abcdefabcdefabcdefabcdefabcdefabcdefabcd');
  assert.deepEqual(calls, [[
    'git',
    [
      'ls-remote',
      'https://example.com/opapp-frontend.git',
      'refs/heads/main',
    ],
  ]]);
});

test('resolvePublicFrontendRef can default to latest remote frontend head', async () => {
  assert.equal(
    await resolvePublicFrontendRef({
      env: {
        OPAPP_FRONTEND_REF_DEFAULT: 'latest',
        OPAPP_FRONTEND_REMOTE_URL: 'https://example.com/opapp-frontend.git',
        OPAPP_FRONTEND_BRANCH: 'main',
      },
      execFileImpl: async () => ({
        stdout:
          '1234512345123451234512345123451234512345\trefs/heads/main\n',
        stderr: '',
      }),
    }),
    '1234512345123451234512345123451234512345',
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
