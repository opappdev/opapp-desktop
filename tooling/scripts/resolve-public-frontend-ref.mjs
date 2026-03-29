import {readFile} from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import {fileURLToPath} from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, '..', '..');

export const defaultPinnedFrontendRefPath = path.join(
  repoRoot,
  'tooling',
  'config',
  'opapp-frontend-ref.txt',
);

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

export async function resolvePublicFrontendRef({
  env = process.env,
  pinnedRefPath = defaultPinnedFrontendRefPath,
} = {}) {
  const envOverride = normalizeFrontendRef(env.OPAPP_FRONTEND_REF);
  if (envOverride) {
    return envOverride;
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
