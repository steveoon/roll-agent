import { createHash } from "node:crypto";

export const FILE_FRESHNESS = {
  fresh: "fresh",
  stale: "stale",
  unread: "unread",
} as const;

export type FileFreshness = (typeof FILE_FRESHNESS)[keyof typeof FILE_FRESHNESS];

const MAX_TRACKED_FILES = 512;

function contentDigest(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

export class FileStateTracker {
  private readonly digests = new Map<string, string>();

  recordKnownContent(key: string, content: string): void {
    if (this.digests.has(key)) {
      this.digests.delete(key);
    } else if (this.digests.size >= MAX_TRACKED_FILES) {
      const oldest = this.digests.keys().next().value;
      if (oldest !== undefined) {
        this.digests.delete(oldest);
      }
    }
    this.digests.set(key, contentDigest(content));
  }

  checkFreshness(key: string, currentContent: string): FileFreshness {
    const recorded = this.digests.get(key);
    if (recorded === undefined) {
      return FILE_FRESHNESS.unread;
    }
    return recorded === contentDigest(currentContent) ? FILE_FRESHNESS.fresh : FILE_FRESHNESS.stale;
  }
}
