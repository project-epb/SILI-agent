import type { ClientOptions, OpenAI } from 'openai'

import {
  ChatCompletionFeatures,
  ChatCompletionOptions,
  ChatMessage,
  StreamChatDelta,
} from './_base'
import { GithubCopilotAI } from './copilot-client'
import { OpenAIProvider } from './openai'

/**
 * GitHub Copilot provider. Copilot speaks the OpenAI protocol, so the entire
 * streaming / tool-call / usage pipeline is inherited from OpenAIProvider —
 * only the underlying client and a one-shot plan probe differ.
 */
export class CopilotProvider extends OpenAIProvider {
  #planDetected?: Promise<void>

  protected createClient(options: ClientOptions): OpenAI {
    return new GithubCopilotAI(options)
  }

  /**
   * Probe the Copilot plan exactly once per process, which switches the
   * client baseURL to the plan-specific endpoint (different endpoints have
   * different rate-limit policies). Best-effort: on failure we keep the
   * default endpoint and let the real request surface auth errors.
   */
  private ensurePlanDetected(): Promise<void> {
    if (!this.#planDetected) {
      this.#planDetected = (this.client as GithubCopilotAI)
        .getCopilotInternalUser()
        .then(() => {})
        .catch(() => {})
    }
    return this.#planDetected
  }

  async *streamChatCompletion(
    messages: ChatMessage[],
    options: ChatCompletionOptions,
    features?: ChatCompletionFeatures
  ): AsyncGenerator<StreamChatDelta, void, unknown> {
    await this.ensurePlanDetected()
    yield* super.streamChatCompletion(messages, options, features)
  }
}
