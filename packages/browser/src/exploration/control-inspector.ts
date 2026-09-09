import { z } from "zod";
import { DOM_CHOICE_UTILS } from "../runtime/dom-choice-structure.ts";

export const controlInspectionSchema = z.object({
  kind: z.enum(["native", "custom", "unknown"]),
  association: z.enum(["native", "aria", "contained", "explicit", "none", "ambiguous"]),
  triggerCss: z.string().nullable(),
  panelCss: z.string().nullable(),
  expanded: z.boolean(),
  value: z.string().max(8000),
  text: z.string().max(8000),
  multiple: z.boolean(),
  options: z
    .array(
      z.object({
        css: z.string(),
        label: z.string().max(500),
        value: z.string().max(8000).nullable(),
        selected: z.boolean(),
        disabled: z.boolean(),
      }),
    )
    .max(100),
  coverageWarnings: z.array(z.string()).max(10),
});
export type ControlInspection = z.infer<typeof controlInspectionSchema>;

/** Fixed host code: callers supply only an optional CSS region, never executable page source. */
export const INSPECT_CONTROL = `function(panelSelector) {
  const field=this, doc=field.ownerDocument;
  const choice=(${DOM_CHOICE_UTILS})(doc);
  const clean=value=>String(value || '').replace(/\\s+/g,' ').trim();
  const path=el=>{
    const parts=[];
    for(let cur=el;cur && cur.nodeType===1;cur=cur.parentElement){
      parts.unshift(cur.localName+':nth-child('+(Array.from(cur.parentElement?.children || [cur]).indexOf(cur)+1)+')');
      if(cur===doc.documentElement)break;
    }
    return parts.join(' > ');
  };
  const triggerQuery='select,input:not([type="hidden"]),button,[role="combobox"],[aria-controls],[aria-owns],[tabindex]';
  const self=field.matches(triggerQuery);
  const candidates=self?[field]:Array.from(field.querySelectorAll(triggerQuery)).filter(choice.visible);
  const triggers=candidates.filter(el=>!candidates.some(other=>other!==el && other.contains(el)));
  const trigger=triggers.length===1?triggers[0]:null;
  const native=trigger?.tagName==='SELECT';
  const out={kind:native?'native':trigger?'custom':'unknown',association:'none',triggerCss:trigger?path(trigger):null,panelCss:null,expanded:false,value:'',text:trigger?choice.text(trigger).slice(0,8000):'',multiple:Boolean(native && trigger.multiple),options:[],coverageWarnings:[]};
  if(!field.isConnected || !trigger){out.coverageWarnings.push('control_trigger_ambiguous_or_missing');return out;}
  if(trigger.type==='password'){out.kind='unknown';out.text='';out.coverageWarnings.push('password_is_not_a_choice_control');return out;}
  const stored=typeof trigger.value==='string'?trigger.value:'';
  out.value=String(stored || '').slice(0,8000);
  if(native)out.text=Array.from(trigger.selectedOptions).map(o=>clean(o.label)).join(' ').slice(0,8000);
  let panel=null, rows=[];
  const getGroups=root=>{
    const nodes=[root,...Array.from(root.querySelectorAll('ul,ol,[role="listbox"],[role="menu"],[role="tree"],div,section')).slice(0,500)];
    const groups=[];
    for(const node of nodes){
      if(node===trigger || !choice.visible(node))continue;
      const options=choice.rows(node);
      if(options.length && !groups.some(g=>g.rows.length===options.length && g.rows.every((r,i)=>r===options[i])))groups.push({node,rows:options});
    }
    return groups;
  };
  if(native){panel=trigger;rows=choice.rows(trigger);out.association='native';}
  else if(panelSelector){
    const matches=Array.from(doc.querySelectorAll(panelSelector));
    if(matches.length!==1){out.association=matches.length?'ambiguous':'none';out.coverageWarnings.push('explicit_panel_not_unique');return out;}
    panel=matches[0];rows=choice.rows(panel);
    if(!rows.length && choice.visible(panel)){
      const groups=getGroups(panel);if(groups.length===1)rows=groups[0].rows;
      else if(groups.length>1){out.association='ambiguous';out.coverageWarnings.push('panel_contains_multiple_choice_groups');return out;}
    }
    out.association='explicit';
  }else{
    const ids=clean((trigger.getAttribute('aria-controls')||'')+' '+(trigger.getAttribute('aria-owns')||'')).split(/\\s+/).filter(Boolean);
    const linked=[];
    for(const id of ids){const matches=Array.from(doc.querySelectorAll('[id='+JSON.stringify(id)+']'));if(matches.length!==1){out.association=matches.length?'ambiguous':'none';out.coverageWarnings.push('linked_panel_missing_or_duplicate_id');return out;}if(!linked.includes(matches[0]))linked.push(matches[0]);}
    if(linked.length>1){out.association='ambiguous';out.coverageWarnings.push('multiple_linked_panels');return out;}
    if(linked.length===1){panel=linked[0];rows=choice.rows(panel);out.association='aria';
      if(!rows.length && choice.visible(panel)){const groups=getGroups(panel);if(groups.length===1)rows=groups[0].rows;else if(groups.length>1){out.association='ambiguous';out.coverageWarnings.push('panel_contains_multiple_choice_groups');return out;}}
    }else{
      for(let root=field,level=0;root && root!==doc.body && level<4;root=root.parentElement,level++){
        const otherTriggers=Array.from(root.querySelectorAll(triggerQuery)).filter(el=>el!==trigger && !trigger.contains(el) && choice.visible(el) && !el.matches('[role="option"],[role="menuitem"],[role="treeitem"]'));
        // Never cross into a sibling field or whole form just because it has the only open menu.
        if(otherTriggers.some(el=>!field.contains(el)))break;
        const groups=getGroups(root);
        if(groups.length===1){panel=groups[0].node;rows=groups[0].rows;out.association='contained';break;}
        if(groups.length>1){out.association='ambiguous';out.coverageWarnings.push('multiple_contained_panels');return out;}
      }
    }
  }
  if(!panel){out.coverageWarnings.push('no_associated_open_panel_use_explicit_panel');return out;}
  out.panelCss=path(panel);out.expanded=native?false:choice.visible(panel);
  out.multiple=out.multiple || panel.getAttribute('aria-multiselectable')==='true';
  if(rows.length>100)out.coverageWarnings.push('options_truncated');
  out.options=rows.slice(0,100).map(el=>({css:path(el),label:clean(el.label || choice.text(el)).slice(0,500),value:el.hasAttribute('value')?String(el.value ?? el.getAttribute('value')).slice(0,8000):null,selected:Boolean(el.selected || el.getAttribute('aria-selected')==='true' || el.getAttribute('aria-checked')==='true'),disabled:Boolean(el.matches(':disabled') || el.closest('[aria-disabled="true"],[inert],optgroup[disabled]'))}));
  if(!native && out.expanded && !out.options.length)out.coverageWarnings.push('no_rendered_options');
  if(!native)out.coverageWarnings.push('rendered_options_only');
  return out;
}`;

/** Selection is a host-owned native select operation; all policy/hit checks occur in the driver. */
export const SELECT_NATIVE_OPTION = `function(label, value) {
  if(!this.isConnected || this.tagName!=='SELECT' || this.multiple || this.disabled)return false;
  const normalize=s=>String(s || '').replace(/\\s+/g,' ').trim();
  const matches=Array.from(this.options).filter(o=>value===null?normalize(o.label)===label:o.value===value);
  if(matches.length!==1 || matches[0].disabled || matches[0].closest('optgroup[disabled]'))return false;
  const view=this.ownerDocument.defaultView;
  const setter=Object.getOwnPropertyDescriptor(view.HTMLSelectElement.prototype,'selectedIndex').set;
  setter.call(this,Array.from(this.options).indexOf(matches[0]));
  this.dispatchEvent(new view.Event('input',{bubbles:true}));
  this.dispatchEvent(new view.Event('change',{bubbles:true}));
  return true;
}`;
