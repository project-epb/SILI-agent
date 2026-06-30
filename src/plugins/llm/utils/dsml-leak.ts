/**
 * Detection for the DeepSeek-family "DSML leak" provider bug.
 *
 * Some DeepSeek hosts occasionally emit the model's internal tool-call
 * markup as plain `content` text instead of routing it through the
 * `tool_calls` channel. The leaked text looks like:
 *
 *   <｜DSML｜tool_calls>
 *   <｜DSML｜invoke name="execute_koishi_command">
 *   <｜DSML｜parameter name="name" string="true">help</｜DSML｜parameter>
 *   ...
 *
 * Two delimiter variants observed in production (single vs doubled
 * full-width pipe): `<｜DSML｜...>` and `<｜｜DSML｜｜...>`. Every leaked
 * line starts with `<` + one-or-more full-width pipes (U+FF5C, `｜`) + DSML.
 *
 * The pattern anchors on that opening signature rather than a bare `DSML`
 * substring, ruling out two false-positive classes seen in real data:
 *  - base64 / ASCII tool output embedding the literal `DSML` (no full-width
 *    pipe in the base64 alphabet, and no leading `<｜`);
 *  - prose using a full-width pipe as a separator before the acronym, e.g.
 *    `软件工程｜DSML建模` (DSML = Domain-Specific Modeling Language) — no `<`
 *    immediately before the pipe run.
 *
 * It deliberately does NOT require the closing `>` so detection fires as
 * soon as `<｜DSML` streams in, before the garbage body accumulates.
 */
export const DSML_LEAK_PATTERN = /<｜+DSML/

/** True if `content` contains the DSML-leak opening signature. */
export function containsDsmlLeak(content: string): boolean {
  return DSML_LEAK_PATTERN.test(content)
}
