"use client";

import type { OcrResult, OcrResultItem } from "@paddleocr/paddleocr-js";

export interface BrowserPaddleOcrPayload {
  width: number;
  height: number;
  items: Array<Pick<OcrResultItem, "poly" | "text" | "score">>;
}

const BROWSER_OCR_TIMEOUT_MS = 30000;
let enginePromise: Promise<Awaited<ReturnType<typeof createEngine>>> | null = null;

async function createEngine() {
  const { PaddleOCR } = await import("@paddleocr/paddleocr-js");
  return PaddleOCR.create({
    lang: "en",
    ocrVersion: "PP-OCRv5",
    worker: true,
    ortOptions: { backend: "wasm", numThreads: 1, simd: true },
  });
}

function getEngine() {
  if (!enginePromise) {
    enginePromise = createEngine().catch((error) => {
      enginePromise = null;
      throw error;
    });
  }
  return enginePromise;
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timeout = window.setTimeout(() => reject(new Error("Browser OCR timed out")), timeoutMs);
    promise.then(
      (value) => { window.clearTimeout(timeout); resolve(value); },
      (error) => { window.clearTimeout(timeout); reject(error); }
    );
  });
}

function compactResult(result: OcrResult): BrowserPaddleOcrPayload {
  return {
    width: result.image.width,
    height: result.image.height,
    items: result.items
      .filter((item) => item.text.trim())
      .slice(0, 500)
      .map((item) => ({
        poly: item.poly,
        text: item.text.trim().slice(0, 500),
        score: Math.max(0, Math.min(1, item.score)),
      })),
  };
}

/** Browser OCR is best-effort: any failure leaves the server pipeline unchanged. */
export async function runBrowserPaddleOcrBatch(
  files: File[]
): Promise<Array<BrowserPaddleOcrPayload | null>> {
  try {
    const engine = await withTimeout(getEngine(), BROWSER_OCR_TIMEOUT_MS);
    const results = await withTimeout(
      engine.predict(files, { textRecScoreThresh: 0.3 }),
      BROWSER_OCR_TIMEOUT_MS
    );
    return files.map((_, index) => results[index] ? compactResult(results[index]) : null);
  } catch (error) {
    console.warn("[PaddleOCR.js] Browser OCR unavailable; using the server pipeline", error);
    return files.map(() => null);
  }
}

export async function runBrowserPaddleOcr(file: File): Promise<BrowserPaddleOcrPayload | null> {
  return (await runBrowserPaddleOcrBatch([file]))[0] ?? null;
}

export function appendBrowserOcr(
  formData: FormData,
  field: string,
  payload: BrowserPaddleOcrPayload | null
): void {
  if (payload?.items.length) formData.append(field, JSON.stringify(payload));
}
