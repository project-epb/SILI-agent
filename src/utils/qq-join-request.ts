export interface QQJoinVerificationInfo {
  verify_message?: string
  review_qa_list?: { question: string; answer: string }[]
}

/** QQ can send both fields, including an empty verify_message beside a Q&A list. */
export function joinRequestAnswerText(info?: QQJoinVerificationInfo) {
  return [
    info?.verify_message ?? '',
    ...(info?.review_qa_list ?? []).map(({ answer }) => answer),
  ].join('\n')
}
