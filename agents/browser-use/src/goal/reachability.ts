/** Fixed read-only geometry probe. Revealing still uses the native driver's CDP path. */
export const INSPECT_REACHABILITY = `function(el,origins) {
  let revealViaScroll=false;
  const result=(availability)=>({availability,...(availability==='offscreen' && revealViaScroll?{revealViaScroll:true}:{})});
  const transformed=s=>s.transform!=='none' || s.perspective!=='none' || (s.translate && s.translate!=='none') || (s.rotate && s.rotate!=='none') || (s.scale && s.scale!=='none') || (s.zoom && s.zoom!=='normal' && Number(s.zoom)!==1);
  const layer=(node,view)=>{for(let p=node;p;p=p.parentElement){if(p.matches('dialog[open],[role="dialog"],[aria-modal="true"]'))return p;const s=view.getComputedStyle(p);if(s.position==='fixed' || s.position==='sticky')return p;}return null;};
  const modal=node=>node && (node.matches('dialog[open],[role="dialog"],[aria-modal="true"]') || Boolean(node.closest('dialog[open],[role="dialog"],[aria-modal="true"]')));
  const edgeLayer=(cover,ownLayer,view)=>{
    if(!cover || cover===ownLayer || modal(cover))return false;
    const cr=cover.getBoundingClientRect();
    return (cr.height<view.innerHeight/2 && (cr.top<=1 || cr.bottom>=view.innerHeight-1)) || (cr.width<view.innerWidth/2 && (cr.left<=1 || cr.right>=view.innerWidth-1));
  };
  const bounds=(node)=>{const r=node.getBoundingClientRect();return {left:r.left+node.clientLeft,top:r.top+node.clientTop,right:r.left+node.clientLeft+node.clientWidth,bottom:r.top+node.clientTop+node.clientHeight};};
  const room=(node,axis,direction)=>{const offset=axis==='x'?node.scrollLeft:node.scrollTop,max=axis==='x'?node.scrollWidth-node.clientWidth:node.scrollHeight-node.clientHeight;return direction<0?offset>1:offset<max-1;};
  try {
    let view=el.ownerDocument.defaultView,node=el;
    if(!view || !origins.includes(view.location.origin))return result('unavailable');
    const r=el.getBoundingClientRect();let point={x:r.left+r.width/2,y:r.top+r.height/2},reveal=false;
    for(let depth=0;depth<33;depth++){
      if(depth===32 || !origins.includes(view.location.origin))return result('unavailable');
      const doc=node.ownerDocument,root=doc.scrollingElement,ownLayer=layer(node,view);
      const activeModal=[...doc.querySelectorAll('dialog[open],[aria-modal="true"]')].find(p=>{const s=view.getComputedStyle(p);return p.getClientRects().length && s.display!=='none' && s.visibility==='visible' && s.opacity!=='0' && !p.contains(node);});
      if(activeModal)return result('covered');
      const viewport={left:0,top:0,right:view.innerWidth,bottom:view.innerHeight};
      let scope=node,visible={...viewport},localReveal=false;
      const movable=[];
      for(let p=node;p;p=p.parentElement){
        const s=view.getComputedStyle(p);
        if(transformed(s))return result('unavailable');
        if(s.display==='none' || s.visibility!=='visible' || s.opacity==='0' || p.hasAttribute('inert'))return result('covered');
        if(p===node || p===root || p===doc.body)continue;
        const b=bounds(p);
        const axes=[['x','overflowX','left','right'],['y','overflowY','top','bottom']];
        for(const [axis,overflow,low,high] of axes){
          if(!/^(auto|scroll|hidden|clip)$/.test(s[overflow]))continue;
          const scrollable=/^(auto|scroll)$/.test(s[overflow]);
          if(scrollable)movable.push({node:p,axis,b});
          if(point[axis]<b[low] || point[axis]>=b[high]){
            if(!scrollable || !room(p,axis,point[axis]<b[low]?-1:1))return result('covered');
            point[axis]=Math.max(b[low]+1,Math.min(b[high]-2,point[axis]));scope=p;localReveal=true;visible={left:Math.max(0,b.left),top:Math.max(0,b.top),right:Math.min(view.innerWidth,b.right),bottom:Math.min(view.innerHeight,b.bottom)};
          }
          visible[low]=Math.max(visible[low],b[low]);visible[high]=Math.min(visible[high],b[high]);
        }
      }
      const rootStyle=root && view.getComputedStyle(root),bodyStyle=doc.body && view.getComputedStyle(doc.body);
      for(const [axis,overflow,low,high] of [['x','overflowX','left','right'],['y','overflowY','top','bottom']]){
        const scrollable=root && !ownLayer && ![rootStyle?.[overflow],bodyStyle?.[overflow]].some(value=>value==='hidden' || value==='clip');
        if(scrollable)movable.push({node:root,axis,b:viewport});
        if(point[axis]<viewport[low] || point[axis]>=viewport[high]){
          if(!scrollable || !room(root,axis,point[axis]<viewport[low]?-1:1))return result('covered');
          point[axis]=Math.max(viewport[low]+1,Math.min(viewport[high]-2,point[axis]));scope=root;localReveal=true;visible={...viewport};
        }
      }
      const same=(hit)=>hit && (hit===node || node.contains(hit));
      const exposed=(hit,container)=>{
        if(!hit || !(hit===container || container.contains(hit)))return false;
        const hitLayer=layer(hit,view);
        return !hitLayer || hitLayer===ownLayer;
      };
      const sample=(container,region)=>{
        if(region.right-region.left<4 || region.bottom-region.top<4)return null;
        for(const fy of [0.5,0.25,0.75,0.05,0.95])for(const fx of [0.5,0.25,0.75,0.05,0.95]){
          const p={x:region.left+(region.right-region.left)*fx,y:region.top+(region.bottom-region.top)*fy};
          if(exposed(doc.elementFromPoint(p.x,p.y),container))return p;
        }
        return null;
      };
      const hit=doc.elementFromPoint(point.x,point.y);
      if(localReveal){
        if(!exposed(hit,scope)){
          if(!edgeLayer(hit && layer(hit,view),ownLayer,view))return result('covered');
          revealViaScroll=true;
        }
        const probe=exposed(hit,scope)?point:sample(scope,visible);
        if(!probe)return result('covered');point=probe;reveal=true;
      }else if(!same(hit)){
        // A small edge-docked fixed/sticky toolbar may cover a scrollable target.
        // Dialogs, central overlays and full-screen layers are never reveal routes.
        const cover=hit && layer(hit,view),cr=cover && cover.getBoundingClientRect();
        if(!edgeLayer(cover,ownLayer,view))return result('covered');
        let probe=null;
        for(const candidate of movable){
          const axis=candidate.axis,coordinate=axis==='x'?point.x:point.y;
          const start=axis==='x'?cr.left:cr.top,end=axis==='x'?cr.right:cr.bottom;
          if(coordinate<start || coordinate>=end)continue;
          const towardStart=start>=(axis==='x'?view.innerWidth:view.innerHeight)/2;
          if(!room(candidate.node,axis,towardStart?1:-1))continue;
          const region={left:Math.max(visible.left,candidate.b.left),top:Math.max(visible.top,candidate.b.top),right:Math.min(visible.right,candidate.b.right),bottom:Math.min(visible.bottom,candidate.b.bottom)};
          if(axis==='y'){if(towardStart)region.bottom=Math.min(region.bottom,cr.top);else region.top=Math.max(region.top,cr.bottom);}
          else if(towardStart)region.right=Math.min(region.right,cr.left);else region.left=Math.max(region.left,cr.right);
          probe=sample(candidate.node,region);if(probe)break;
        }
        if(!probe)return result('covered');point=probe;reveal=true;revealViaScroll=true;
      }
      if(view===view.top)return result(reveal?'offscreen':'ready');
      const owner=view.frameElement,parent=owner?.ownerDocument.defaultView;
      if(!owner || !parent || !origins.includes(parent.location.origin))return result('unavailable');
      const box=owner.getBoundingClientRect();point={x:point.x+box.left+owner.clientLeft,y:point.y+box.top+owner.clientTop};
      node=owner;view=parent;
    }
  }catch{return result('unavailable');}
  return result('unavailable');
}`;
