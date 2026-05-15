import type {
  BrowserContextManager,
  BrowserInspectablePage,
  BrowserRuntime,
} from "@roll-agent/browser";

export async function resolveNativePageForBrowserTool(input: {
  readonly ctxManager: BrowserContextManager;
  readonly runtime: BrowserRuntime;
  readonly pageId?: string;
}): Promise<BrowserInspectablePage> {
  const pages = await input.runtime.listNativePages();

  if (input.pageId !== undefined) {
    const page = pages.find((candidate) => candidate.targetId === input.pageId);
    if (page === undefined) {
      throw new Error(`Page "${input.pageId}" not found. Run list_pages to inspect pageId values.`);
    }
    return page;
  }

  const selectedPages = pages.filter((page) =>
    input.ctxManager.isNativePageSelected(page.targetId),
  );
  if (selectedPages.length === 1 && selectedPages[0] !== undefined) {
    return selectedPages[0];
  }

  if (pages.length === 1 && pages[0] !== undefined) {
    return pages[0];
  }

  throw new Error(
    "browser_snapshot/click_ref/type_ref need pageId when multiple native pages are open. Run list_pages first.",
  );
}
