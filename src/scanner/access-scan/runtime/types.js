/**
 * @typedef {object} SnapshotElement
 * @property {number} id
 * @property {number | null} parentId
 * @property {string} tag
 * @property {Record<string, string>} attributes
 * @property {string} text
 * @property {string} visibleText Descendant rendered visual text for the element subtree.
 * @property {string} selector
 * @property {string} reportSelector
 * @property {number[]} framePath
 * @property {number[]} shadowPath
 * @property {string} outerHTML Bounded structural snippet (not a deep-cloned subtree).
 * @property {{ x: number, y: number, width: number, height: number }} rect
 * @property {Record<string, string>} computedStyle
 * @property {{ width: number, height: number }=} intrinsicDimensions Present on img elements when dimensions are known.
 * @property {string} accessibleName
 * @property {number} effectiveOpacity Composed opacity across ancestor chain.
 * @property {boolean} rendered
 * @property {boolean} visuallyVisible
 * @property {boolean} hiddenFromAT
 * @property {boolean} focusable
 *
 * @typedef {object} RuntimeDiagnostic
 * @property {string} code
 * @property {string=} reason
 * @property {boolean} inspected
 * @property {string=} message
 * @property {Record<string, unknown>=} details Frozen when present.
 *
 * @typedef {object} Snapshot
 * @property {readonly SnapshotElement[]} elements Deep-frozen element graph.
 * @property {readonly RuntimeDiagnostic[]} diagnostics Deep-frozen diagnostics.
 * @property {Readonly<{ frameCount: number, shadowRootCount: number, closedShadowCount: number }>} counts
 *
 * aria-labelledby IDREF resolution is scoped to each element root node
 * (document, shadow root, or frame document). References never cross frames.
 *
 * Behavioral forks use a separate BrowserContext seeded from source storageState
 * when available. Callers must invoke cleanup() to close the owned context.
 */

export {};
