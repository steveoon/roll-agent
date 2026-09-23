import { z } from "zod";
import type { ReadDocument } from "./task-progress.ts";
import { BrowserElementRefSchema } from "@roll-agent/browser";
import type { BrowserAxSnapshot, NativeCdpController } from "@roll-agent/browser";
import { INSPECT_PICKER, PickerEvidenceSchema } from "./picker-observation.ts";
import { INSPECT_REACHABILITY } from "./reachability.ts";

export const GoalRequiredSourceSchema = z.enum([
  "html",
  "aria",
  "label-required",
  "label-optional",
]);

export const GoalControlConstraintsSchema = z
  .object({
    min: z.string().optional(),
    max: z.string().optional(),
    step: z.string().optional(),
    minlength: z.string().optional(),
    maxlength: z.string().optional(),
    pattern: z.string().optional(),
    multiple: z.boolean().optional(),
  })
  .strict();

export const GoalControlSchema = z.object({
  availability: z.enum(["ready", "offscreen", "covered", "hidden", "unavailable"]),
  editable: z.boolean().default(false),
  /** Fresh applied DOM readback can remain readable while pointer input is covered. */
  readable: z.boolean().optional(),
  domSemantics: z
    .object({ tag: z.string(), role: z.string(), disabled: z.boolean(), readOnly: z.boolean() })
    .optional(),
  expanded: z.boolean().optional(),
  picker: PickerEvidenceSchema.optional(),
  htmlId: z.string().optional(),
  controlsIds: z.array(z.string()).optional(),
  ancestorIds: z.array(z.string()).optional(),
  ownerPaths: z.array(z.string()).optional(),
  ancestorPaths: z.array(z.string()).optional(),
  position: z.object({ top: z.number().finite(), left: z.number().finite() }).optional(),
  /** Nearest-first scrollable ancestor paths, including same-origin parent frames. */
  scrollContainerPaths: z.array(z.string()).optional(),
  /** An edge overlay requires explicit scroll; native visibility reveal alone is insufficient. */
  revealViaScroll: z.boolean().optional(),
  labelledByIds: z.array(z.string()).optional(),
  fieldLabel: z.string().optional(),
  peerGroup: z
    .object({ key: z.string(), position: z.number().int(), count: z.number().int() })
    .optional(),
  validationErrors: z.array(z.string()).optional(),
  required: z.boolean().optional(),
  requiredSource: GoalRequiredSourceSchema.optional(),
  constraints: GoalControlConstraintsSchema.optional(),
  inputType: z.string().optional(),
  observedValue: z.string().optional(),
  actionValue: z.string().optional(),
  displayText: z.string().optional(),
  observedName: z.string().optional(),
  context: z.array(z.string()).default([]),
  layer: z.string().optional(),
  layerKey: z.string().optional(),
  modal: z.boolean().optional(),
  checked: z.union([z.boolean(), z.literal("mixed")]).optional(),
  nativeSelect: z.boolean().optional(),
  options: z
    .array(
      z.object({
        label: z.string(),
        value: z.string(),
        selected: z.boolean(),
        disabled: z.boolean(),
      }),
    )
    .optional(),
  optionsTruncated: z.boolean().optional(),
});
export type GoalControl = z.infer<typeof GoalControlSchema>;
export const GoalDependencyControlSchema = z.object({
  ref: BrowserElementRefSchema,
  control: GoalControlSchema,
});
export type GoalDependencyControl = z.infer<typeof GoalDependencyControlSchema>;
export const GoalPageStateSchema = z.object({
  panels: z.array(z.string().max(400)).max(16),
  selectedTabs: z.array(z.string().max(200)).max(32),
  busy: z.boolean(),
});

export type GoalSnapshot = BrowserAxSnapshot & {
  readDocuments?: ReadDocument[];
  pageState?: z.infer<typeof GoalPageStateSchema>;
  /** Fresh read-only evidence for modal-hidden dependencies; never actionable refs. */
  dependencyControls?: Record<string, GoalDependencyControl>;
  controls?: Record<string, GoalControl>;
  pageText?: string;
  pageTextTruncated?: boolean;
};

// Fixed host-owned read only code. No caller/model JavaScript or site selectors.
export const INSPECT_GOAL_CONTROL = `function(origins) {
  const el=this, doc=el.ownerDocument, view=doc && doc.defaultView;
  if (!doc || !view || !origins.includes(view.location.origin)) return {availability:'unavailable'};
  if (el.nodeType!==1 || !el.isConnected) return {availability:'unavailable'};
  const r=el.getBoundingClientRect(), style=view.getComputedStyle(el);
  if (!r.width || !r.height || style.display==='none' || style.visibility!=='visible' || style.opacity==='0' || el.closest('[inert]')) return {availability:'hidden'};
  const {availability,revealViaScroll}=(${INSPECT_REACHABILITY})(el,origins);
  if(availability==='unavailable')return {availability};
  let frameView=view,projectedTop=r.top,projectedLeft=r.left;
  for(let depth=0;frameView!==frameView.top;depth++){
    if(depth>=32)return {availability:'unavailable'};
    const owner=frameView.frameElement,parent=owner && owner.ownerDocument.defaultView;
    if(!owner || !parent || !origins.includes(parent.location.origin))return {availability:'unavailable'};
    const box=owner.getBoundingClientRect();
    projectedLeft+=box.left+owner.clientLeft;projectedTop+=box.top+owner.clientTop;frameView=parent;
  }
  const position={top:projectedTop+frameView.scrollY,left:projectedLeft+frameView.scrollX};
  const documentPath=node=>{
    const parts=[];
    for(let p=node,depth=0;p && p.nodeType===1; p=p.parentElement,depth++){
      if(depth>=64)return undefined;
      let ordinal=1;for(let sibling=p.previousElementSibling;sibling;sibling=sibling.previousElementSibling)if(sibling.tagName===p.tagName)ordinal++;
      parts.unshift(p.tagName.toLowerCase()+'['+ordinal+']');
    }
    return '/'+parts.join('/');
  };
  const framePaths=[];let pathView=view,pathComplete=true;
  for(let depth=0;pathView!==pathView.top;depth++){
    if(depth>=32){pathComplete=false;break;}
    const owner=pathView.frameElement, parent=owner && owner.ownerDocument.defaultView;
    if(!owner || !parent || !origins.includes(parent.location.origin)){pathComplete=false;break;}
    const path=documentPath(owner);if(!path){pathComplete=false;break;}
    framePaths.unshift(path);pathView=parent;
  }
  const pathFor=node=>{const path=documentPath(node);return pathComplete && path ? [...framePaths,path].join('!') : undefined;};
  const scrollContainerPaths=[];
  const scrollPath=node=>{
    const own=documentPath(node);if(!own)return undefined;
    const paths=[own];let v=node.ownerDocument.defaultView;
    for(let depth=0;v && v!==v.top;depth++){
      if(depth>=32)return undefined;
      const owner=v.frameElement,parent=owner && owner.ownerDocument.defaultView;
      if(!owner || !parent || !origins.includes(parent.location.origin))return undefined;
      const path=documentPath(owner);if(!path)return undefined;
      paths.unshift(path);v=parent;
    }
    return paths.join('!');
  };
  let scrollNode=el,scrollView=view;
  for(let depth=0;depth<32;depth++){
    const root=scrollNode.ownerDocument.scrollingElement;let fixed=false;
    for(let p=scrollNode;p;p=p.parentElement){
      const s=scrollView.getComputedStyle(p);
      if(s.position==='fixed')fixed=true;
      const rootNode=p===root,body=scrollNode.ownerDocument.body,bs=body && scrollView.getComputedStyle(body);
      const axis=(overflow,size,client)=>p[size]>p[client]+1 && (rootNode?!fixed && ![s[overflow],bs?.[overflow]].some(v=>v==='hidden'||v==='clip'):/^(auto|scroll)$/.test(s[overflow]));
      if(axis('overflowX','scrollWidth','clientWidth') || axis('overflowY','scrollHeight','clientHeight')){
        const path=scrollPath(p);if(path && !scrollContainerPaths.includes(path))scrollContainerPaths.push(path);
      }
    }
    if(scrollView===scrollView.top)break;
    const owner=scrollView.frameElement,parent=owner && owner.ownerDocument.defaultView;
    if(!owner || !parent || !origins.includes(parent.location.origin))break;
    scrollNode=owner;scrollView=parent;
  }
  const fixedLayer=node=>{for(let p=node;p && p!==doc.body;p=p.parentElement){if(p.matches('dialog[open],[role="dialog"],[aria-modal="true"]'))return p;const s=view.getComputedStyle(p);if(s.position==='fixed' && Number(s.zIndex)>0)return p;}return null;};
  const ownLayer=fixedLayer(el);
  const nativeFieldSelector='input:not([type="hidden"]):not([type="button"]):not([type="submit"]):not([type="reset"]),textarea,select,[role="textbox"],[role="combobox"],[role="spinbutton"]';
  const fieldCandidateSelector=nativeFieldSelector+',[tabindex],[aria-haspopup],button,[role="button"]';
  const isField=node=>{
    if(node.matches(nativeFieldSelector))return true;
    if(node.tabIndex<0)return false;
    const popup=node.getAttribute('aria-haspopup');
    const controlled=(node.getAttribute('aria-controls')||'').trim().split(/\\s+/).filter(Boolean).map(id=>doc.getElementById(id));
    const picker=Boolean(popup && popup!=='false') || controlled.some(panel=>panel && panel.matches('[role="listbox"],[role="tree"],[role="grid"]'));
    return picker || Boolean(node.querySelector('input[type="hidden"]'));
  };
  const fieldsWithin=node=>[...node.querySelectorAll(fieldCandidateSelector)].filter(isField);
  const ids=attribute=>(el.getAttribute(attribute)||'').trim().split(/\\s+/).filter(Boolean);
  const relatedText=[...ids('aria-describedby'),...ids('aria-errormessage'),...ids('aria-labelledby')].map(id=>doc.getElementById(id)).filter(Boolean);
  // Live page summaries are global evidence, not every nearby field's constraint.
  // Explicit accessibility relationships keep field-specific hints and errors local.
  const liveSelector='[role="status"],[role="alert"],[role="timer"],[role="log"],[aria-live]:not([aria-live="off"]),output';
  const unrelatedLive=node=>{
    if(relatedText.some(related=>related===node || related.contains(node)))return false;
    return Boolean(node.closest(liveSelector));
  };
  const contextText=node=>{
    if(!node.matches(liveSelector) && !node.closest(liveSelector) && !node.querySelector(liveSelector))return node.innerText || '';
    const parts=[],walker=doc.createTreeWalker(node,4);let text;
    while((text=walker.nextNode())){
      const parent=text.parentElement;
      if(!parent || unrelatedLive(parent) || parent.closest('script,style') || !parent.getClientRects().length)continue;
      const style=view.getComputedStyle(parent);
      if(style.display!=='none' && style.visibility==='visible')parts.push(text.textContent||'');
    }
    return parts.join(' ');
  };
  let peerGroup;
  const context=[], ownerPaths=[], localParents=[], sharedLabels=[], own=(el.innerText || '').trim();
  const addContext=text=>{text=text.replace(/\\s+/g,' ').trim();if(context.length<2 && text && text!==own && text.length<=400 && !context.includes(text))context.push(text);};
  const sharedContext=boundary=>{
    let branch=el;
    while(branch.parentElement && branch.parentElement!==boundary)branch=branch.parentElement;
    for(let parent=boundary,depth=0;parent && parent!==doc.body && depth<3;branch=parent,parent=parent.parentElement,depth++){
      for(const child of parent.children){
        if(child===branch || child.contains(el) || isField(child) || fieldsWithin(child).length)continue;
        if(child.matches('button,a,[role="button"],[role="option"],[role="listbox"],[role="menu"],[role="menuitem"]') || child.querySelector('button,a,[role="button"],[role="option"],[role="listbox"],[role="menuitem"]'))continue;
        const style=view.getComputedStyle(child);
        if(!child.getClientRects().length || style.display==='none' || style.visibility!=='visible' || style.cursor==='pointer')continue;
        const text=contextText(child).replace(/\\s+/g,' ').trim();
        if(!text || text.length>240)continue;
        addContext(text);
        if(!unrelatedLive(child))sharedLabels.push(child);
      }
    }
  };
  for(let p=el.parentElement, depth=0;p && p!==doc.body && depth<7;p=p.parentElement,depth++){
    const independent=fieldsWithin(p).some(other=>{
      if(other===el || el.contains(other) || other.contains(el))return false;
      if(['radio','checkbox'].includes(el.type) && el.name && other.type===el.type && other.name===el.name)return false;
      return true;
    });
    if(independent){
      const fields=fieldsWithin(p), roots=fields.filter(f=>!fields.some(other=>other!==f && other.contains(f)));
      const peers=roots.filter(f=>f.getClientRects().length).sort((a,b)=>{const ar=a.getBoundingClientRect(),br=b.getBoundingClientRect();return Math.abs(ar.top-br.top)>8?ar.top-br.top:ar.left-br.left;});
      const position=peers.findIndex(f=>f===el || f.contains(el));
      const key=pathFor(p);
      if(key && position>=0 && peers.length<=8)peerGroup={key,position:position+1,count:peers.length};
      sharedContext(p);break;
    }
    localParents.push(p);
    const path=pathFor(p);if(path)ownerPaths.push(path);
    addContext(contextText(p));
  }
  for(const related of relatedText){
    const text=(related.textContent||'').replace(/\\s+/g,' ').trim();
    if(text && text.length<=400 && !context.includes(text))context.push(text);
  }
  const layer=ownLayer && ((ownLayer.querySelector('h1,h2,h3,h4,[role=heading]')?.textContent || ownLayer.innerText || '').replace(/\\s+/g,' ').trim().slice(0,240));
  const tag=el.tagName.toLowerCase(), type=(el.getAttribute('type') || '').toLowerCase();
  const editable=(tag==='textarea' || (tag==='input' && !['password','button','submit','reset','checkbox','radio','file','hidden','image'].includes(type)) || el.isContentEditable) && !el.readOnly && !el.matches(':disabled');
  const modal=Boolean(ownLayer && (ownLayer.matches('dialog,[role="dialog"],[aria-modal="true"]') || /dialog|modal|popup/i.test(String(ownLayer.className))));
  const layerKey=ownLayer ? [ownLayer.tagName,ownLayer.id,String(ownLayer.className)].join('|') : undefined;
  const checkables=el.matches('input[type="checkbox"],input[type="radio"],[role="checkbox"],[role="radio"]') ? [el] : [...el.querySelectorAll('input[type="checkbox"],input[type="radio"],[role="checkbox"],[role="radio"]')];
  const customToggle=/check[-_]?box|radio[-_]?box|checkmark/i.test(String(el.className)) && !(el.innerText||'').trim();
  const checkbox=checkables.length===1?checkables[0]:undefined;
  const checked=checkbox ? (checkbox.getAttribute('aria-checked')==='mixed'?'mixed':Boolean(checkbox.checked || checkbox.getAttribute('aria-checked')==='true')) : customToggle ? /(^|[\\s_-])(checked|selected|on)([\\s_-]|$)/i.test(String(el.className)) : undefined;
  const nativeSelect=tag==='select';
  const constraints={};
  if(['input','textarea','select'].includes(tag)){
    for(const attribute of ['min','max','step','minlength','maxlength','pattern'])if(el.hasAttribute(attribute))constraints[attribute]=el.getAttribute(attribute);
    if(el.hasAttribute('multiple') && typeof el.multiple==='boolean')constraints.multiple=el.multiple;
  }
  const options=nativeSelect?[...el.options].slice(0,100).map(o=>({label:o.label,value:o.value,selected:o.selected,disabled:Boolean(o.disabled||o.closest('optgroup[disabled]'))})):undefined;
  const labelledByIds=ids('aria-labelledby');
  const fieldLabel=(el.getAttribute('aria-label') || [...(el.labels||[])].map(label=>label.textContent||'').join(' ') || labelledByIds.map(id=>doc.getElementById(id)?.textContent||'').join(' ')).trim();
  const labelText=label=>{
    const parts=[],walker=doc.createTreeWalker(label,4);let node;
    while((node=walker.nextNode()))if(node.parentElement && !unrelatedLive(node.parentElement) && !node.parentElement.closest('input,textarea,select,button,script,style'))parts.push(node.textContent||'');
    return parts.join(' ');
  };
  const nativeLabels=[...(el.labels||[])], namedLabels=labelledByIds.map(id=>doc.getElementById(id)).filter(Boolean);
  const labelNodes=[...nativeLabels,...namedLabels,...sharedLabels];
  for(const parent of localParents)for(const child of parent.children){
    if(child===el || child.contains(el) || child.matches('input,textarea,select,button,a,[role="button"],[role="alert"],[aria-live]') || child.querySelector('input,textarea,select,button,a,[role="button"]'))continue;
    const text=contextText(child).replace(/\\s+/g,' ').trim();
    if(text && text.length<=120 && child.getClientRects().length && !labelNodes.includes(child))labelNodes.push(child);
  }
  const labelTexts=[el.getAttribute('aria-label')||'',...labelNodes.map(label=>{
    const generated=['::before','::after'].map(pseudo=>view.getComputedStyle(label,pseudo).content).map(text=>text && text!=='none' && text!=='normal'?text.replace(/^["']|["']$/g,''):'');
    return [generated[0]||'',labelText(label),generated[1]||''].join(' ').replace(/\\s+/g,' ').trim();
  })];
  const markedRequired=labelTexts.some(text=>/^\\s*[*＊﹡✱]|[*＊﹡✱]\\s*$|(?:^|[（(\\s])(?:必填|required)(?:[）)\\s:：]|$)/i.test(text));
  const markedOptional=labelTexts.some(text=>/(?:^|[（(\\s])(?:optional|选填|可补充)(?:[）)\\s.,，。:：]|$)/i.test(text));
  let required,requiredSource;
  if(el.required){required=true;requiredSource='html';}
  else if(el.getAttribute('aria-required')==='true'){required=true;requiredSource='aria';}
  else if(markedRequired){required=true;requiredSource='label-required';}
  else if(el.getAttribute('aria-required')==='false'){required=false;requiredSource='aria';}
  else if(markedOptional){required=false;requiredSource='label-optional';}
  const validationErrors=[el.validationMessage||'',...ids('aria-errormessage').map(id=>doc.getElementById(id)?.textContent||'')].filter(Boolean);
  const ancestorIds=[],ancestorPaths=[];for(let p=el.parentElement,depth=0;p && depth<12;p=p.parentElement,depth++){if(p.id)ancestorIds.push(p.id);const path=pathFor(p);if(path)ancestorPaths.push(path);}
  const actionControl=tag==='button' || (tag==='input' && ['button','submit','reset','image'].includes(type));
  const valueControl=['textarea','select','output'].includes(tag) || (tag==='input' && !actionControl);
  const observedValue=valueControl && typeof el.value==='string'?el.value:el.isContentEditable?(el.textContent||''):undefined;
  const actionValue=actionControl && typeof el.value==='string'?el.value:undefined;
  const displayText=['input','textarea','select'].includes(tag)?undefined:(el.innerText||'').trim().slice(0,2000);
  const observedName=(fieldLabel || el.getAttribute('placeholder') || el.innerText || el.getAttribute('title') || '').trim().slice(0,2000);
  const picker=(${INSPECT_PICKER}).call(el,pathFor);
  return {availability,...(revealViaScroll?{revealViaScroll}:{}),editable,readable:true,...(peerGroup?{peerGroup}:{}),...(picker?{picker}:{}),domSemantics:{tag:el.tagName.toLowerCase(),role:el.getAttribute("role")||"",disabled:Boolean(el.disabled)||el.getAttribute("aria-disabled")==="true",readOnly:Boolean(el.readOnly)||el.getAttribute("aria-readonly")==="true"},context,modal,nativeSelect,observedValue,observedName,...(Object.keys(constraints).length?{constraints}:{}),...(actionValue===undefined?{}:{actionValue}),...(displayText===undefined?{}:{displayText}),htmlId:el.id,controlsIds:[...ids('aria-controls'),...ids('aria-owns')],ancestorIds,ownerPaths,ancestorPaths,position,scrollContainerPaths,labelledByIds,fieldLabel,validationErrors,...(required===undefined?{}:{required,requiredSource}),inputType:type,...(el.hasAttribute('aria-expanded')?{expanded:el.getAttribute('aria-expanded')==='true'}:{}),...(nativeSelect?{options,optionsTruncated:el.options.length>100}:{}),...(layer?{layer}:{}),...(layerKey?{layerKey}:{}),...(checked===undefined?{}:{checked})};
}`;

export async function inspectGoalControls(
  controller: Pick<
    NativeCdpController,
    "resolveBackendNode" | "callFunctionOnObject" | "releaseObject"
  >,
  snapshot: BrowserAxSnapshot,
  origins: readonly string[],
  signal: AbortSignal,
): Promise<GoalSnapshot> {
  const controls: Record<string, GoalControl> = {};
  // Bound concurrent CDP commands; one observation is shared by all choice candidates.
  for (let start = 0; start < snapshot.refs.length; start += 12) {
    signal.throwIfAborted();
    await Promise.all(
      snapshot.refs.slice(start, start + 12).map(async (ref) => {
        if (ref.backendNodeId === undefined) return;
        let objectId: string | undefined;
        try {
          objectId = await controller.resolveBackendNode({ backendNodeId: ref.backendNodeId });
          controls[ref.ref] = GoalControlSchema.parse(
            await controller.callFunctionOnObject({
              objectId,
              functionDeclaration: INSPECT_GOAL_CONTROL,
              args: [origins],
            }),
          );
        } catch {
          controls[ref.ref] = GoalControlSchema.parse({ availability: "unavailable" });
        } finally {
          if (objectId) await controller.releaseObject(objectId).catch(() => {});
        }
      }),
    );
  }
  signal.throwIfAborted();
  return { ...snapshot, controls };
}
