// Keyed list reconciliation. The server pushes state ten times a second, so
// rows update their text in place rather than being torn down and rebuilt —
// that keeps hover, selection, scroll position and text selection alive.

/**
 * @param host    element whose children are the rows
 * @param items   data, in the order they should appear
 * @param keyOf   stable key per item
 * @param create  (node, item) => refs — build the row once, return its parts
 * @param update  (node, refs, item) => void — refresh text every push
 * @param tag     element to create for a row (default 'tr')
 */
export function syncRows(host, items, keyOf, create, update, tag = 'tr') {
  const existing = new Map();
  for (const node of [...host.children]) existing.set(node.dataset.key, node);
  const seen = new Set();
  let prev = null;

  for (const item of items) {
    const key = String(keyOf(item));
    seen.add(key);
    let node = existing.get(key);
    if (!node) {
      node = document.createElement(tag);
      node.dataset.key = key;
      node.refs_ = create(node, item);
    }
    update(node, node.refs_, item);
    const anchor = prev ? prev.nextSibling : host.firstChild;
    if (anchor !== node) host.insertBefore(node, anchor);
    prev = node;
  }

  for (const [key, node] of existing) if (!seen.has(key)) node.remove();
}

/** Write text and (optionally) a class only when they actually changed. */
export function setText(node, text, className) {
  if (node.textContent !== text) node.textContent = text;
  if (className !== undefined && node.className !== className) node.className = className;
}
