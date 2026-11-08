# Spike E4.7: tracing React and Next.js elements to source

## What is installed (checked in `node_modules`, no installs)

| Candidate | Resolvable from the module? |
|---|---|
| `@babel/*`, `@swc/*`, `next`, `react`, `react-dom` | No |
| `typescript`, `esbuild`, `parse5`, `htmlparser2` | Only in the host workspace root, not a declared dependency of ada-scan |
| `acorn`, `rolldown` (Vite 8 bundler, has an oxc parser) | Only as transitive pnpm entries, not importable |

ada-scan has no JSX parser it may rely on, and a new dependency is out of scope.

## Options considered

| | Option | Verdict |
|---|---|---|
| a | Build-time transform that writes `data-ada-src="file:line"` on host JSX tags (Vite plugin / webpack loader / any bundler hook) | **Chosen.** Works with React 19 (no `__source`), survives minification and SSR, visible to every scan mode (local and preview), and needs only the source text. |
| b | Next with `.babelrc` plus a Babel plugin (disables SWC) | Not built. Needs `@babel/core` in the host, slows the build, and Next 15 warns that custom Babel loses SWC-only features (`next/font`, some server-component transforms). Document as an escape hatch only. |
| c | Runtime fiber `_debugSource` / `__reactFiber$` plus source maps | Rejected. `_debugSource` was removed in React 19, fibers exist only in dev builds, and it needs a browser round trip per element. |

## Decision

Option (a), split into three pieces so any bundler can use it:

1. `src/tracer/adapters/react-transform.js`: `transformJsx(code, { file })`, bundler-agnostic. Adds `data-ada-src="<file>:<line>"` to the opening tag of every lower-case host element (`div`, `img`, ...). It skips fragments, components (`Card`, `Foo.Bar`), tags that already carry the attribute, and never adds a newline, so the output keeps the input line numbers. Own scanner (strings, template literals, comments, regex literals, `{...}` expressions, generics after an identifier); a file it cannot scan is returned unchanged.
2. `vite/react-source-attr.js` (export `ada-scan/vite/react`): runs only with `SCAN_MODE=true`, transforms `.jsx`/`.tsx`, and emits `ada-react-src.json` with the sha256 of each transformed file.
3. `react` source adapter: `locate()` reads `data-ada-src` from the scanned element. Confidence rules:
   - `high`: attribute present, the file's hash still equals the one in the manifest, and a host element of the same tag starts at that line.
   - `medium`: same line and tag check, but no manifest hash to verify against.
   - `untraceable`: `no-marker` (no attribute, e.g. platform or third-party markup), `source-changed-since-build`, `page-source-missing`, `no-match` (wrong tag or line, hostile path), `platform-owned`. Never a guessed path.

A component rendered N times yields N DOM elements with the same `file:line`; that is one correct source, so it stays `high`.

## What the host project must provide

- Vite (any React + Vite app): add `reactSourceAttrPlugin()` from `ada-scan/vite/react` before the React plugin and build with `SCAN_MODE=true`. For a preview scan, deploy that build and pass the project as `--source`.
- Manifest: `dist/ada-react-src.json` by default (`el.reactManifest` overrides). Without it results are capped at `medium`.

## Limits

- Malformed manifest hash (not `sha256:<64 hex>`): `untraceable/manifest-invalid`. A manifest without the file behaves like no manifest.
- No manifest: `medium` is only line + tag agreement. A file edited after the build that happens to hold the same tag at the recorded line still returns `medium` (undetectable without a hash); always ship the manifest.
- Preview mode goes through the shared attestation gate in `traceElement`; a React preview scan stays `preview-without-reference` until the attestation records react source hashes. `supports.preview` is therefore aspirational. `src/index.js` callers do not pass `reactManifest`; `high` is reachable only through the default `dist/ada-react-src.json`.
- Gate 3 percentage is not measured for React: no real React app is available here.

- Lower-case host elements only. A component that spreads props onto a host element is traced to the host tag inside the component, which is correct (that is where the markup is).
- Elements created without JSX (`React.createElement`, `dangerouslySetInnerHTML`, third-party widgets) have no attribute: `untraceable/no-marker`.
- The scanner is heuristic: an `<` after an operand is never JSX; TSX arrow generics such as `<T,>(x) => x` are not elements. Files it cannot scan are skipped silently. Upgrade path: swap the scanner for a host-supplied parser (oxc, `@babel/parser`) behind the same `transformJsx` signature.
- Line numbers refer to the original file; the plugin passes `map: null` because insertions never move a line.

## Next.js (13-15): documented, not implemented

Not built, because it cannot be verified without installing Next and webpack/SWC in this module, and a faked integration would produce wrong traces. `next` is still detected, and resolves to `unsupported-framework` (findings are `untraceable`, no guess). Steps to finish it:

1. Provide a webpack loader (`ada-scan/next-loader`) that calls `transformJsx` on `.jsx/.tsx` (`enforce: 'pre'`, before `next-swc-loader`), enabled by `SCAN_MODE=true` in `next.config.js` via `webpack(config) { config.module.rules.unshift({ test: /\.[jt]sx$/, exclude: /node_modules/, enforce: 'pre', use: [{ loader: 'ada-scan/next-loader' }] }) }`. This works for `next build` without Turbopack. With Turbopack (`next dev --turbo`, Next 15 default dev) use `turbopack.rules` with the same loader (loader-runner API).
2. Emit `ada-react-src.json` from the loader's `compilation` (a webpack plugin) and write it to `.next/`; point `reactManifest` at it.
3. Register the `react` adapter under id `next` and add a fixture app.
- Pages router and client components (`'use client'`) render attributes on both server and client output. App router server components render only on the server: the attribute is in the HTML, but hydration mismatches are not an issue because the attribute is deterministic. Server-only files are still transformed by the loader, so they trace too.
- Caveat: with the attribute in the RSC payload, every element grows by about 30 bytes; use it only in scan builds.
