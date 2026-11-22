import type { Session } from 'koishi'

/** Chat sessions observe these user fields; Session's generic does not say so. */
const userOf = (s: Session) => s.user as { id?: number; name?: string } | undefined

const KEY = 'turnSpeakers'

/**
 * Everyone whose message is in this turn — the starter, steered-in messages
 * and the backlog — keyed by Koishi uid (`turn_context.koishi.uid`), so a
 * command runs as the person it is for. Task notifications are no one's.
 */
export function turnSpeakers(turnState: Record<string, unknown>): Map<string, Session> {
  let speakers = turnState[KEY] as Map<string, Session> | undefined
  if (!speakers) turnState[KEY] = speakers = new Map()
  return speakers
}

export function addTurnSpeaker(turnState: Record<string, unknown>, session: Session) {
  const uid = userOf(session)?.id
  if (uid === undefined) return
  const speakers = turnSpeakers(turnState)
  if (!speakers.has(String(uid))) speakers.set(String(uid), session)
}

export function describeSpeaker(uid: string, session: Session): string {
  const name = userOf(session)?.name || session.event?.member?.nick || session.event?.user?.name || session.userId
  return `${name}（uid ${uid}）`
}

/**
 * The session a command in this turn runs with. With one speaker `asUid` may
 * be left out; with two or more it must name one of them, or the command
 * would act on whoever happened to start the turn.
 */
export function pickSpeaker(
  turnState: Record<string, unknown>,
  fallback: Session,
  asUid: unknown
): { uid: string; session: Session } | { error: string } {
  const speakers = turnSpeakers(turnState)
  const list = () =>
    [...speakers].map(([uid, s]) => `- ${describeSpeaker(uid, s)}`).join('\n')
  if (asUid === undefined || asUid === null || asUid === '') {
    if (speakers.size >= 2)
      return {
        error: `Error: more than one person spoke in this turn, so \`as_uid\` is required. Pick the person this command is for:\n${list()}`,
      }
    const [only] = speakers
    return only ? { uid: only[0], session: only[1] } : { uid: String(userOf(fallback)?.id ?? fallback.userId), session: fallback }
  }
  const session = speakers.get(String(asUid))
  if (!session)
    return {
      error: `Error: uid ${asUid} has not spoken in this turn. \`as_uid\` must be one of:\n${list()}`,
    }
  return { uid: String(asUid), session }
}
