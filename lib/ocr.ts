import { createWorker, Worker } from "tesseract.js";
import type Tesseract from "tesseract.js";

/**
 * A fresh worker takes ~1-2s to spin up (loads the eng.traineddata model),
 * so it's kept alive as a module-level singleton and reused across requests
 * on the same warm server instance, same pattern as getGeminiClient() in
 * geminiClient.ts.
 */
let workerPromise: Promise<Worker> | null = null;

function getWorker(): Promise<Worker> {
  if (!workerPromise) {
    workerPromise = createWorker("eng");
  }
  return workerPromise;
}

export interface OcrResult {
  text: string;
  confidence: number;
}

/** Bounding box from Tesseract (pixel coordinates). */
export interface OcrBBox {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/** A single recognized line with its full metadata. */
export interface OcrLine {
  text: string;
  /** Mean confidence for this line (0-100). */
  confidence: number;
  bbox: OcrBBox;
  /** Individual word tokens for fine-grained analysis. */
  words: Array<{
    text: string;
    confidence: number;
    bbox: OcrBBox;
  }>;
}

/** Rich OCR result containing both the flat text and structured line data. */
export interface OcrRichResult {
  text: string;
  confidence: number;
  lines: OcrLine[];
  /** Pixel dimensions of the source image as reported by Tesseract. */
  imageWidth: number;
  imageHeight: number;
}

/** Runs local Tesseract OCR on a business-card image and returns the raw
 * recognized text plus Tesseract's own 0-100 mean confidence score. */
export async function runOcr(imageBytes: Buffer): Promise<OcrResult> {
  const worker = await getWorker();
  const {
    data: { text, confidence },
  } = await worker.recognize(imageBytes);
  return { text, confidence };
}

/**
 * Flattens the Tesseract Page hierarchy (blocks → paragraphs → lines)
 * into a flat array of OcrLine objects.
 */
function flattenLines(page: Tesseract.Page): OcrLine[] {
  const result: OcrLine[] = [];
  if (!page.blocks) return result;

  for (const block of page.blocks) {
    for (const para of block.paragraphs) {
      for (const line of para.lines) {
        const text = line.text.replace(/\n$/, "").trim();
        if (!text) continue;

        result.push({
          text,
          confidence: line.confidence,
          bbox: {
            x0: line.bbox.x0,
            y0: line.bbox.y0,
            x1: line.bbox.x1,
            y1: line.bbox.y1,
          },
          words: line.words.map((w) => ({
            text: w.text,
            confidence: w.confidence,
            bbox: {
              x0: w.bbox.x0,
              y0: w.bbox.y0,
              x1: w.bbox.x1,
              y1: w.bbox.y1,
            },
          })),
        });
      }
    }
  }
  return result;
}

/**
 * Rich OCR: returns the flat text AND per-line bounding-box / confidence data.
 * Tier 2 (localNlpExtractor) uses the bbox to derive font-size proxies and
 * vertical-position scores for name/company disambiguation.
 */
export async function runOcrRich(imageBytes: Buffer): Promise<OcrRichResult> {
  const worker = await getWorker();
  const { data } = await worker.recognize(imageBytes);

  const lines = flattenLines(data);

  // Derive image dimensions from the outermost block bbox, or fallback to 0
  let imageWidth = 0;
  let imageHeight = 0;
  if (data.blocks && data.blocks.length > 0) {
    for (const block of data.blocks) {
      imageWidth = Math.max(imageWidth, block.bbox.x1);
      imageHeight = Math.max(imageHeight, block.bbox.y1);
    }
  }

  return {
    text: data.text,
    confidence: data.confidence,
    lines,
    imageWidth,
    imageHeight,
  };
}
