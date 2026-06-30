/**
 * Satori JSX automatic-runtime shim.
 *
 * `@satorijs/element` ships a default-only ESM module (a CJS namespace wrapped
 * as `export default`), exposing `jsx` / `jsxs` / `Fragment` as *properties* of
 * that namespace rather than as named ESM exports. esbuild (tsx) tolerated this
 * via CJS interop, but stricter ESM loaders (bun's runtime, native Node ESM)
 * reject `import { jsx, Fragment } from '@satorijs/element/jsx-runtime'` with
 * "Export named 'Fragment' not found".
 *
 * This shim re-exposes the same factory functions as proper named exports.
 * `jsxImportSource` points here (see tsconfig.json). Runtime behaviour is
 * identical — `Element.jsx` is exactly the function esbuild used.
 */
import Element from '@satorijs/element'

export const Fragment = Element.Fragment
export const jsx = Element.jsx
export const jsxs = Element.jsxs
