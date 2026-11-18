// One-time: fandom_verify rows move to wiki_join_code + wiki_join_binding
// (docs/superpowers/specs/2026-11-18-wiki-join-verify-design.md, decision 12).
//
//   docker cp scripts/migrate-fandom-verify.mongo.js sili-mongo:/tmp/m.js && docker exec sili-mongo mongosh --quiet sili_v4 --file /tmp/m.js
//
// Run after the new plugin has started once (minato creates the unique
// primary-key indexes; primary keys are plain fields, _id stays an ObjectId).
// Idempotent. Rows are replayed oldest first, so an openid that joined with
// two Fandom accounts ends up bound to the later one.

let codes = 0
let bindings = 0
for (const row of db.fandom_verify.find().sort({ time: 1 }).toArray()) {
  const code = db.wiki_join_code.updateOne(
    { hash: row.hash },
    {
      $setOnInsert: {
        wiki: 'fandom',
        wikiUserId: row.wikiUserId,
        platform: row.platform,
        selfId: row.selfId,
        userId: row.userId,
        time: row.time,
      },
    },
    { upsert: true }
  )
  codes += code.upsertedCount
  const binding = db.wiki_join_binding.updateOne(
    {
      wiki: 'fandom',
      platform: row.platform,
      selfId: row.selfId,
      userId: row.userId,
    },
    {
      $set: {
        wikiUserId: row.wikiUserId,
        wikiUserName: row.wikiUserName,
        source: 'auto',
        time: row.time,
      },
    },
    { upsert: true }
  )
  bindings += binding.upsertedCount
}
print(`codes: +${codes}, bindings: +${bindings}`)
