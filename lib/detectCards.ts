import { Jimp, JimpMime } from "jimp";
import { getGeminiClient, GEMINI_MODEL, detectMimeType } from "./geminiClient";

// OpenCV detects boxes when the OCR sidecar is available. Gemini detects them
// otherwise, and pure-JavaScript Jimp crops each full-resolution card.

const DETECTION_PROMPT = `Look at this image, which contains multiple business
cards laid out (usually 1-10, but possibly more), photographed together. Identify
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
- Return exactly ONE tight box for each physical card. Never return alternate,
  nested, or slightly shifted boxes for the same card.
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

function boxArea(box: DetectedBox): number {
  return Math.max(0, box.ymax - box.ymin) * Math.max(0, box.xmax - box.xmin);
}

function overlapRatios(left: DetectedBox, right: DetectedBox) {
  const width = Math.max(0, Math.min(left.xmax, right.xmax) - Math.max(left.xmin, right.xmin));
  const height = Math.max(0, Math.min(left.ymax, right.ymax) - Math.max(left.ymin, right.ymin));
  const intersection = width * height;
  const leftArea = boxArea(left);
  const rightArea = boxArea(right);
  const union = leftArea + rightArea - intersection;
  return {
    iou: union > 0 ? intersection / union : 0,
    containment: Math.min(leftArea, rightArea) > 0 ? intersection / Math.min(leftArea, rightArea) : 0,
  };
}

function haveSameCenter(left: DetectedBox, right: DetectedBox): boolean {
  const leftWidth = left.xmax - left.xmin;
  const rightWidth = right.xmax - right.xmin;
  const leftHeight = left.ymax - left.ymin;
  const rightHeight = right.ymax - right.ymin;
  const leftCenterX = (left.xmin + left.xmax) / 2;
  const rightCenterX = (right.xmin + right.xmax) / 2;
  const leftCenterY = (left.ymin + left.ymax) / 2;
  const rightCenterY = (right.ymin + right.ymax) / 2;
  const areaRatio = Math.min(boxArea(left), boxArea(right)) / Math.max(boxArea(left), boxArea(right));
  return areaRatio >= 0.45 &&
    Math.abs(leftCenterX - rightCenterX) <= Math.min(leftWidth, rightWidth) * 0.28 &&
    Math.abs(leftCenterY - rightCenterY) <= Math.min(leftHeight, rightHeight) * 0.28;
}

/** Removes repeated or nested detections before they create duplicate OCR charges. */
export function deduplicateDetectedBoxes(boxes: DetectedBox[]): DetectedBox[] {
  const largestFirst = [...boxes].sort((left, right) => boxArea(right) - boxArea(left));
  return largestFirst.filter((box, index) =>
    !largestFirst.slice(0, index).some((kept) => {
      const overlap = overlapRatios(box, kept);
      return overlap.iou >= 0.42 || overlap.containment >= 0.75 || haveSameCenter(box, kept);
    })
  );
}

import { detectOpenCvBoxes } from "./enhancement/rapidOcrClient";

export async function detectCardBoxes(imageBytes: Buffer): Promise<DetectedBox[]> {
  try {
    const openCvBoxes = await detectOpenCvBoxes(imageBytes);
    if (openCvBoxes && openCvBoxes.length > 0) {
      console.log(`[detectCardBoxes] OpenCV detected ${openCvBoxes.length} card(s) locally (Cost: ₹0.00)`);
      return deduplicateDetectedBoxes(openCvBoxes);
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
      temperature: 0,
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
  return deduplicateDetectedBoxes(boxes);
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
