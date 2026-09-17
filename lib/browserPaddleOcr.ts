"use client";

import type { OcrResult, OcrResultItem } from "@paddleocr/paddleocr-js";

export interface BrowserPaddleOcrPayload {
  width: number;
  height: number;
  items: Array<Pick<OcrResultItem, "poly" | "text" | "score">>;
}

const BROWSER_OCR_TIMEOUT_MS = 30000;
let enginePromise: Promise<Awaited<ReturnType<typeof createEngine>>> | null = null;

export interface BrowserOcrCapabilities {
  userAgent?: string;
  platform?: string;
  maxTouchPoints?: number;
  deviceMemory?: number;
  mobile?: boolean;
}

export function isMemoryConstrainedBrowser(capabilities: BrowserOcrCapabilities): boolean {
  const userAgent = capabilities.userAgent || "";
  const platform = capabilities.platform || "";
  const appleTouchDevice = platform === "MacIntel" &&
    (capabilities.maxTouchPoints || 0) > 1;
  const mobileDevice = Boolean(capabilities.mobile) || appleTouchDevice ||
    /Android|iPad|iPhone|iPod|Mobile/i.test(`${userAgent} ${platform}`);
  const lowMemoryDevice = typeof capabilities.deviceMemory === "number" &&
    capabilities.deviceMemory < 8;
  return mobileDevice || lowMemoryDevice;
}

/**
 * Paddle's model, WebAssembly heap and decoded images can exceed Mobile
 * WebKit's per-tab memory ceiling. Browser OCR is therefore a desktop-only
 * optimization; the server pipeline remains the extraction fallback.
 */
export function isBulkBrowserOcrSafe(capabilities: BrowserOcrCapabilities): boolean {
  return !isMemoryConstrainedBrowser(capabilities);
}

function currentBrowserCapabilities(): BrowserOcrCapabilities | null {
  if (typeof navigator === "undefined") return null;
  const browserNavigator = navigator as Navigator & {
    deviceMemory?: number;
    userAgentData?: { mobile?: boolean };
  };
  return {
    userAgent: browserNavigator.userAgent,
    platform: browserNavigator.platform,
    maxTouchPoints: browserNavigator.maxTouchPoints,
    deviceMemory: browserNavigator.deviceMemory,
    mobile: browserNavigator.userAgentData?.mobile,
  };
}

export function canRunBrowserPaddleOcr(): boolean {
  const capabilities = currentBrowserCapabilities();
  return capabilities !== null && !isMemoryConstrainedBrowser(capabilities);
}

export function canRunBulkBrowserPaddleOcr(): boolean {
  return canRunBrowserPaddleOcr();
}

/** Avoid asking Mobile Safari to decode and retain a full-resolution photo. */
export function shouldUseMemorySafeImageFlow(): boolean {
  const capabilities = currentBrowserCapabilities();
  return capabilities === null || isMemoryConstrainedBrowser(capabilities);
}

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
