#!/usr/bin/env node
import { appendFileSync } from "node:fs";
import { createServer } from "node:http";

const PORT = Number(process.env.FAKE_LLM_PORT ?? 0);
const STEPS = Number(process.env.FAKE_LLM_STEPS ?? 10_000);
const REASONING_CHARS = Number(process.env.FAKE_LLM_REASONING_CHARS ?? 8_000);
const DELTA_CHARS = Number(process.env.FAKE_LLM_DELTA_CHARS ?? 10);
const DELTA_INTERVAL_MS = Number(process.env.FAKE_LLM_DELTA_MS ?? 25);
const LINE_MIN = Number(process.env.FAKE_LLM_LINE_MIN ?? 350);
const LINE_MAX = Number(process.env.FAKE_LLM_LINE_MAX ?? 700);
const LOG = process.env.FAKE_LLM_LOG ?? "";
const TOOL_PATTERN = new RegExp(process.env.FAKE_LLM_TOOL_PATTERN ?? "read_file$");
const TOOL_ARGUMENTS = process.env.FAKE_LLM_TOOL_ARGUMENTS ?? JSON.stringify({ path: "probe.txt" });

const VOCAB = [
  ..."当前需要先确认文件内容再决定下一步操作，因为工具返回的结果里包含了路径和行号信息，我应该逐条核对每一个候选方案的前提条件是否成立，并且把已经验证过的结论和仍然需要实测的部分明确区分开来。如果调用方传入的参数与原始契约不一致，那么后续所有推理都会被污染，所以在动手之前先列出两到三条不同方向的可能性，再挑最有希望的一条深入。",
];

function log(line) {
  const text = `${new Date().toISOString()} ${line}\n`;
  if (LOG) {
    appendFileSync(LOG, text);
  } else {
    process.stderr.write(text);
  }
}

let seed = 12345;
function random() {
  seed = (seed * 1103515245 + 12345) & 0x7fffffff;
  return seed / 0x7fffffff;
}

function nextLineLength() {
  return LINE_MIN + Math.floor(random() * (LINE_MAX - LINE_MIN));
}

function buildReasoning(step) {
  let out = `第 ${step} 步推理：`;
  let lineBudget = nextLineLength();
  while (out.length < REASONING_CHARS) {
    out += VOCAB[Math.floor(random() * VOCAB.length)];
    lineBudget -= 1;
    if (lineBudget <= 0) {
      out += "\n";
      lineBudget = nextLineLength();
    }
  }
  return out;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function chunk(id, delta, finishReason = null, usage = undefined) {
  const payload = {
    id,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model: "fake-dashscope",
    choices: [{ index: 0, delta, finish_reason: finishReason }],
    ...(usage ? { usage } : {}),
  };
  return `data: ${JSON.stringify(payload)}\n\n`;
}

function usageFor(step, completionChars) {
  const promptTokens = 2_000 + step * 40;
  const completionTokens = Math.ceil(completionChars / 1.5);
  return {
    prompt_tokens: promptTokens,
    completion_tokens: completionTokens,
    total_tokens: promptTokens + completionTokens,
  };
}

let requestCounter = 0;

async function streamReasoningStep(res, id, step, toolName, isAborted) {
  const reasoning = buildReasoning(step);
  res.write(chunk(id, { role: "assistant", content: "" }));
  for (let offset = 0; offset < reasoning.length; offset += DELTA_CHARS) {
    if (isAborted()) {
      return false;
    }
    res.write(chunk(id, { reasoning_content: reasoning.slice(offset, offset + DELTA_CHARS) }));
    await sleep(DELTA_INTERVAL_MS);
  }
  res.write(
    chunk(id, {
      tool_calls: [
        {
          index: 0,
          id: `call_${step}`,
          type: "function",
          function: { name: toolName, arguments: TOOL_ARGUMENTS },
        },
      ],
    }),
  );
  res.write(chunk(id, {}, "tool_calls", usageFor(step, reasoning.length)));
  return true;
}

async function streamFinalAnswer(res, id, step) {
  const text = "已完成全部步骤。";
  for (const character of text) {
    res.write(chunk(id, { content: character }));
    await sleep(20);
  }
  res.write(chunk(id, {}, "stop", usageFor(step, text.length)));
}

const server = createServer((req, res) => {
  if (req.method !== "POST" || !req.url?.endsWith("/chat/completions")) {
    res.writeHead(404).end();
    return;
  }
  let body = "";
  req.setEncoding("utf8");
  req.on("data", (part) => {
    body += part;
  });
  req.on("end", async () => {
    requestCounter += 1;
    const step = requestCounter;
    let parsed;
    try {
      parsed = JSON.parse(body);
    } catch (error) {
      res.writeHead(400).end();
      log(`req#${step} bad json: ${String(error)}`);
      return;
    }
    const messages = Array.isArray(parsed.messages) ? parsed.messages : [];
    const tools = Array.isArray(parsed.tools) ? parsed.tools : [];
    const tool = tools.find((candidate) => TOOL_PATTERN.test(candidate?.function?.name ?? ""));
    log(
      `req#${step} messages=${messages.length} bodyBytes=${Buffer.byteLength(body)} tools=${tools.length} tool=${tool?.function?.name ?? "-"}`,
    );
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });
    let aborted = false;
    res.on("close", () => {
      if (!res.writableFinished) {
        aborted = true;
      }
    });
    const id = `chatcmpl-${step}`;
    if (step <= STEPS && tool !== undefined) {
      const completed = await streamReasoningStep(res, id, step, tool.function.name, () => aborted);
      if (!completed) {
        log(`req#${step} client aborted mid-reasoning`);
        return;
      }
    } else {
      await streamFinalAnswer(res, id, step);
    }
    res.write("data: [DONE]\n\n");
    res.end();
    log(`req#${step} done`);
  });
});

server.listen(PORT, "127.0.0.1", () => {
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : PORT;
  log(
    `listening on http://127.0.0.1:${port} steps=${STEPS} reasoningChars=${REASONING_CHARS} delta=${DELTA_CHARS}chars/${DELTA_INTERVAL_MS}ms`,
  );
  process.stdout.write(`${port}\n`);
});
