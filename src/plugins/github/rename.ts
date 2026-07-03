import type { SubscriptionStore } from './subscribe'

export interface RenameDeps {
  /** Update the github row's name (keep the same secret). */
  setHookName(hookId: number, newName: string, secret: string): Promise<void>
  getChannels(): Promise<
    Array<{ id: string; platform: string; github: { webhooks: Record<string, any> } }>
  >
  upsertChannels(rows: any[]): Promise<void>
}

/**
 * Migrate a repo rename (1:1 with old command.js:273-288): rename the hook row, move the
 * webhooks meta key old->new in every subscribed channel, and swap the in-memory index.
 */
export async function migrateRepoRename(
  hookId: number,
  oldName: string,
  newName: string,
  secret: string,
  store: SubscriptionStore,
  deps: RenameDeps
): Promise<void> {
  await deps.setHookName(hookId, newName, secret)
  store.unsubscribe(oldName) // drop the whole old-repo index
  const channels = await deps.getChannels()
  const affected = channels.filter((c) => c.github?.webhooks?.[oldName])
  for (const c of affected) {
    const meta = c.github.webhooks[oldName]
    c.github.webhooks[newName] = meta
    delete c.github.webhooks[oldName]
    store.subscribe(newName, `${c.platform}:${c.id}`, meta)
  }
  if (affected.length) await deps.upsertChannels(affected)
}
