/** Fixed DOM-only helpers shared by observation and field inspection. No site selectors. */
export const DOM_CHOICE_UTILS = String.raw`(doc) => {
  const view = doc.defaultView;
  const normalize = (value) => String(value ?? "").replace(/\s+/g, " ").trim();
  const visible = (element) => {
    if (!element || !element.isConnected || element.closest('[hidden], [aria-hidden="true"], [inert]')) return false;
    for (let current = element, depth = 0; current && depth < 100; current = current.parentElement, depth += 1) {
      const style = view.getComputedStyle(current);
      if (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse' || Number(style.opacity) === 0) return false;
    }
    const rect = element.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  };
  const text = (element) => {
    const label = normalize(element.getAttribute('aria-label'));
    if (label) return label.slice(0, 500);
    if (element.tagName === 'OPTION') return normalize(element.label).slice(0, 500);
    const walker = doc.createTreeWalker(element, 4);
    const parts = [];
    for (let node = walker.nextNode(), count = 0; node && count < 500; node = walker.nextNode(), count += 1) {
      const parent = node.parentElement;
      if (!parent || parent.closest('[aria-hidden="true"],[hidden],script,style') || !visible(parent)) continue;
      const ownerRow = parent.closest('[role="option"],[role="menuitem"],[role="menuitemcheckbox"],[role="menuitemradio"],[role="treeitem"]');
      if (ownerRow && ownerRow !== element && element.contains(ownerRow)) continue;
      const value = normalize(node.textContent);
      if (value) parts.push(value.slice(0, 500));
      if (parts.join(' ').length >= 500) break;
    }
    return parts.join(' ').slice(0, 500);
  };
  const groupSelector = 'select,ul,ol,[role="listbox"],[role="menu"],[role="tree"]';
  const semanticRow = '[role="option"],[role="menuitem"],[role="menuitemcheckbox"],[role="menuitemradio"],[role="treeitem"]';
  const explicitAction = (element) => element.matches('button,a[href],input,[role="option"],[role="menuitem"],[role="menuitemcheckbox"],[role="menuitemradio"],[role="treeitem"]') ||
    element.hasAttribute('onclick') || typeof element.onclick === 'function' ||
    (element.hasAttribute('tabindex') && element.getAttribute('tabindex') !== '-1') || element.hasAttribute('aria-selected');
  const independentAction = (element) => explicitAction(element) ||
    (view.getComputedStyle(element).cursor === 'pointer' &&
      (!element.parentElement || view.getComputedStyle(element.parentElement).cursor !== 'pointer'));
  const descendants = (root) => {
    const walker = doc.createTreeWalker(root, 1);
    const found = [];
    for (let node = walker.nextNode(); node && found.length < 2000; node = walker.nextNode()) found.push(node);
    return found;
  };
  const rows = (root) => {
    if (!root || root.ownerDocument !== doc) return [];
    if (root.tagName === 'SELECT') return Array.from(root.options).slice(0, 500).filter((row) => !row.hidden && !row.closest('optgroup[hidden]'));
    if (!root.matches(groupSelector) && root.childElementCount < 2) return [];
    if (!visible(root)) return [];
    const semantic = (root.matches(groupSelector) ? descendants(root) : []).filter((row) => row.matches(semanticRow) &&
      row.closest(groupSelector) === root && !root.contains(row.parentElement?.closest(semanticRow)) && visible(row) && text(row));
    if (semantic.length) return semantic.slice(0, 500);
    const children = Array.from(root.children).slice(0, 500).filter((row) => visible(row) && text(row));
    if (root.matches('ul,ol')) {
      const listRows = children.filter((row) => row.tagName === 'LI');
      const groupAction = explicitAction(root) || view.getComputedStyle(root).cursor === 'pointer';
      return groupAction || listRows.some(independentAction) ? listRows : [];
    }
    // Repetition alone is insufficient: paragraphs and inherited-pointer card contents are not options.
    if (children.length < 2 || !children.every(independentAction)) return [];
    const tag = children[0].tagName;
    if (!children.every((row) => row.tagName === tag)) return [];
    return children;
  };
  return { rows, visible, text };
}`;
