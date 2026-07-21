class MinimalNode {
  constructor() {
    this.childNodes = [];
    this.parentNode = null;
    this.className = '';
    this.textContent = '';
    this.dataset = {};
    this.attributes = new Map();
    this.tagName = '';
    this.scope = null;
    this.colSpan = 1;
  }

  appendChild(child) {
    this.childNodes.push(child);
    child.parentNode = this;
    return child;
  }

  setAttribute(name, value) {
    this.attributes.set(name, String(value));
  }

  getAttribute(name) {
    return this.attributes.get(name) ?? null;
  }
}

class MinimalElement extends MinimalNode {
  constructor(tagName) {
    super();
    this.tagName = String(tagName).toUpperCase();
  }
}

export function createMinimalDocument() {
  return {
    createElement(tagName) {
      return new MinimalElement(tagName);
    },
  };
}

export function collectText(node) {
  if (!node) return '';
  if (node.textContent) return String(node.textContent);
  return node.childNodes.map((child) => collectText(child)).join('');
}

export function findElements(node, predicate, found = []) {
  if (!node) return found;
  if (predicate(node)) found.push(node);
  for (const child of node.childNodes || []) {
    findElements(child, predicate, found);
  }
  return found;
}
