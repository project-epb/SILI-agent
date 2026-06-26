// Inline workflow JSON builders for comfy-ui template-loader tests.
// Replaces Hermes' external anima_boilerplate.json dependency.

// A minimal but complete txt2img workflow (API-format), covering topology trace.
export function minimalWorkflow(): Record<string, any> {
  return {
    '4': { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: 'anima.safetensors' } },
    '6': { class_type: 'CLIPTextEncode', inputs: { text: 'masterpiece, 1girl', clip: ['4', 1] }, _meta: { title: 'Positive Prompt' } },
    '7': { class_type: 'CLIPTextEncode', inputs: { text: 'low quality, worst quality, bad anatomy', clip: ['4', 1] }, _meta: { title: 'Negative Prompt' } },
    '5': { class_type: 'EmptyLatentImage', inputs: { width: 832, height: 1216, batch_size: 1 } },
    '3': { class_type: 'KSampler', inputs: { seed: 123, steps: 28, cfg: 5, sampler_name: 'euler', scheduler: 'normal', denoise: 1, model: ['4', 0], positive: ['6', 0], negative: ['7', 0], latent_image: ['5', 0] } },
    '8': { class_type: 'VAEDecode', inputs: { samples: ['3', 0], vae: ['4', 2] } },
    '9': { class_type: 'SaveImage', inputs: { images: ['8', 0] } },
  }
}

// A workflow with one dangling LoraLoader (model/clip ports unconnected), for LoRA pool tests.
export function workflowWithDanglingLora(): Record<string, any> {
  const wf = minimalWorkflow()
  wf['20'] = { class_type: 'LoraLoader', inputs: { lora_name: 'detail.safetensors', strength_model: 0.8, strength_clip: 0.8 } }
  return wf
}

// Minimal "no LoRA" workflow: ckpt -> KSampler + 2x CLIPTextEncode (ported from Hermes _base()).
// Node ids match the Hermes lora_minimal fixture so the ported LoRA tests line up.
export function workflowNoLora(): Record<string, any> {
  return {
    '1': { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: 'test.safetensors' }, _meta: { title: 'ckpt' } },
    '2': { class_type: 'CLIPTextEncode', inputs: { text: 'pos prompt', clip: ['1', 1] }, _meta: { title: 'Positive' } },
    '3': { class_type: 'CLIPTextEncode', inputs: { text: 'neg prompt', clip: ['1', 1] }, _meta: { title: 'Negative' } },
    '4': { class_type: 'EmptyLatentImage', inputs: { width: 512, height: 512, batch_size: 1 } },
    '5': {
      class_type: 'KSampler',
      inputs: {
        seed: 0, steps: 20, cfg: 7.0, sampler_name: 'euler', scheduler: 'normal', denoise: 1.0,
        model: ['1', 0], positive: ['2', 0], negative: ['3', 0], latent_image: ['4', 0],
      },
    },
    '6': { class_type: 'VAEDecode', inputs: { samples: ['5', 0], vae: ['1', 2] } },
    '7': { class_type: 'SaveImage', inputs: { images: ['6', 0], filename_prefix: 'test' } },
  }
}

// Two unconnected LoraLoader nodes; main path identical to no-lora baseline.
export function workflowDanglingPool(): Record<string, any> {
  const api = workflowNoLora()
  api['100'] = {
    class_type: 'LoraLoader',
    inputs: { lora_name: 'loraA.safetensors', strength_model: 0.8, strength_clip: 0.8 },
    _meta: { title: 'lora A (dangling)' },
  }
  api['101'] = {
    class_type: 'LoraLoader',
    inputs: { lora_name: 'loraB.safetensors', strength_model: 0.5, strength_clip: 0.5 },
    _meta: { title: 'lora B (dangling)' },
  }
  return api
}

// A LoraLoader already wired into the main path -> template is author-locked.
export function workflowLocked(): Record<string, any> {
  const api = workflowNoLora()
  api['100'] = {
    class_type: 'LoraLoader',
    inputs: {
      lora_name: 'preWired.safetensors', strength_model: 0.6, strength_clip: 0.6,
      model: ['1', 0], clip: ['1', 1],
    },
    _meta: { title: 'pre-wired lora' },
  }
  api['2'].inputs.clip = ['100', 1]
  api['3'].inputs.clip = ['100', 1]
  api['5'].inputs.model = ['100', 0]
  return api
}

// A wired LoraLoader plus an unconnected one -> still locked.
export function workflowMixedLockedAndDangling(): Record<string, any> {
  const api = workflowLocked()
  api['200'] = {
    class_type: 'LoraLoader',
    inputs: { lora_name: 'extra.safetensors', strength_model: 0.4, strength_clip: 0.4 },
    _meta: { title: 'dangling on top of locked' },
  }
  return api
}

// Variant where clip comes from a separate DualCLIPLoader (model_source != clip_source).
export function workflowDanglingPoolViaDualClip(): Record<string, any> {
  const api = workflowNoLora()
  api['1'] = {
    class_type: 'UNETLoader',
    inputs: { unet_name: 'model.gguf', weight_dtype: 'default' },
    _meta: { title: 'unet' },
  }
  api['10'] = {
    class_type: 'DualCLIPLoader',
    inputs: { clip_name1: 'clip_l.safetensors', clip_name2: 't5xxl.safetensors', type: 'sdxl' },
    _meta: { title: 'clip' },
  }
  api['2'].inputs.clip = ['10', 0]
  api['3'].inputs.clip = ['10', 0]
  api['100'] = {
    class_type: 'LoraLoader',
    inputs: { lora_name: 'loraC.safetensors', strength_model: 0.7, strength_clip: 0.7 },
    _meta: { title: 'lora C (dangling, dual clip)' },
  }
  return api
}
