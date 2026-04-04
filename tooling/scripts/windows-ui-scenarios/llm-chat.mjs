import {
  byAutomationId,
  createWindowRectPolicyStep,
  defaultChatResponseTimeoutMs,
  defaultStepTimeoutMs,
  waitForLocator,
  windows,
} from './shared.mjs';

export async function createLlmChatSpec({
  window = windows.main,
  policyId = 'main',
  mode = 'wide',
  baseUrl,
  model,
  token,
  prompt,
  expectedAssistantText = null,
  expectedErrorText = null,
}) {
  if (!baseUrl || !model || !token || !prompt) {
    throw new Error('LLM chat UI spec requires baseUrl, model, token, and prompt.');
  }

  return {
    name: 'llm-chat',
    defaultTimeoutMs: defaultStepTimeoutMs,
    steps: [
      ...waitForLocator(window, byAutomationId('llm-chat.composer.prompt')),
      await createWindowRectPolicyStep({window, policyId, mode}),
      {
        type: 'setValue',
        window,
        locator: byAutomationId('llm-chat.config.base-url'),
        value: baseUrl,
      },
      {
        type: 'setValue',
        window,
        locator: byAutomationId('llm-chat.config.model'),
        value: model,
      },
      {
        type: 'setValue',
        window,
        locator: byAutomationId('llm-chat.config.token'),
        value: token,
      },
      {
        type: 'setValue',
        window,
        locator: byAutomationId('llm-chat.composer.prompt'),
        value: prompt,
      },
      {
        type: 'click',
        window,
        locator: byAutomationId('llm-chat.action.send'),
      },
      expectedAssistantText
        ? {
            type: 'waitText',
            window,
            locator: byAutomationId('llm-chat.message.assistant.content', {
              index: -1,
            }),
            matcher: {
              includes: expectedAssistantText,
            },
            timeoutMs: defaultChatResponseTimeoutMs,
            saveAs: 'assistantText',
          }
        : {
            type: 'waitText',
            window,
            locator: byAutomationId('llm-chat.error.message'),
            matcher: {
              includes: expectedErrorText,
            },
            timeoutMs: defaultChatResponseTimeoutMs,
            saveAs: 'errorText',
          },
    ],
  };
}
