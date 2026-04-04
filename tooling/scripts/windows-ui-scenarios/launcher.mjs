import {
  byAutomationId,
  createWindowRectPolicyStep,
  defaultLocatorTimeoutMs,
  defaultStepTimeoutMs,
  waitForLocator,
  windows,
} from './shared.mjs';

export const bundleLauncherReadyLocator = byAutomationId(
  'bundle-launcher.action.check-updates',
);

const bundleLauncherServiceDetailLocator = byAutomationId(
  'bundle-launcher.service.detail',
);
const bundleLauncherDetailTitleLocator = byAutomationId(
  'bundle-launcher.detail.title',
);

export const bundleLauncherReadyTimeoutMs = 35_000;

export async function createBundleLauncherRootSpec({
  window = windows.main,
  policyId = 'main',
  mode = 'wide',
}) {
  return {
    name: 'bundle-launcher-root',
    defaultTimeoutMs: defaultStepTimeoutMs,
    steps: [
      ...waitForLocator(
        window,
        bundleLauncherReadyLocator,
        bundleLauncherReadyTimeoutMs,
      ),
      {
        type: 'waitText',
        window,
        locator: bundleLauncherServiceDetailLocator,
        matcher: {
          minLength: 4,
        },
        timeoutMs: defaultLocatorTimeoutMs,
        saveAs: 'serviceDetail',
      },
      {
        type: 'waitText',
        window,
        locator: bundleLauncherDetailTitleLocator,
        matcher: {
          minLength: 2,
        },
        timeoutMs: defaultLocatorTimeoutMs,
        saveAs: 'selectedBundleTitle',
      },
      await createWindowRectPolicyStep({window, policyId, mode}),
    ],
  };
}
