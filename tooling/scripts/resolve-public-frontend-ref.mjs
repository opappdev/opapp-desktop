import {execFile as execFileCallback} from 'node:child_process';
import {readFile} from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, '..', '..');
const execFile = promisify(execFileCallback);

export const defaultPinnedFrontendRefPath = path.join(
  repoRoot,
  'tooling',
  'config',
  'opapp-frontend-ref.txt',
);
export const defaultPublicFrontendRemoteUrl =
  'https://github.com/opappdev/opapp-frontend.git';
export const defaultPublicFrontendBranch = 'main';

export function normalizeFrontendRef(ref) {
  if (typeof ref !== 'string') {
    return null;
  }

  const normalized = ref.trim();
  return normalized ? normalized : null;
}

export function parsePinnedFrontendRefFile(content) {
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) {
      continue;
    }

    return trimmed;
  }

  throw new Error('Pinned frontend ref file did not contain a usable git ref.');
}

export function parseRemoteFrontendRefOutput(content, branch = defaultPublicFrontendBranch) {
  const targetRef = `refs/heads/${branch}`;

  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }

    const [sha, ref] = trimmed.split(/\s+/);
    if (ref === targetRef && /^[0-9a-f]{40}$/i.test(sha)) {
      return sha;
    }
  }

  throw new Error(
    `Could not resolve remote frontend head for branch '${branch}'.`,
  );
}

export async function resolveLatestPublicFrontendRef({
  remoteUrl = defaultPublicFrontendRemoteUrl,
  branch = defaultPublicFrontendBranch,
  execFileImpl = execFile,
} = {}) {
  const {stdout} = await execFileImpl('git', [
    'ls-remote',
    remoteUrl,
    `refs/heads/${branch}`,
  ]);
  return parseRemoteFrontendRefOutput(stdout, branch);
}

export async function resolvePublicFrontendRef({
  env = process.env,
  pinnedRefPath = defaultPinnedFrontendRefPath,
  execFileImpl = execFile,
} = {}) {
  const envOverride = normalizeFrontendRef(env.OPAPP_FRONTEND_REF);
  if (envOverride) {
    return envOverride;
  }

  const defaultStrategy =
    normalizeFrontendRef(env.OPAPP_FRONTEND_REF_DEFAULT)?.toLowerCase() ?? null;
  if (defaultStrategy === 'latest') {
    return resolveLatestPublicFrontendRef({
      remoteUrl:
        normalizeFrontendRef(env.OPAPP_FRONTEND_REMOTE_URL) ??
        defaultPublicFrontendRemoteUrl,
      branch:
        normalizeFrontendRef(env.OPAPP_FRONTEND_BRANCH) ??
        defaultPublicFrontendBranch,
      execFileImpl,
    });
  }

  const fileContent = await readFile(pinnedRefPath, 'utf8');
  return parsePinnedFrontendRefFile(fileContent);
}

async function main() {
  const ref = await resolvePublicFrontendRef();
  process.stdout.write(`${ref}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
