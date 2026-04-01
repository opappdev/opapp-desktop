import {createServer} from 'node:http';

const companionChatSmokeAssistantText = 'CHAT_TEST_OK';
const companionChatSmokeScenario = 'llm-chat-native-sse';

function createSseDataBlock(payload) {
  return `data: ${payload}\n\n`;
}

const companionChatSmokePayloads = [
  JSON.stringify({
    id: 'chatcmpl-native-sse-smoke',
    object: 'chat.completion.chunk',
    created: 1775063653,
    model: 'fixture-model',
    system_fingerprint: 'fixture-model',
    choices: [
      {
        index: 0,
        delta: {
          role: 'assistant',
          reasoning_content: 'The',
        },
        logprobs: null,
        finish_reason: null,
      },
    ],
  }),
  JSON.stringify({
    id: 'chatcmpl-native-sse-smoke',
    object: 'chat.completion.chunk',
    created: 1775063653,
    model: 'fixture-model',
    system_fingerprint: 'fixture-model',
    choices: [
      {
        index: 0,
        delta: {
          reasoning_content: ' answer',
        },
        logprobs: null,
        finish_reason: null,
      },
    ],
  }),
  JSON.stringify({
    id: 'chatcmpl-native-sse-smoke',
    object: 'chat.completion.chunk',
    created: 1775063653,
    model: 'fixture-model',
    system_fingerprint: 'fixture-model',
    choices: [
      {
        index: 0,
        delta: {
          content: '\n\n',
        },
        logprobs: null,
        finish_reason: null,
      },
    ],
  }),
  JSON.stringify({
    id: 'chatcmpl-native-sse-smoke',
    object: 'chat.completion.chunk',
    created: 1775063653,
    model: 'fixture-model',
    system_fingerprint: 'fixture-model',
    choices: [
      {
        index: 0,
        delta: {
          content: companionChatSmokeAssistantText,
        },
        logprobs: null,
        finish_reason: null,
      },
    ],
  }),
  JSON.stringify({
    id: 'chatcmpl-native-sse-smoke',
    object: 'chat.completion.chunk',
    created: 1775063653,
    model: 'fixture-model',
    system_fingerprint: 'fixture-model',
    choices: [
      {
        index: 0,
        delta: {},
        logprobs: null,
        finish_reason: 'stop',
      },
    ],
  }),
  '[DONE]',
];

const companionChatSmokeSseStream = companionChatSmokePayloads
  .map(createSseDataBlock)
  .join('');

const companionChatSmokeSseChunks = [
  companionChatSmokeSseStream.slice(0, 197),
  companionChatSmokeSseStream.slice(197, 611),
  companionChatSmokeSseStream.slice(611),
];

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function readRequestBody(req) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  return Buffer.concat(chunks).toString('utf8');
}

export async function startCompanionChatSmokeServer() {
  const requests = [];
  const server = createServer(async (req, res) => {
    const requestUrl = new URL(req.url ?? '/', 'http://127.0.0.1');
    const normalizedPath = requestUrl.pathname.replace(/\/+$/, '');
    if (!normalizedPath.endsWith('/chat/completions')) {
      res.writeHead(404, {'Content-Type': 'text/plain'});
      res.end('Not Found');
      return;
    }

    const bodyText = await readRequestBody(req);
    let body = null;
    try {
      body = bodyText ? JSON.parse(bodyText) : null;
    } catch {
      body = null;
    }

    requests.push({
      bodyText,
      headers: req.headers,
      method: req.method ?? 'GET',
      path: normalizedPath,
      body,
    });

    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store',
      Connection: 'keep-alive',
    });

    for (const chunk of companionChatSmokeSseChunks) {
      res.write(chunk);
      await sleep(40);
    }

    res.end();
  });

  await new Promise((resolve, reject) => {
    server.listen(0, '127.0.0.1', () => {
      resolve(undefined);
    });
    server.once('error', reject);
  });

  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Companion chat smoke server did not expose a numeric port.');
  }

  return {
    assistantText: companionChatSmokeAssistantText,
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: async () => {
      await new Promise((resolve, reject) => {
        server.close(error => {
          if (error) {
            reject(error);
            return;
          }
          resolve(undefined);
        });
      });
    },
    requests,
    scenario: companionChatSmokeScenario,
    server,
  };
}
