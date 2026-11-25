import type { EncodedImage } from './image-store'

/** Image tokens grow with pixels; a cap on area (not the long edge) keeps the text on tall comic strips readable. */
export const MAX_IMAGE_PIXELS = 2_400_000

/**
 * Downscale to at most MAX_IMAGE_PIXELS keeping the aspect ratio, and
 * re-encode as WebP q85; an animated GIF keeps its first frame. Uses Bun's
 * built-in Bun.Image — no sharp/libvips.
 */
export async function encodeImage(bytes: Uint8Array): Promise<EncodedImage> {
  const BunImage = (globalThis as any).Bun?.Image
  if (!BunImage) throw new Error('Bun.Image is unavailable in this runtime')
  const meta = await new BunImage(bytes).metadata()
  const scale = Math.min(1, Math.sqrt(MAX_IMAGE_PIXELS / (meta.width * meta.height)))
  const width = Math.max(1, Math.floor(meta.width * scale))
  const height = Math.max(1, Math.floor(meta.height * scale))
  let img = new BunImage(bytes)
  if (scale < 1) img = img.resize(width, height)
  const out: Uint8Array = await img.webp({ quality: 85 }).bytes()
  return { bytes: out, width, height }
}
