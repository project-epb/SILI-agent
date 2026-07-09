// turnNumbers 已升序去重。返回本批要包含的最小 turn（fromTurn，含）与是否还有更早。
export function turnWindow(
  turnNumbers: number[],
  limit: number,
  beforeTurn: number | null
): { fromTurn: number | null; hasMore: boolean } {
  if (!turnNumbers.length) return { fromTurn: null, hasMore: false }
  const eligible =
    beforeTurn == null ? turnNumbers : turnNumbers.filter((t) => t < beforeTurn)
  if (!eligible.length) return { fromTurn: null, hasMore: false }
  const startIdx = Math.max(0, eligible.length - limit)
  return { fromTurn: eligible[startIdx], hasMore: startIdx > 0 }
}
