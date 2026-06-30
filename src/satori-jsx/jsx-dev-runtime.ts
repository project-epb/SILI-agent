/**
 * Dev-mode counterpart of ./jsx-runtime — used when the JSX automatic runtime
 * compiles in development mode (jsx-dev-runtime). See ./jsx-runtime for why
 * this shim exists. `Element.jsxDEV` is the same namespace factory.
 */
import Element from '@satorijs/element'

export const Fragment = Element.Fragment
export const jsxDEV = Element.jsxDEV ?? Element.jsx
