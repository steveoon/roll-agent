import { createLoopbackQaClient } from "./loopback-qa.ts";
import {
  createRelayClient,
  type RelayThread,
  type RelayOperationResult,
} from "@roll-agent/relay-client";
declare const __ROLL_LOOPBACK_QA__: boolean;

const status = document.querySelector<HTMLParagraphElement>("#status")!;
const results = document.querySelector<HTMLElement>("#results")!;
const threads = document.querySelector<HTMLSelectElement>("#threads")!;
let active: RelayThread | undefined;
let unsubscribe = () => {};
let epoch = 0;
const client = (__ROLL_LOOPBACK_QA__ ? createLoopbackQaClient : createRelayClient)({
  getSession: async ({ signal, supportedRelayProtocolVersions }) => {
    const response = await fetch("/api/roll/session", {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ supportedRelayProtocolVersions }),
      signal,
    });
    if (!response.ok) {
      throw new Error(`Session unavailable (${response.status}). Verify test workspace pairing.`);
    }
    return response.json();
  },
});
client.subscribeConnection((connection) => {
  status.textContent = `Connection: ${connection.status}`;
  if (connection.status !== "connected") {
    epoch += 1;
    results.replaceChildren();
  }
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function renderResult(parent: HTMLElement, response: RelayOperationResult): void {
  const result = response.result;
  if (!result) {
    parent.textContent = "Result no longer available.";
    return;
  }
  const output = result.output;
  if (output.status !== "available") {
    parent.textContent =
      output.status === "rejected"
        ? `Result rejected by content checks: ${output.reason}${output.field ? ` (${output.field})` : ""}`
        : `Result: ${output.status}`;
    return;
  }
  if (
    result.agentName !== "structured-output-demo" ||
    result.toolName !== "list_candidates" ||
    output.schemaId !== "example.candidates" ||
    output.schemaVersion !== 1
  ) {
    const pre = document.createElement("pre");
    pre.textContent = JSON.stringify(output.data, null, 2).slice(0, 20000);
    parent.replaceChildren(pre);
    return;
  }
  if (!Array.isArray(output.data.candidates)) throw new Error("Invalid candidates");
  const candidates = output.data.candidates.map((candidate) => {
    if (
      !isRecord(candidate) ||
      typeof candidate.id !== "string" ||
      typeof candidate.name !== "string" ||
      typeof candidate.score !== "number" ||
      !Number.isFinite(candidate.score) ||
      candidate.score < 0 ||
      candidate.score > 1 ||
      !Array.isArray(candidate.skills) ||
      !candidate.skills.every((skill) => typeof skill === "string")
    ) {
      throw new Error("Invalid candidate");
    }
    return {
      id: candidate.id,
      name: candidate.name,
      score: candidate.score,
      skills: candidate.skills,
    };
  });
  if (new Set(candidates.map((candidate) => candidate.id)).size !== candidates.length) {
    throw new Error("Duplicate candidate identity");
  }
  const sort = document.createElement("button");
  sort.textContent = "Sort by score";
  const table = document.createElement("table");
  const draw = () => {
    table.replaceChildren();
    const head = document.createElement("tr");
    for (const label of ["Candidate", "Score", "Skills"]) {
      const cell = document.createElement("th");
      cell.textContent = label;
      head.append(cell);
    }
    table.append(head);
    for (const candidate of candidates) {
      const row = document.createElement("tr");
      for (const text of [
        candidate.name,
        `${Math.round(candidate.score * 100)}%`,
        candidate.skills.join(" · "),
      ]) {
        const cell = document.createElement("td");
        cell.textContent = text;
        row.append(cell);
      }
      table.append(row);
    }
  };
  sort.onclick = () => {
    candidates.sort((left, right) => right.score - left.score);
    draw();
  };
  draw();
  parent.replaceChildren(sort, table);
}
async function select(thread: RelayThread) {
  unsubscribe();
  active = thread;
  ++epoch;
  results.replaceChildren();
  let previousOperations: unknown;
  const refresh = async () => {
    const snapshot = thread.getSnapshot().snapshot;
    if (!snapshot) return;
    // Text streaming does not change immutable operation results; avoid rereading on each token.
    if (snapshot.operations === previousOperations && results.childElementCount > 0) return;
    previousOperations = snapshot.operations;
    const generation = ++epoch;
    results.replaceChildren();
    await Promise.all(
      snapshot.operations.items.map(async (operation) => {
        if (
          !("appOutput" in operation) ||
          !operation.appOutput ||
          operation.appOutput.status === "not_provided"
        ) {
          return;
        }
        const item = document.createElement("section");
        item.className = "result";
        item.textContent = "Loading result…";
        results.append(item);
        try {
          const result = await thread.getResult(operation.id);
          if (generation !== epoch || active !== thread) return;
          renderResult(item, result);
        } catch {
          if (generation === epoch) {
            item.textContent = "Result unavailable. Check access, protocol support and connection.";
          }
        }
      }),
    );
  };
  unsubscribe = thread.subscribe(() => {
    refresh().catch(() => {
      status.textContent = "Unable to refresh results.";
    });
  });
  await refresh();
}
function action(id: string, run: () => Promise<void>) {
  document.querySelector<HTMLButtonElement>(`#${id}`)!.onclick = () => {
    run().catch((error: unknown) => {
      status.textContent = error instanceof Error ? error.message : "Request failed";
    });
  };
}
action("connect", async () => {
  await client.connect();
  const list = await client.listThreads();
  threads.replaceChildren(
    ...list.items.map((thread) => {
      const option = document.createElement("option");
      option.value = thread.id;
      option.textContent = thread.title ?? thread.id;
      return option;
    }),
  );
});
action("open", async () => {
  const list = await client.listThreads();
  const thread = list.items.find((item) => item.id === threads.value);
  if (thread) await select(await client.openThread(thread.id));
});
action("create", async () => {
  await select(await client.createThread({ title: "Structured output demo" }));
});
action("run", async () => {
  if (!active) throw new Error("Open or create a conversation first.");
  await active.send(
    "Use structured-output-demo list_candidates once to list the synthetic candidates.",
  );
});
