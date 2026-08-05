import { Jimp, JimpMime } from "jimp";
import { getGeminiClient, GEMINI_MODEL, detectMimeType } from "./geminiClient";

/**
 * This replaces the previous OpenCV-based card_detector.py entirely.
 * Instead of contour detection, Gemini itself is asked to find the
 * bounding box of every card in the photo (a documented Gemini vision
 * capability), and jimp - a pure-JavaScript image library with zero
 * native dependencies - crops each region out of the original
 * full-resolution image so extraction still runs on a sharp, individual
 * crop per card, same as the original architecture.
 *
 * jimp was chosen over `sharp` specifically because sharp ships native
 * platform binaries that are a common source of "works locally, breaks
 * on Vercel" deployment failures; jimp has none of that risk.
 */

const DETECTION_PROMPT = `Look at this image, which contains multiple business
cards laid out (possibly 20-30 or more), photographed together. Identify
the bounding box of EVERY individual business card visible in the image,
however many there are.

Return a JSON array, one object per card, in this exact shape:
[{ "box_2d": [ymin, xmin, ymax, xmax] }, ...]

Rules:
- Coordinates are normalized to a 0-1000 scale, where [0,0] is the
  top-left corner of the image and [1000,1000] is the bottom-right.
- ymin/xmin is the top-left corner of the card, ymax/xmax is the
  bottom-right corner.
- Include every card, even ones that are rotated, at an angle, or
  partially cut off at the edge of the photo.
- Do not merge two adjacent cards into one box - each card gets its own
  box.
- If you can't find any cards, return an empty array [].
`;

const BOX_SCHEMA = {
  type: "array",
  items: {
    type: "object",
    properties: {
      box_2d: {
        type: "array",
        items: { type: "number" },
      },
    },
    required: ["box_2d"],
  },
};

export interface DetectedBox {
  ymin: number;
  xmin: number;
  ymax: number;
  xmax: number;
}

import { detectOpenCvBoxes } from "./enhancement/paddleOcrClient";

export async function detectCardBoxes(imageBytes: Buffer): Promise<DetectedBox[]> {
  try {
    const openCvBoxes = await detectOpenCvBoxes(imageBytes);
    if (openCvBoxes && openCvBoxes.length > 0) {
      console.log(`[detectCardBoxes] OpenCV detected ${openCvBoxes.length} card(s) locally (Cost: ₹0.00)`);
      return openCvBoxes;
    }
  } catch (e) {
    console.log(`[detectCardBoxes] OpenCV box detection failed (${e}), falling back to Gemini Vision`);
  }

  const ai = getGeminiClient();
  const mimeType = detectMimeType(imageBytes);

  const response = await ai.models.generateContent({
    model: GEMINI_MODEL,
    contents: [
      { inlineData: { mimeType, data: imageBytes.toString("base64") } },
      { text: DETECTION_PROMPT },
    ],
    config: {
      responseMimeType: "application/json",
      responseSchema: BOX_SCHEMA,
    },
  });

  const text = response.text ?? "[]";
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error(`Could not parse Gemini's card-detection response as JSON: ${text}`);
  }

  if (!Array.isArray(raw)) return [];

  const boxes: DetectedBox[] = [];
  for (const item of raw) {
    const box = (item as { box_2d?: unknown })?.box_2d;
    if (!Array.isArray(box) || box.length !== 4) continue;
    const [ymin, xmin, ymax, xmax] = box as number[];
    if ([ymin, xmin, ymax, xmax].some((n) => typeof n !== "number" || Number.isNaN(n))) continue;
    if (ymax <= ymin || xmax <= xmin) continue;
    boxes.push({ ymin, xmin, ymax, xmax });
  }
  return boxes;
}

/** Crops one detected card out of the full-resolution original image,
 * with a small padding margin so text right at the card edge doesn't
 * get clipped. Returns a JPEG buffer, ready for extractCardFields(). */
export async function cropCard(imageBytes: Buffer, box: DetectedBox): Promise<Buffer> {
  const image = await Jimp.read(imageBytes);
  const width = image.width;
  const height = image.height;

  const padFrac = 0.02;
  const yPad = (box.ymax - box.ymin) * padFrac;
  const xPad = (box.xmax - box.xmin) * padFrac;

  const x0 = Math.max(0, Math.round(((box.xmin - xPad) / 1000) * width));
  const y0 = Math.max(0, Math.round(((box.ymin - yPad) / 1000) * height));
  const x1 = Math.min(width, Math.round(((box.xmax + xPad) / 1000) * width));
  const y1 = Math.min(height, Math.round(((box.ymax + yPad) / 1000) * height));

  const w = Math.max(1, x1 - x0);
  const h = Math.max(1, y1 - y0);

  image.crop({ x: x0, y: y0, w, h });
  const buffer = await image.getBuffer(JimpMime.jpeg);
  return Buffer.from(buffer);
}
