import { z } from "zod";

export const PickerEvidenceSchema = z.object({
  part: z.enum(["trigger", "option"]),
  relationship: z.enum(["aria", "local-dom", "unknown"]),
  triggerPath: z.string().optional(),
  panelPaths: z.array(z.string()),
  label: z.string().optional(),
  labelSource: z.enum(["label", "placeholder", "empty-display"]).optional(),
  expanded: z.boolean().optional(),
  panelVisible: z.boolean().optional(),
  selection: z.enum(["empty", "value", "unknown"]),
  selectionEvidence: z.enum(["native-select", "backing-input", "unknown"]),
  committedText: z.string().optional(),
  queryText: z.string().optional(),
  optionText: z.string().optional(),
  optionLabel: z.string().optional(),
  optionPath: z.string().optional(),
  optionSelected: z.boolean().optional(),
});
export type PickerEvidence = z.infer<typeof PickerEvidenceSchema>;

/** Fixed read-only DOM code. No class names, site labels, coordinates or desired values. */
export const INSPECT_PICKER = `function(pathFor) {
  const el=this, doc=el.ownerDocument, view=doc.defaultView;
  if(el.getRootNode()!==doc)return undefined;
  const clean=s=>String(s||'').replace(/[\\uE000-\\uF8FF]/g,'').replace(/\\s+/g,' ').trim();
  const panelSelector='ul,ol,[role="listbox"],[role="menu"],[role="tree"],[role="grid"],[role="dialog"],dialog';
  const optionSelector='li,option,[role="option"],[role="menuitem"],[role="treeitem"]';
  const triggerSelector='input,select,button,[tabindex],[role="combobox"],[aria-haspopup],[aria-controls],[aria-owns]';
  const ids=node=>[...(node.getAttribute('aria-controls')||'').split(/\\s+/),...(node.getAttribute('aria-owns')||'').split(/\\s+/)].filter(Boolean);
  const explicitPanels=node=>ids(node).map(id=>doc.getElementById(id)).filter(p=>p && p!==node);
  const hiddenValue=node=>{
    const inputs=[...node.querySelectorAll('input[type="hidden"]')];
    return inputs.length===1?inputs[0]:undefined;
  };
  // A unique visible text input paired with one hidden selection token is a
  // grounded autocomplete even when the application omits ARIA combobox markup.
  const inputBacking=node=>{
    if(node.tagName!=='INPUT' || !['text','search',''].includes(node.getAttribute('type')||''))return undefined;
    for(let p=node.parentElement,depth=0;p && p!==doc.body && p.tagName!=='FORM' && depth<2;p=p.parentElement,depth++){
      const fields=[...p.querySelectorAll('input:not([type="hidden"]),textarea,select')];
      if(fields.length>1)return undefined;
      const hidden=[...p.querySelectorAll('input[type="hidden"]')];
      if(fields.length===1 && fields[0]===node && hidden.length===1)return hidden[0];
    }
    return undefined;
  };
  const triggerLike=node=>Boolean(inputBacking(node)) ||node.tagName==='SELECT' || node.getAttribute('role')==='combobox' ||
    Boolean(node.getAttribute('aria-haspopup') && node.getAttribute('aria-haspopup')!=='false') ||
    explicitPanels(node).some(p=>p.matches(panelSelector)||p.querySelector('[role="listbox"],[role="menu"],[role="tree"]')) ||
    (node.tabIndex>=0 && hiddenValue(node));
  const triggersWithin=node=>{
    const all=[...node.querySelectorAll(triggerSelector)].filter(triggerLike);
    return all.filter(t=>!all.some(other=>other!==t && other.contains(t)));
  };
  const visible=node=>{
    if(!node.isConnected || !node.getClientRects().length)return false;
    for(let p=node;p;p=p.parentElement){const s=view.getComputedStyle(p);if(p.hidden || p.getAttribute('aria-hidden')==='true' || s.display==='none' || s.visibility!=='visible' || s.opacity==='0')return false;}
    return true;
  };
  const localPanels=trigger=>{
    if(trigger.tagName==='SELECT')return [];
    const nested=[...trigger.querySelectorAll(panelSelector)].filter(p=>p.querySelector(optionSelector));
    if(nested.length && !triggersWithin(trigger).length)return nested.filter(p=>!nested.some(other=>other!==p && other.contains(p)));
    for(let parent=trigger.parentElement,depth=0;parent && parent!==doc.body && depth<5;parent=parent.parentElement,depth++){
      const triggers=triggersWithin(parent);
      if(triggers.length>1)return [];
      if(triggers.length!==1 || triggers[0]!==trigger)continue;
      const panels=[...parent.querySelectorAll(panelSelector)].filter(p=>!trigger.contains(p) && p.querySelector(optionSelector));
      if(panels.length)return panels.filter(p=>!panels.some(other=>other!==p && other.contains(p)));
    }
    return [];
  };
  const option=el.closest(optionSelector);
  const ownRole=option && option.getAttribute('role');
  let trigger,panels=[],relationship='unknown',part;
  if(triggerLike(el) && !option){
    trigger=el;part='trigger';panels=explicitPanels(el);
    if(panels.length)relationship='aria';else {panels=localPanels(el);if(panels.length)relationship='local-dom';}
    if(el.tagName!=='SELECT' && !panels.length && !el.hasAttribute('aria-haspopup') && el.getAttribute('role')!=='combobox' && !inputBacking(el))return undefined;
  }else if(option){
    part='option';const panel=option.closest(panelSelector);
    if(!panel && option.tagName!=='OPTION')return undefined;
    const all=[...doc.querySelectorAll('[aria-controls],[aria-owns]')];
    const explicit=all.length<=512 ? all.filter(t=>triggerLike(t) && explicitPanels(t).some(p=>p.contains(option))) : [];
    let ambiguous=explicit.length>1 || all.length>512;
    if(explicit.length===1){trigger=explicit[0];panels=explicitPanels(trigger);relationship='aria';}
    if(!trigger && !ambiguous && panel){
      for(let parent=panel.parentElement,depth=0;parent && parent!==doc.body && depth<5;parent=parent.parentElement,depth++){
        const triggers=triggersWithin(parent).filter(t=>!panel.contains(t));
        if(triggers.length>1){ambiguous=true;break;}
        if(triggers.length===1){
          const candidate=triggers[0],owned=explicitPanels(candidate).length?explicitPanels(candidate):localPanels(candidate);
          if(owned.some(p=>p.contains(option))){trigger=candidate;panels=owned;relationship='local-dom';break;}
        }
      }
    }
    if(!trigger && !ambiguous && !['option','menuitem','treeitem'].includes(ownRole))return undefined;
  }else return undefined;
  const result={part,relationship,panelPaths:panels.map(pathFor).filter(Boolean),selection:'unknown',selectionEvidence:'unknown'};
  if(option && part==='option'){
    result.optionText=clean(option.innerText||option.textContent).slice(0,2000);
    result.optionLabel=clean(option.getAttribute('aria-label') || (option.innerText||option.textContent||'').split(/\\n/).find(line=>line.trim()) || '').slice(0,2000);
    const optionPath=pathFor(option);if(optionPath)result.optionPath=optionPath;
    if(option.hasAttribute('aria-selected'))result.optionSelected=option.getAttribute('aria-selected')==='true';
    else if(option.tagName==='OPTION')result.optionSelected=option.selected;
  }
  if(!trigger)return result;
  const path=pathFor(trigger);if(path)result.triggerPath=path;else result.relationship='unknown';
  const label=clean(trigger.getAttribute('aria-label') || [...(trigger.labels||[])].map(l=>l.textContent).join(' ') ||
    (trigger.getAttribute('aria-labelledby')||'').split(/\\s+/).map(id=>doc.getElementById(id)?.textContent||'').join(' '));
  if(label){result.label=label.slice(0,200);result.labelSource='label';}
  const backing=inputBacking(trigger);
  const hidden=hiddenValue(trigger)||backing,display=[];
  const walker=doc.createTreeWalker(trigger,4);let node;
  while((node=walker.nextNode())){
    const parent=node.parentElement;
    if(parent && visible(parent) && !parent.closest('script,style') && !panels.some(p=>p.contains(parent)))display.push(node.textContent||'');
  }
  const text=backing?clean(trigger.value):clean(display.join(''));
  if(trigger.tagName==='SELECT'){
    result.selection=trigger.selectedIndex<0 || (trigger.required && trigger.value==='')?'empty':'value';result.selectionEvidence='native-select';
    if(result.selection==='value')result.committedText=[...trigger.selectedOptions].map(o=>o.label).join(', ');
  }else if(hidden){
    result.selection=hidden.value!==''?'value':hidden.hasAttribute('value')?'unknown':'empty';result.selectionEvidence='backing-input';
    if(result.selection==='value' && text)result.committedText=text.slice(0,2000);
    if(!label && result.selection==='empty' && text){result.label=text.slice(0,200);result.labelSource='empty-display';}
  }
  if(['INPUT','TEXTAREA'].includes(trigger.tagName) && trigger.type!=='hidden'){
    if(!backing || !hidden.value || panels.some(visible))result.queryText=trigger.value;
    if(!label && trigger.placeholder){result.label=clean(trigger.placeholder).slice(0,200);result.labelSource='placeholder';}
  }
  if(panels.length)result.panelVisible=panels.some(visible);
  if(trigger.hasAttribute('aria-expanded'))result.expanded=trigger.getAttribute('aria-expanded')==='true';
  else if(panels.length)result.expanded=result.panelVisible;
  return result;
}`;
