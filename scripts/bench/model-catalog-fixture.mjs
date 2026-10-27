import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const fixturePath = new URL(
  "../../benchmarks/chat-pty/model-catalog-fixture.json",
  import.meta.url,
);

export function seedFixtureModelCatalog(
  home,
  fetchedAt = process.env.ROLL_CHAT_BENCH_CATALOG_FETCHED_AT ?? new Date().toISOString(),
) {
  const data = JSON.parse(readFileSync(fixturePath, "utf8"));
  const timestamp = Date.parse(fetchedAt);
  const age = Date.now() - timestamp;
  if (
    !Number.isFinite(timestamp) ||
    age < 0 ||
    age >= 24 * 60 * 60 * 1000 ||
    timestamp <= Date.parse(data.fetchedAt)
  ) {
    throw new Error("catalog fixture is future-dated or expired; start a new benchmark run");
  }
  data.fetchedAt = fetchedAt;
  const path = join(home, ".roll-agent/cache/model-catalog.json");
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(data));
  return { path, data };
}
