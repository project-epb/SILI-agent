export interface InfoboxDefinition {
  match: (url: URL) => boolean | string
  selector: string | string[]
  injectStyles?: string
  skin?: string
  /**
   * Build a user's avatar URL for the ns=2 pseudo-infobox. Omit for sites
   * without a predictable avatar URL — the template falls back to a placeholder.
   */
  getAvatarUrl?: (user: { userid: number; name: string }) => string
}
