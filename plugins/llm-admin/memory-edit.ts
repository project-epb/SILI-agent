export function utf8ByteLength(s: string): number {
  return new TextEncoder().encode(s).length
}

export function checkMemoryWrite(
  content: string,
  hardLimit: number
): { ok: boolean; byteSize: number; error?: string } {
  const byteSize = utf8ByteLength(content)
  if (byteSize > hardLimit)
    return {
      ok: false,
      byteSize,
      error: `记忆超出字节上限（${byteSize} > ${hardLimit}）`,
    }
  return { ok: true, byteSize }
}
