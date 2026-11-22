/** How much of each output stream reaches the model: its start and its end. */
export const HEAD_BYTES = 4 * 1024
export const TAIL_BYTES = 16 * 1024

export interface Clipped {
  text: string
  /** Bytes left out of the middle; 0 when the whole stream fits. */
  omitted: number
}

/** The first HEAD_BYTES and last TAIL_BYTES of a stream, as UTF-8 text. */
export function clipStream(bytes: Uint8Array): Clipped {
  const decoder = () => new TextDecoder('utf-8', { fatal: false })
  if (bytes.length <= HEAD_BYTES + TAIL_BYTES)
    return { text: decoder().decode(bytes), omitted: 0 }
  const omitted = bytes.length - HEAD_BYTES - TAIL_BYTES
  const head = decoder().decode(bytes.subarray(0, HEAD_BYTES))
  const tail = decoder().decode(bytes.subarray(bytes.length - TAIL_BYTES))
  return { text: `${head}\n[… ${omitted} bytes omitted …]\n${tail}`, omitted }
}

/** A conversation key as a directory name under /workspace. */
export function conversationDirName(key: string | number): string {
  const name = String(key).replace(/[^A-Za-z0-9_-]+/g, '-')
  return typeof key === 'number' || /^\d+$/.test(name) ? `user-${name}` : name
}
