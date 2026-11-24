export interface QQJoinVerificationInfo {
  verify_message?: string
  review_qa_list?: { question: string; answer: string }[]
}

export function joinRequestAnswerText(
  source?: QQJoinVerificationInfo | string
) {
  if (typeof source === 'string') return source.split('答案：').pop().trim()

  // QQ can send an empty verify_message alongside populated Q&A answers.
  return [
    source?.verify_message ?? '',
    ...(source?.review_qa_list ?? []).map(({ answer }) => answer),
  ].join('\n')
}
