import path from 'node:path';
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, '..', '..', '..');
const workspaceRoot = path.resolve(repoRoot, '..');
const frontendRoot = path.join(workspaceRoot, 'opapp-frontend');
const windowPolicyRegistryPath = path.join(
  frontendRoot,
  'contracts',
  'windowing',
  'src',
  'window-policy-registry.json',
);

export const windows = {
  main: {
    title: 'OpappWindowsHost',
  },
  settings: {
    className: 'OPAPP_SURFACE_WINDOW',
  },
  tool: {
    title: 'Opapp Tool',
  },
};

let windowPolicyRegistryPromise = null;

export const defaultLocatorTimeoutMs = 22_500;
export const defaultStepTimeoutMs = 5_000;
export const defaultChatResponseTimeoutMs = 15_000;
export const defaultCaptureResultTimeoutMs = 10_000;

export function byAutomationId(automationId, extra = {}) {
  return {
    automationId,
    ...extra,
  };
}

export function waitForLocator(
  window,
  locator,
  timeoutMs = defaultLocatorTimeoutMs,
) {
  return [
    {
      type: 'waitWindow',
      window,
      focus: true,
      timeoutMs,
    },
    {
      type: 'waitElement',
      window,
      locator,
      timeoutMs,
    },
  ];
}

export function waitForElementState({
  window,
  locator,
  matcher,
  timeoutMs = defaultLocatorTimeoutMs,
  saveAs = null,
}) {
  return {
    type: 'waitElementState',
    window,
    locator,
    matcher,
    timeoutMs,
    ...(saveAs ? {saveAs} : {}),
  };
}

export function sendKeys({
  window,
  keys,
  timeoutMs = defaultStepTimeoutMs,
  delayMs = 200,
  label = null,
}) {
  return {
    type: 'sendKeys',
    window,
    keys,
    timeoutMs,
    delayMs,
    ...(label ? {label} : {}),
  };
}

async function getWindowGeometry(policyId, mode) {
  if (!windowPolicyRegistryPromise) {
    windowPolicyRegistryPromise = readFile(windowPolicyRegistryPath, 'utf8').then(
      content => JSON.parse(content),
    );
  }

  const registry = await windowPolicyRegistryPromise;
  const geometry = registry?.[policyId]?.geometry?.[mode];
  if (!geometry) {
    throw new Error(
      `Missing window geometry for policy '${policyId}' mode '${mode}'.`,
    );
  }

  return geometry;
}

export async function createWindowRectPolicyStep({
  window,
  policyId,
  mode,
  timeoutMs = defaultLocatorTimeoutMs,
  saveAs = null,
}) {
  const geometry = await getWindowGeometry(policyId, mode);

  return {
    type: 'assertWindowRectPolicy',
    window,
    geometry,
    timeoutMs,
    ...(saveAs ? {saveAs} : {}),
  };
}
