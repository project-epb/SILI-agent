/**
 * Monospace stack for rendered code. The container's CJK sans default (e.g.
 * 汉仪文黑) is not fixed-width, so code opts into a real monospace font
 * explicitly — English glyphs render fixed-width, CJK falls back to the system
 * sans (not monospace, which is acceptable here). Whichever face the image has
 * installed wins; the tail keeps browser previews (Menlo/Consolas) sensible.
 * Shared by the shiki and markdown renderers.
 */
export const MONO_FONT =
  '"JetBrains Mono", "Cascadia Code", "Fira Code", "DejaVu Sans Mono", "Menlo", "Consolas", "Liberation Mono", monospace'
