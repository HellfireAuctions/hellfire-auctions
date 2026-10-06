import { imageSize } from "./image-size.js";

// Every auction photo is square (1:1), so photos line up in any theme's grid and can never overlap or stretch.
// The upload form crops each photo to a square in the browser; the server refuses anything that still isn't square.
export const PHOTO_SIDE = 1600; // the longest side stored, in pixels
export const SQUARE_TOLERANCE = 0.01;
export const SQUARE_MESSAGE = "Photos must be square (1:1) so they line up in every theme. Please choose the photos again; the form crops them for you.";
export const UNREADABLE_MESSAGE = "We couldn't read one of the photos. Please use JPG, PNG, WebP or GIF images.";

// The centred square inside a width x height photo.
export function squareCrop(width, height) {
  const side = Math.min(width, height);
  return { sx: Math.floor((width - side) / 2), sy: Math.floor((height - side) / 2), side };
}

// The size the square is saved at: never enlarged, never bigger than PHOTO_SIDE.
export function outputSide(side, max = PHOTO_SIDE) {
  return Math.max(1, Math.min(side, max));
}

export function isSquare(width, height, tolerance = SQUARE_TOLERANCE) {
  return width > 0 && height > 0 && Math.abs(width / height - 1) <= tolerance;
}

// Server-side check of uploaded files. Returns a message for the merchant, or null when every photo is square.
export async function photoProblem(files) {
  for (const file of files) {
    const head = new Uint8Array(await file.slice(0, 262144).arrayBuffer());
    const size = imageSize(head);
    if (!size) return UNREADABLE_MESSAGE;
    if (!isSquare(size.width, size.height)) return SQUARE_MESSAGE;
  }
  return null;
}
