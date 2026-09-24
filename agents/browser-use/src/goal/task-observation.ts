import { z } from "zod";
import { ReadDocumentSchema } from "./task-progress.ts";
import type { ReadDocument } from "./task-progress.ts";
import type { NativeCdpController } from "@roll-agent/browser";
import { GoalPageStateSchema } from "./observation.ts";
import type { GoalSnapshot } from "./observation.ts";

const TextSchema = z.object({
  text: z.string().max(6000),
  truncated: z.boolean(),
  pageState: GoalPageStateSchema.optional(),
  readDocument: ReadDocumentSchema.omit({ frameId: true, observedAt: true }).optional(),
});
export const READ_GOAL_TEXT = `function(origins, limit, captureEvidence) {
  const doc=this.ownerDocument || this, view=doc && doc.defaultView;
  if(!view || !origins.includes(view.location.origin)) return {text:'',truncated:true};
  if(!doc.body)return {text:'',truncated:false};
  const visible=el=>el.checkVisibility({checkOpacity:true,checkVisibilityCSS:true}) && [...el.getClientRects()].some(r=>r.width>0 && r.height>0 && r.bottom>0 && r.top<view.innerHeight && r.right>0 && r.left<view.innerWidth);
  const text=el=>(el?.innerText || el?.textContent || '').replace(/\\s+/g,' ').trim();
  const panels=[...doc.querySelectorAll('dialog[open],[role="dialog"],[aria-modal="true"],[class*="dialog"],[class*="modal"],[class*="popup"]')].filter(el=>{
    if(!visible(el))return false;
    const style=view.getComputedStyle(el);
    return el.matches('dialog[open],[role="dialog"],[aria-modal="true"]') || ['fixed','absolute'].includes(style.position) && /(?:^|[\\s_-])(dialog|modal|popup)(?:[\\s_-]|$)/i.test(String(el.className));
  });
  const pageState={
    panels:panels.filter(el=>!panels.some(parent=>parent!==el && parent.contains(el))).slice(0,16).map(el=>(el.getAttribute('aria-label') || text(el.querySelector('h1,h2,h3,h4,[role="heading"],[class*="title"]')) || text(el) || 'Unlabelled visible panel').slice(0,400)),
    selectedTabs:[...doc.querySelectorAll('[role="tab"][aria-selected="true"],[class*="tab"].active,[class*="tab"].selected,[class*="tab"][aria-current="page"]')].filter(visible).slice(0,32).map(el=>text(el).slice(0,200)),
    busy:[...doc.querySelectorAll('[aria-busy="true"],[role="progressbar"]')].some(visible)
  };
  const pathOf=el=>{const parts=[];for(let p=el;p&&p!==doc.body;p=p.parentElement){let n=1;for(let q=p.previousElementSibling;q;q=q.previousElementSibling)if(q.tagName===p.tagName)n++;parts.unshift(p.tagName.toLowerCase()+':'+n)}return parts.join('/')};
  const outerPanels=panels.filter(el=>!panels.some(parent=>parent!==el&&parent.contains(el)));
  const contentRegions=!captureEvidence ? [] : outerPanels.length ? outerPanels : [...doc.querySelectorAll('main,article,[role="main"]')].filter(visible).filter(el=>!el.parentElement?.closest('main,article,[role="main"]'));
  const readDocument=captureEvidence ? {url:doc.location.href,panelsComplete:outerPanels.length<=4,
    regions:contentRegions.slice(0,4).map(el=>{const raw=el.innerText||'';return {id:pathOf(el),name:(el.getAttribute('aria-label')||text(el.querySelector('h1,h2,h3,h4,[role="heading"],[class*="title"]'))||'Unlabelled content region').slice(0,400),kind:outerPanels.includes(el)?'panel':'content',text:raw.slice(0,16000),truncated:raw.length>16000}})} : undefined;
  const walker=doc.createTreeWalker(doc.body,4), range=doc.createRange(), parts=[];
  let node, length=0, visited=0;
  while((node=walker.nextNode()) && visited++<5000){
    const parent=node.parentElement, text=(node.textContent||'').replace(/\\s+/g,' ').trim();
    if(!text || !parent || parent.closest('script,style,noscript,template,[aria-hidden="true"]'))continue;
    if(!parent.checkVisibility({checkOpacity:true,checkVisibilityCSS:true}))continue;
    range.selectNodeContents(node);const r=range.getBoundingClientRect();
    if(!r.width || !r.height || r.bottom<=0 || r.top>=view.innerHeight || r.right<=0 || r.left>=view.innerWidth)continue;
    parts.push(text.slice(0,Math.max(0,limit-length)));length+=text.length+1;
    if(length>=limit)return {text:parts.join('\\n').slice(0,limit),truncated:true,pageState,...(readDocument?{readDocument}:{})};
  }
  return {text:parts.join('\\n').slice(0,limit),truncated:visited>=5000,pageState,...(readDocument?{readDocument}:{})};
}`;

/** Text has its own budget; static layout must never consume the control budget. */
export async function attachTaskText(
  controller: Pick<
    NativeCdpController,
    "resolveBackendNode" | "callFunctionOnObject" | "releaseObject"
  >,
  snapshot: GoalSnapshot,
  origins: readonly string[],
  signal: AbortSignal,
  captureEvidence = false,
): Promise<GoalSnapshot> {
  const frames = new Map<string, number>();
  for (const ref of snapshot.refs) {
    if (ref.backendNodeId !== undefined && !frames.has(ref.frameId ?? "root")) {
      frames.set(ref.frameId ?? "root", ref.backendNodeId);
    }
  }
  const texts: string[] = [];
  const readDocuments: ReadDocument[] = [];
  const states: z.infer<typeof GoalPageStateSchema>[] = [];
  let remaining = 6000;
  let truncated = false;
  let unavailable = false;
  for (const [frameId, backendNodeId] of frames) {
    signal.throwIfAborted();
    if (remaining <= 0) {
      truncated = true;
      break;
    }
    let objectId: string | undefined;
    try {
      objectId = await controller.resolveBackendNode({ backendNodeId });
      const observedAt = new Date().toISOString();
      const result = TextSchema.parse(
        await controller.callFunctionOnObject({
          objectId,
          functionDeclaration: READ_GOAL_TEXT,
          args: [origins, remaining, captureEvidence],
        }),
      );
      texts.push(result.text);
      if (result.readDocument) {
        readDocuments.push(
          ReadDocumentSchema.parse({ ...result.readDocument, frameId, observedAt }),
        );
      }
      if (result.pageState) states.push(result.pageState);
      remaining -= result.text.length + 1;
      truncated ||= result.truncated;
    } catch {
      unavailable = true;
    } finally {
      if (objectId) await controller.releaseObject(objectId).catch(() => {});
    }
  }
  signal.throwIfAborted();
  return {
    ...snapshot,
    ...(captureEvidence ? { readDocuments } : {}),
    ...(states.length
      ? {
          pageState: {
            panels: [...new Set(states.flatMap((state) => state.panels))].slice(0, 16),
            selectedTabs: [...new Set(states.flatMap((state) => state.selectedTabs))].slice(0, 32),
            busy: states.some((state) => state.busy),
          },
        }
      : {}),
    pageText: texts.join("\n").slice(0, 6000),
    pageTextTruncated: truncated || unavailable,
    ...(unavailable
      ? { coverageWarnings: [...(snapshot.coverageWarnings ?? []), "page_text_unavailable"] }
      : {}),
  };
}
