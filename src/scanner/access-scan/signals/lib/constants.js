export const CURRENT_ARIA_VALUES = new Set(['page', 'step', 'location', 'date', 'time', 'true']);

export const SEARCH_TOKEN = /(^|[\s_-])search([\s_-]|$)/;

export const SEARCH_ENTRY_INPUT_TYPES = new Set(['text', 'search', 'email', 'tel', 'url', 'number']);

export const SUBMENU_BUTTON_TOKENS = /\b(toggle|menu|submenu|expand|collapse|open|close)\b/i;

export const EXCLUDED_HIDDEN_TAGS = new Set(['script', 'style', 'link', 'meta', 'noscript', 'template']);

export const EXCLUDED_WIDGET_ROLES = new Set([
  'listbox', 'combobox', 'menu', 'menubar', 'dialog', 'disclosure',
]);

export const COMPOSITE_VISIBILITY_ROLES = new Set([
  'group', 'listbox', 'option', 'slider', 'tab', 'tabpanel',
]);

export const SCRIPT_ONLY_TAGS = new Set(['script', 'noscript', 'style', 'template']);

export const SENSITIVE_ATTR_NAMES = /(?:^|[-_])(?:token|secret|csrf|password|passwd|auth|session|key)(?:$|[-_])/i;

export const GLOBAL_INFORMATION_MARKER = /(?:©|\bcopyright\b|\ball rights\b)/i;

export const SUBSTANTIAL_STICKY_HEADER_HEIGHT = 96;
