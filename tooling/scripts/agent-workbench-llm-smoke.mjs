import {createServer} from 'node:http';

const approvalSmokeFixtureRepoRelativePath =
  'tooling/tests/fixtures/agent-workbench-approval-smoke.txt';
const fallbackApprovalSmokeRequest = {
  command: [
    "$requestedCwd = 'opapp-frontend'",
    `$targetPath = '${approvalSmokeFixtureRepoRelativePath}'`,
    '$newline = [Environment]::NewLine',
    "$content = '# Agent Workbench Approval Smoke Fixture' + $newline + ('approvedAt=' + (Get-Date).ToUniversalTime().ToString('o')) + $newline + ('requestedCwd=' + $requestedCwd) + $newline + 'executor=agent-workbench'",
    'Set-Content -LiteralPath $targetPath -Value $content -Encoding utf8',
    "Write-Output ('approval smoke fixture saved to ' + $targetPath)",
    'Get-Content -LiteralPath $targetPath',
    `git diff --no-ext-diff --no-color HEAD -- '${approvalSmokeFixtureRepoRelativePath}'`,
  ].join('; '),
  cwd: 'opapp-frontend',
  shell: 'powershell',
  env: {
    OPAPP_AGENT_WORKBENCH_ARTIFACT_PATH: `opapp-frontend/${approvalSmokeFixtureRepoRelativePath}`,
    OPAPP_AGENT_WORKBENCH_ARTIFACT_KIND: 'diff',
  },
};

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function createSseDataBlock(payload) {
  return `data: ${payload}\n\n`;
}

function splitIntoChunks(value, chunkCount = 3) {
  if (!value) {
    return [''];
  }

  const chunks = [];
  const step = Math.max(1, Math.ceil(value.length / chunkCount));
  for (let index = 0; index < value.length; index += step) {
    chunks.push(value.slice(index, index + step));
  }

  return chunks;
}

function buildChunkPayload({
  chunkId,
  model,
  delta,
  finishReason = null,
}) {
  return JSON.stringify({
    id: chunkId,
    object: 'chat.completion.chunk',
    created: 1775063653,
    model,
    system_fingerprint: `${model}-fingerprint`,
    choices: [
      {
        index: 0,
        delta,
        logprobs: null,
        finish_reason: finishReason,
      },
    ],
  });
}

function extractRunRequest(body) {
  const messages = Array.isArray(body?.messages) ? body.messages : [];
  const lastUserContent = messages
    .filter(message => message?.role === 'user' && typeof message?.content === 'string')
    .map(message => message.content)
    .at(-1);
  if (!lastUserContent) {
    return null;
  }

  const jsonMatch =
    lastUserContent.match(/(\{[\s\S]*"command"[\s\S]*\})\s*$/) ??
    null;
  if (!jsonMatch?.[1]) {
    return fallbackApprovalSmokeRequest;
  }

  try {
    const parsed = JSON.parse(jsonMatch[1]);
    if (!parsed || typeof parsed !== 'object') {
      return null;
    }

    const command =
      typeof parsed.command === 'string' ? parsed.command.trim() : '';
    if (!command) {
      return fallbackApprovalSmokeRequest;
    }

    return {
      command,
      cwd:
        typeof parsed.cwd === 'string' && parsed.cwd.trim()
          ? parsed.cwd.trim()
          : null,
      shell:
        parsed.shell === 'powershell' || parsed.shell === 'cmd'
          ? parsed.shell
          : null,
      env:
        parsed.env && typeof parsed.env === 'object' && !Array.isArray(parsed.env)
          ? Object.fromEntries(
              Object.entries(parsed.env).filter(
                ([key, value]) =>
                  typeof key === 'string' &&
                  key.trim() &&
                  typeof value === 'string',
              ),
            )
          : {},
    };
  } catch {
    return fallbackApprovalSmokeRequest;
  }
}

function buildToolCallStream({model, request}) {
  const callId = 'fixture-shell-command-1';
  const argumentsText = JSON.stringify(request);
  const argumentChunks = splitIntoChunks(argumentsText, 4);
  const payloads = [];

  payloads.push(
    buildChunkPayload({
      chunkId: 'chatcmpl-agent-workbench-tool-1',
      model,
      delta: {
        role: 'assistant',
        tool_calls: [
          {
            index: 0,
            id: callId,
            type: 'function',
            function: {
              name: 'shell_command',
              arguments: argumentChunks[0] ?? '',
            },
          },
        ],
      },
    }),
  );

  for (const chunk of argumentChunks.slice(1)) {
    payloads.push(
      buildChunkPayload({
        chunkId: 'chatcmpl-agent-workbench-tool-1',
        model,
        delta: {
          tool_calls: [
            {
              index: 0,
              function: {
                arguments: chunk,
              },
            },
          ],
        },
      }),
    );
  }

  payloads.push(
    buildChunkPayload({
      chunkId: 'chatcmpl-agent-workbench-tool-1',
      model,
      delta: {},
      finishReason: 'tool_calls',
    }),
  );
  payloads.push('[DONE]');
  return payloads.map(createSseDataBlock);
}

function buildAssistantContinuationText(toolResultText) {
  if (toolResultText.includes('用户手动拒绝')) {
    const reason = toolResultText.split('：').slice(1).join('：').trim();
    return reason
      ? `这次命令没有执行，因为你拒绝了审批：${reason}。`
      : '这次命令没有执行，因为你拒绝了审批。';
  }

  return '命令已经执行完成，终端输出和结果记录都已更新。';
}

function buildAssistantTextStream({model, assistantText}) {
  const contentChunks = splitIntoChunks(assistantText, 3);
  const payloads = contentChunks.map((chunk, index) =>
    buildChunkPayload({
      chunkId: 'chatcmpl-agent-workbench-message-1',
      model,
      delta: index === 0 ? {role: 'assistant', content: chunk} : {content: chunk},
    }),
  );
  payloads.push(
    buildChunkPayload({
      chunkId: 'chatcmpl-agent-workbench-message-1',
      model,
      delta: {},
      finishReason: 'stop',
    }),
  );
  payloads.push('[DONE]');
  return payloads.map(createSseDataBlock);
}

async function readRequestBody(req) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  return Buffer.concat(chunks).toString('utf8');
}

export async function startAgentWorkbenchLlmSmokeServer(options = {}) {
  const model =
    typeof options?.model === 'string' && options.model.trim()
      ? options.model.trim()
      : 'fixture-model';
  const requests = [];
  const server = createServer(async (req, res) => {
    const requestUrl = new URL(req.url ?? '/', 'http://127.0.0.1');
    const normalizedPath = requestUrl.pathname.replace(/\/+$/, '');
    if (!normalizedPath.endsWith('/chat/completions')) {
      res.writeHead(404, {'Content-Type': 'text/plain; charset=utf-8'});
      res.end('Not Found');
      return;
    }

    const rawBody = await readRequestBody(req);
    let body = null;
    try {
      body = rawBody ? JSON.parse(rawBody) : null;
    } catch {
      body = null;
    }

    requests.push({
      body,
      bodyText: rawBody,
      headers: req.headers,
      method: req.method ?? 'GET',
      path: normalizedPath,
    });

    const messages = Array.isArray(body?.messages) ? body.messages : [];
    const toolMessage = [...messages]
      .reverse()
      .find(message => message?.role === 'tool' && typeof message?.content === 'string');
    const toolResultText =
      typeof toolMessage?.content === 'string' ? toolMessage.content : null;
    const runRequest = extractRunRequest(body);

    const chunks = toolResultText
      ? buildAssistantTextStream({
          model,
          assistantText: buildAssistantContinuationText(toolResultText),
        })
      : buildToolCallStream({
          model,
          request: runRequest,
        });

    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store',
      Connection: 'keep-alive',
    });

    for (const chunk of chunks) {
      res.write(chunk);
      await sleep(35);
    }

    res.end();
  });

  await new Promise((resolve, reject) => {
    server.listen(0, '127.0.0.1', () => resolve(undefined));
    server.once('error', reject);
  });

  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error(
      'Agent workbench smoke server did not expose a numeric port.',
    );
  }

  return {
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
    model,
    requests,
    server,
    token: 'fixture-token',
  };
}
