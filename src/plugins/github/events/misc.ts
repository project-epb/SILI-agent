import type { EventRenderer } from '../types'

/** Shared branch/tag create|delete formatter. */
function renderReference(payload: any, verb: string): string {
  const { repository, ref, ref_type, sender } = payload
  const refName = `${repository.full_name}${ref_type === 'tag' ? '@' : ':'}${ref}`
  return `${sender.login} ${verb} ${ref_type} ${refName}`
}

export const renderCreate: EventRenderer = (payload) => renderReference(payload, 'created')
export const renderDelete: EventRenderer = (payload) => renderReference(payload, 'deleted')

export const renderFork: EventRenderer = (payload) => {
  const { repository, sender, forkee } = payload
  return `${sender.login} forked ${repository.full_name} to ${forkee.full_name} (total ${repository.forks_count} forks)`
}

export const renderMilestone: EventRenderer = (payload) => {
  const { action, repository, milestone, sender } = payload
  if (!['opened', 'closed'].includes(action)) return null
  return `${sender.login} ${action} milestone ${milestone.title} for ${repository.full_name}`
}

export const renderStar: EventRenderer = (payload) => {
  if (payload.action !== 'created') return null
  const { repository, sender } = payload
  return `${sender.login} starred ${repository.full_name} (total ${repository.stargazers_count} stargazers)`
}
