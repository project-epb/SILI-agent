---
name: koishi-plugin-authoring
description: Use when writing or editing a Koishi plugin — declaring its config Schema, defaults, dependencies (inject), or choosing between the functional and class plugin forms; especially when config .default() values silently fail to apply or a plugin's Config schema seems ignored.
---

# Koishi Plugin Authoring

## Overview

A Koishi plugin is a value passed to `ctx.plugin(plugin, config)`. Koishi resolves the config through the plugin's **`Config` (or `schema`) property** before the plugin runs:

```js
// @cordisjs/core resolveConfig — runs at registration, before apply/constructor
const schema = plugin["Config"] || plugin["schema"]
if (schema && plugin["schema"] !== false) config = schema(config)  // validates + fills .default()s
```

**The core rule:** the schema must live on the *plugin value itself* as a `Config` property. Where that property goes differs by plugin form. Put it in the wrong place and koishi never calls it — your `.default()`s silently do nothing (config arrives partial/undefined).

## The two conventional forms

### Functional
The plugin value is the **module namespace** (or a plain object). `Config` is a module-level export → it *is* `plugin.Config`, so it works.

```ts
import { Context, Schema } from 'koishi'

export const name = 'foo'
export const inject = ['database']                 // or { database: { required: true } }
export interface Config { prefix: string }
export const Config: Schema<Config> = Schema.object({
  prefix: Schema.string().default('[Foo] '),
})
export function apply(ctx: Context, config: Config) {
  // config.prefix is '[Foo] ' by default — koishi applied the schema
}
```

### Class (object-style)
The plugin value is the **class**. `Config` must be a **`static` member** of the class → `plugin.Config`. A module-level `export const Config` next to a `export default class` is NOT on the class, so koishi never reads it.

```ts
import { Context, Schema } from 'koishi'

export interface Config { prefix: string }
export default class PluginFoo {
  static inject = ['database']
  static Config: Schema<Config> = Schema.object({
    prefix: Schema.string().default('[Foo] '),
  })
  constructor(public ctx: Context, public config: Config) {
    // config.prefix is '[Foo] ' by default — koishi filled it before constructing
  }
}
```

## Quick reference

| | Functional | Class |
|---|---|---|
| plugin value | module namespace / object | the class |
| where `Config` goes | `export const Config` | `static Config` |
| where `inject` goes | `export const inject` | `static inject` |
| entry | `export function apply(ctx, config)` | `constructor(ctx, config)` |
| defaults applied? | yes (koishi reads `namespace.Config`) | yes **iff** `static` |

`inject` accepts `string[]` (all required) or `{ name: { required: boolean } }` for optional services.

## The trap (common mistake)

```ts
// ❌ Class plugin with a MODULE-LEVEL Config — koishi never applies it.
export const Config = Schema.object({ prefix: Schema.string().default('[Foo] ') })
export default class PluginFoo {
  constructor(ctx, config) { /* config.prefix is undefined! default dropped */ }
}
```

**Symptom:** config `.default()` values missing at runtime; downstream `config.x ?? fallback` always hits the fallback; behavior differs from a plugin whose defaults you expected.

**Fix:** move the schema to `static Config` on the class.

**Do not** work around it by merging a plain defaults object in the constructor (`super(ctx, { ...DEFAULTS, ...config })`). That works but is non-conformant, duplicates the schema, and loses koishi's validation/console integration. Some existing plugins do this — don't copy them.

**Need to apply a schema manually** (e.g. outside plugin registration)? A schema is callable: `const resolved = Config(rawInput)` returns the validated, default-filled value.

## Verify

Empirically confirmed (koishi 4.18 / cordis): a class `static Config` default reaches the constructor; a module-level `export const Config` on a class does not (constructor sees `{}`). To check in any project, register a throwaway plugin with a defaulted `static Config` and log the config the constructor receives.
