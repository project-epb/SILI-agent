// One-time: activation moves from channel.assignee to qqbot_channel.activated
// (docs/superpowers/specs/2026-11-17-group-activation-design.md, decision 5).
//
//   docker cp scripts/migrate-activation.mongo.js sili-mongo:/tmp/m.js && docker exec sili-mongo mongosh --quiet sili_v4 --file /tmp/m.js
//
// Order matters: mark assigned groups activated FIRST, then assign the rest.
// The other way round would activate every group.

const platforms = ['qq', 'qqguild']

// 1. Groups assigned to a bot are activated for it.
const assigned = db.channel
  .find({ platform: { $in: platforms }, assignee: { $nin: ['', null] } })
  .toArray()
for (const c of assigned) {
  db.qqbot_channel.updateOne(
    { selfId: c.assignee, id: c.id },
    { $set: { platform: c.platform, activated: true } },
    { upsert: true }
  )
}
const assignedKeys = new Set(assigned.map((c) => `${c.platform}:${c.id}`))

// 2. Groups a bot is in without an assignee get one: routing only, not
//    activated. Existing channel rows only: Koishi creates a missing row on
//    the group's next message, already assigned (autoAssign), with all its
//    default fields.
let routed = 0
for (const c of db.qqbot_channel
  .find({ platform: { $in: platforms }, removedAt: null })
  .toArray()) {
  if (assignedKeys.has(`${c.platform}:${c.id}`)) continue
  const r = db.channel.updateOne(
    { platform: c.platform, id: c.id },
    { $set: { assignee: c.selfId } }
  )
  routed += r.modifiedCount
}

print(`activated ${assigned.length} assigned groups, assigned ${routed} more (not activated)`)
