// HTTP shorthand methods (http.get / http.post) in @cordisjs/plugin-http return
// the decoded response body directly — not an HTTP.Response wrapper. Only the
// main invocation signature http(url, config) returns a full HTTP.Response.
// This file therefore treats every shorthand return value as the body itself.
import type { HTTP } from '@cordisjs/plugin-http'

/**
 * Error classification for ComfyUI client operations.
 * - cf_access: 401/403 from Cloudflare edge — token missing/invalid/policy issue.
 * - comfyui_validation: 400 from ComfyUI, or a failed workflow execution.
 * - timeout: request timed out (ETIMEDOUT) or polling deadline exceeded.
 * - network: the request itself could not be made (DNS, refused, etc).
 * - comfyui_error: any other unexpected HTTP/response error.
 */
export type ComfyErrorType =
  | 'cf_access'
  | 'comfyui_validation'
  | 'timeout'
  | 'network'
  | 'comfyui_error'

export class ComfyError extends Error {
  type: ComfyErrorType
  constructor(message: string, type: ComfyErrorType) {
    super(message)
    this.name = 'ComfyError'
    this.type = type
  }
}

/**
 * Thin wrapper around the ComfyUI HTTP API, built on koishi's `ctx.http`.
 *
 * The injected `http` is expected to already carry `baseURL` / auth headers /
 * timeout (via `ctx.http.extend(config.http)`), so this client only deals with
 * paths relative to the base.
 */
export class ComfyUIClient {
  constructor(private http: HTTP) {}

  /**
   * Classify a thrown error into a ComfyError. Maps HTTP status codes and
   * transport-level error codes onto ComfyErrorType.
   */
  private toComfyError(e: any): ComfyError {
    if (this.http.isError(e)) {
      const status = e.response?.status
      if (status === 401 || status === 403) {
        return new ComfyError(
          `HTTP ${status}: cloudflare access denied (token/policy issue)`,
          'cf_access'
        )
      }
      if (status === 400) {
        return new ComfyError(`HTTP 400 from ComfyUI: ${e.message}`, 'comfyui_validation')
      }
      if (e.code === 'ETIMEDOUT') {
        return new ComfyError(`request timed out: ${e.message}`, 'timeout')
      }
      if (status === undefined) {
        return new ComfyError(`network error: ${e.message}`, 'network')
      }
      return new ComfyError(`HTTP ${status}: ${e.message}`, 'comfyui_error')
    }
    if (e instanceof ComfyError) return e
    return new ComfyError(String(e?.message ?? e), 'comfyui_error')
  }

  /** POST /prompt with the workflow. Returns the assigned prompt_id. */
  async submit(apiFormat: Record<string, any>, clientId: string): Promise<string> {
    let body: Record<string, any>
    try {
      body = await this.http.post('/prompt', {
        prompt: apiFormat,
        client_id: clientId,
      })
    } catch (e) {
      throw this.toComfyError(e)
    }
    const pid = body?.prompt_id
    if (typeof pid !== 'string' || !pid) {
      throw new ComfyError(
        `/prompt response missing prompt_id: ${JSON.stringify(body)}`,
        'comfyui_error'
      )
    }
    return pid
  }

  /**
   * Poll /history/{prompt_id} until it reports status_str === 'success' or the
   * timeout deadline is reached.
   *
   * Returns the history entry dict (with 'status', 'outputs', 'prompt' keys).
   * Throws ComfyError('timeout') if not completed in time.
   * Throws ComfyError('comfyui_validation') if the workflow execution failed.
   */
  async pollUntilDone(
    promptId: string,
    timeoutS: number,
    intervalS = 2.0
  ): Promise<Record<string, any>> {
    const deadline = Date.now() + timeoutS * 1000
    const path = '/history/' + encodeURIComponent(promptId)
    while (true) {
      let history: Record<string, any>
      try {
        history = await this.http.get(path)
      } catch (e) {
        throw this.toComfyError(e)
      }
      const entry =
        history && typeof history === 'object' ? (history as any)[promptId] : undefined
      if (entry) {
        const st = entry.status ?? {}
        const statusStr = st.status_str
        if (statusStr === 'success') {
          return entry
        }
        if (statusStr === 'error') {
          const msgs = st.messages ?? []
          throw new ComfyError(
            `workflow execution failed: status=${JSON.stringify(statusStr)} messages=${JSON.stringify(msgs)}`,
            'comfyui_validation'
          )
        }
        // any other state (null / "partial" / future values) → keep polling
      }
      if (Date.now() >= deadline) {
        throw new ComfyError(
          `prompt ${promptId} did not complete in ${timeoutS}s`,
          'timeout'
        )
      }
      await new Promise((r) => setTimeout(r, intervalS * 1000))
    }
  }

  /** GET /view?filename=...&subfolder=...&type=... → raw image bytes. */
  async fetchImage(p: {
    filename: string
    subfolder: string
    type: string
  }): Promise<ArrayBuffer> {
    try {
      return await this.http.get('/view', {
        params: { filename: p.filename, subfolder: p.subfolder, type: p.type },
        responseType: 'arraybuffer',
      })
    } catch (e) {
      throw this.toComfyError(e)
    }
  }
}
