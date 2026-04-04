import {
  byAutomationId,
  createWindowRectPolicyStep,
  defaultCaptureResultTimeoutMs,
  defaultStepTimeoutMs,
  waitForLocator,
  windows,
} from './shared.mjs';

export async function createViewShotLabSpec({
  window = windows.main,
  policyId = 'main',
  mode = 'wide',
  includeTmpfileRelease = false,
}) {
  return {
    name: 'view-shot-lab',
    defaultTimeoutMs: defaultStepTimeoutMs,
    steps: [
      ...waitForLocator(window, byAutomationId('view-shot.action.capture-ref')),
      await createWindowRectPolicyStep({window, policyId, mode}),
      {
        type: 'click',
        window,
        locator: byAutomationId('view-shot.action.capture-ref'),
      },
      {
        type: 'waitText',
        window,
        locator: byAutomationId('view-shot.result.managed-tmpfile'),
        matcher: {
          regex: '^[A-Za-z]:\\\\.+',
        },
        timeoutMs: defaultCaptureResultTimeoutMs,
        saveAs: 'captureRefPath',
      },
      {
        type: 'click',
        window,
        locator: byAutomationId('view-shot.action.capture-data-uri'),
      },
      {
        type: 'waitText',
        window,
        locator: byAutomationId('view-shot.result.latest-result'),
        matcher: {
          regex: '^data:image/png;base64,',
          minLength: 48,
        },
        timeoutMs: defaultCaptureResultTimeoutMs,
        saveAs: 'componentDataUri',
      },
      {
        type: 'click',
        window,
        locator: byAutomationId('view-shot.action.capture-screen'),
      },
      {
        type: 'waitText',
        window,
        locator: byAutomationId('view-shot.result.latest-result'),
        matcher: {
          regex: '^[A-Za-z]:\\\\.+',
        },
        timeoutMs: defaultCaptureResultTimeoutMs,
        saveAs: 'captureScreenPath',
      },
      ...(includeTmpfileRelease
        ? [
            {
              type: 'click',
              window,
              locator: byAutomationId('view-shot.action.release-tmpfile'),
            },
            {
              type: 'waitText',
              window,
              locator: byAutomationId('view-shot.result.managed-tmpfile'),
              matcher: {
                notRegex: '^[A-Za-z]:\\\\.+',
              },
              timeoutMs: defaultCaptureResultTimeoutMs,
            },
          ]
        : []),
    ],
  };
}

export async function createViewShotCaptureRefSpec({
  window = windows.main,
  policyId = 'main',
  mode = 'wide',
}) {
  return {
    name: 'view-shot-capture-ref',
    defaultTimeoutMs: defaultStepTimeoutMs,
    steps: [
      ...waitForLocator(window, byAutomationId('view-shot.action.capture-ref')),
      await createWindowRectPolicyStep({window, policyId, mode}),
      {
        type: 'click',
        window,
        locator: byAutomationId('view-shot.action.capture-ref'),
      },
      {
        type: 'waitText',
        window,
        locator: byAutomationId('view-shot.result.managed-tmpfile'),
        matcher: {
          regex: '^[A-Za-z]:\\\\.+',
        },
        timeoutMs: defaultCaptureResultTimeoutMs,
        saveAs: 'captureRefPath',
      },
    ],
  };
}

export async function createViewShotDataUriAndScreenSpec({
  window = windows.main,
}) {
  return {
    name: 'view-shot-data-uri-and-screen',
    defaultTimeoutMs: defaultStepTimeoutMs,
    steps: [
      ...waitForLocator(window, byAutomationId('view-shot.action.capture-data-uri')),
      {
        type: 'click',
        window,
        locator: byAutomationId('view-shot.action.capture-data-uri'),
      },
      {
        type: 'waitText',
        window,
        locator: byAutomationId('view-shot.result.latest-result'),
        matcher: {
          regex: '^data:image/png;base64,',
          minLength: 48,
        },
        timeoutMs: defaultCaptureResultTimeoutMs,
        saveAs: 'componentDataUri',
      },
      {
        type: 'click',
        window,
        locator: byAutomationId('view-shot.action.capture-screen'),
      },
      {
        type: 'waitText',
        window,
        locator: byAutomationId('view-shot.result.latest-result'),
        matcher: {
          regex: '^[A-Za-z]:\\\\.+',
        },
        timeoutMs: defaultCaptureResultTimeoutMs,
        saveAs: 'captureScreenPath',
      },
    ],
  };
}

export async function createViewShotTmpfileReleaseSpec({
  window = windows.main,
}) {
  return {
    name: 'view-shot-release-tmpfile',
    defaultTimeoutMs: defaultStepTimeoutMs,
    steps: [
      ...waitForLocator(window, byAutomationId('view-shot.action.release-tmpfile')),
      {
        type: 'click',
        window,
        locator: byAutomationId('view-shot.action.release-tmpfile'),
      },
      {
        type: 'waitText',
        window,
        locator: byAutomationId('view-shot.result.managed-tmpfile'),
        matcher: {
          notRegex: '^[A-Za-z]:\\\\.+',
        },
        timeoutMs: defaultCaptureResultTimeoutMs,
      },
    ],
  };
}
