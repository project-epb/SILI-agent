import flourite from 'flourite'

/**
 * Best-effort programming-language detection for a code snippet, returning a
 * shiki-compatible language id (lower-case, e.g. `typescript`, `python`).
 *
 * flourite is a dependency-free heuristic scorer — accurate on snippets with
 * real content, and it returns `unknown` for short/ambiguous input rather than
 * guessing wildly. We map that to `'text'`, so the result is always safe to
 * hand to shiki as a language (shiki treats `text` as plain, unhighlighted).
 *
 * Callers should still validate the result against shiki's bundled languages
 * before loading it — this stays decoupled from any particular shiki version.
 */
export function detectLang(code: string): string {
  const { language } = flourite(code, { shiki: true })
  return language && language !== 'unknown' ? language : 'text'
}
