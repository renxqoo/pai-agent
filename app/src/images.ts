/**
 * Wire-level image payload helpers shared by prompt/steer/follow_up
 * (design.md v0.3 image shape validation).
 */

import type { ImagePayload } from "./protocol.ts";

export function toImages(images: ImagePayload[] | undefined): ImagePayload[] | undefined {
  return images && images.length > 0 ? images : undefined;
}

/** Returns the wire-shape error message, or undefined when valid. */
export function validateImages(images: ImagePayload[] | undefined): string | undefined {
  if (images === undefined) return undefined;
  if (!Array.isArray(images)) return "images must be an array";
  for (const image of images) {
    if (
      typeof image !== "object" ||
      image === null ||
      image.type !== "image" ||
      typeof image.data !== "string" ||
      typeof image.mimeType !== "string"
    ) {
      return 'each image must be {type:"image", data:string, mimeType:string}';
    }
  }
  return undefined;
}
