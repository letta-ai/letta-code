// Public package entrypoint for the shared image resize: fits an image within
// the model-provider dimension and 5MB base64 limits before it is sent.
// Runs Sharp in a child worker (`image-resize-worker.js`, shipped beside this
// bundle), so it is Node-only.
export type { ResizeResult } from "./utils/image-resize";
export {
  MAX_IMAGE_BYTES,
  MAX_IMAGE_HEIGHT,
  MAX_IMAGE_WIDTH,
  resizeImageIfNeeded,
} from "./utils/image-resize";
