import { ClientOptions, OpenAI } from 'openai'

/**
 * GitHub Copilot AI client.
 *
 * Vendored verbatim from the `github-copilot-ai` package so it links against
 * this project's own `openai@6` (the published package depends on `openai@5`,
 * which would coexist as a second incompatible copy). Logic is unchanged —
 * only the import targets this repo's SDK.
 *
 * @author dragon-fish <dragon-fish@qq.com>
 * @license MIT
 * @see https://github.com/dragon-fish/github-copilot-ai
 */
export class GithubCopilotAI extends OpenAI {
  #copilotInternalUser: CopilotInternalUser | null = null
  #copilotInternalAuth: CopilotInternalAuth | null = null
  static defaultHeaders: Record<string, string> = {
    'copilot-integration-id': 'vscode-chat',
    'editor-plugin-version': 'copilot-chat/0.28.0',
    'editor-version': 'vscode/1.100.0-insider',
    'openai-intent': 'conversation-panel',
    'user-agent': 'GitHubCopilotChat/0.28.0',
  }

  constructor(
    options: ClientOptions & {
      copilotPlan?: 'default' | 'individual' | 'enterprise'
    } = {}
  ) {
    const baseURL = GithubCopilotAI.getBaseURLByPlan(
      options.copilotPlan || 'default'
    )
    super({
      ...options,
      baseURL,
      defaultHeaders: GithubCopilotAI.defaultHeaders,
      fetch: async (url, options) => {
        const auth = await this.getCopilotInternalAuth()
        const request = new Request(url, options)
        request.headers.set('Authorization', `Bearer ${auth.token}`)
        return fetch(request)
      },
    })
  }

  static getBaseURLByPlan(
    copilotPlan: 'individual' | 'enterprise' | string = 'default'
  ): string {
    if (copilotPlan === 'enterprise') {
      return 'https://api.enterprise.githubcopilot.com/'
    } else if (copilotPlan === 'individual') {
      return 'https://api.individual.githubcopilot.com/'
    } else {
      return 'https://api.githubcopilot.com/'
    }
  }

  async getCopilotInternalUser() {
    if (this.#copilotInternalUser && this.#copilotInternalUser.assigned_date) {
      return this.#copilotInternalUser
    }
    const res = await fetch('https://api.github.com/copilot_internal/user', {
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
      },
    }).then((res) => res.json() as Promise<CopilotInternalUser>)
    return this.setCopilotInternalUser(res)!
  }
  setCopilotInternalUser(user: null): null
  setCopilotInternalUser(user: CopilotInternalUser): CopilotInternalUser | null
  setCopilotInternalUser(
    user: CopilotInternalUser | null
  ): CopilotInternalUser | null {
    if (!user) {
      this.#copilotInternalUser = null
      return null
    }
    if (!user.assigned_date) {
      throw new Error('Invalid payload', { cause: user })
    }
    this.#copilotInternalUser = user
    this.baseURL = GithubCopilotAI.getBaseURLByPlan(
      user.copilot_plan || 'default'
    )
    return this.#copilotInternalUser
  }

  async getCopilotInternalAuth() {
    if (
      this.#copilotInternalAuth &&
      this.#copilotInternalAuth.expires_at > Date.now() / 1000
    ) {
      return this.#copilotInternalAuth
    }
    const res = await fetch(
      'https://api.github.com/copilot_internal/v2/token',
      {
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
        },
      }
    ).then((res) => res.json() as Promise<CopilotInternalAuth>)
    return this.setCopilotInternalAuth(res)!
  }
  setCopilotInternalAuth(
    auth: CopilotInternalAuth | null
  ): CopilotInternalAuth | null {
    if (!auth) {
      this.#copilotInternalAuth = null
      return null
    }
    if (!auth.token || !auth.expires_at) {
      throw new Error('Invalid payload', { cause: auth })
    }
    if (Date.now() / 1000 > auth.expires_at) {
      this.#copilotInternalAuth = null
      return null
    }
    this.#copilotInternalAuth = auth
    return this.#copilotInternalAuth
  }
}

export interface CopilotInternalUser {
  access_type_sku: string
  analytics_tracking_id: string
  assigned_date: string
  can_signup_for_limited: boolean
  chat_enabled: boolean
  copilot_plan: 'default' | 'individual' | 'enterprise'
  organization_login_list: unknown[]
  organization_list: unknown[]
}

export interface CopilotInternalAuth {
  annotations_enabled: boolean
  chat_enabled: boolean
  chat_jetbrains_enabled: boolean
  code_quote_enabled: boolean
  code_review_enabled: boolean
  codesearch: boolean
  copilotignore_enabled: boolean
  endpoints: {
    api: string
    'origin-tracker': string
    proxy: string
    telemetry: string
  }
  expires_at: number
  individual: boolean
  limited_user_quotas: null | any
  limited_user_reset_date: null | string
  prompt_8k: boolean
  public_suggestions: string
  refresh_in: number
  sku: string
  snippy_load_test_enabled: boolean
  telemetry: string
  token: string
  tracking_id: string
  vsc_electron_fetcher_v2: boolean
  xcode: boolean
  xcode_chat: boolean
}
