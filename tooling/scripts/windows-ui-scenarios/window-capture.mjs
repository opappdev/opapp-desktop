import {
  byAutomationId,
  createWindowRectPolicyStep,
  defaultCaptureResultTimeoutMs,
  defaultStepTimeoutMs,
  waitForLocator,
  windows,
} from './shared.mjs';

export async function createWindowCaptureLabSpec({
  window = windows.main,
  policyId = 'main',
  mode = 'wide',
}) {
  return {
    name: 'window-capture-lab',
    defaultTimeoutMs: defaultStepTimeoutMs,
    steps: [
      ...waitForLocator(window, byAutomationId('window-capture.action.refresh')),
      await createWindowRectPolicyStep({window, policyId, mode}),
      {
        type: 'click',
        window,
        locator: byAutomationId('window-capture.action.refresh'),
      },
      {
        type: 'waitText',
        window,
        locator: byAutomationId('window-capture.metric.match-count'),
        matcher: {
          regex: '^[1-9]\\d*$',
        },
      },
      {
        type: 'click',
        window,
        locator: byAutomationId('window-capture.action.capture-window'),
      },
      {
        type: 'waitText',
        window,
        locator: byAutomationId('window-capture.result.output-path'),
        matcher: {
          regex: '^[A-Za-z]:\\\\.+',
        },
        timeoutMs: defaultCaptureResultTimeoutMs,
        saveAs: 'captureWindowPath',
      },
      {
        type: 'click',
        window,
        locator: byAutomationId('window-capture.action.capture-client'),
      },
      {
        type: 'waitText',
        window,
        locator: byAutomationId('window-capture.result.output-path'),
        matcher: {
          regex: '^[A-Za-z]:\\\\.+',
        },
        timeoutMs: defaultCaptureResultTimeoutMs,
        saveAs: 'captureClientPath',
      },
    ],
  };
}
