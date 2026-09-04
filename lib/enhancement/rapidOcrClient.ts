import { DetectedBox } from "../detectCards";
import { OcrResult } from "../ocr";

// RapidOCR is opt-in. An unset URL means the deployment intentionally uses
// Gemini fallbacks without making a pointless localhost request on Vercel.
const OCR_SERVICE_URL = process.env.OCR_SERVICE_URL?.trim().replace(/\/+$/, "");

function requireOcrServiceUrl(): string {
  if (!OCR_SERVICE_URL) {
    throw new Error("OCR_SERVICE_URL is not configured.");
  }
  return OCR_SERVICE_URL;
}

/** Checks if the OpenCV + RapidOCR service is healthy and running. */
export async function isOcrServiceAvailable(): Promise<boolean> {
  if (!OCR_SERVICE_URL) return false;
  try {
    const res = await fetch(`${OCR_SERVICE_URL}/health`, {
      method: "GET",
      signal: AbortSignal.timeout(2000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/** Sends a card crop to the sidecar for OpenCV deskewing and RapidOCR. */
export async function runRapidOcr(imageBytes: Buffer): Promise<OcrResult> {
  const serviceUrl = requireOcrServiceUrl();
  const formData = new FormData();
  const blob = new Blob([new Uint8Array(imageBytes)], { type: "image/jpeg" });
  formData.append("file", blob, "card.jpg");

  const res = await fetch(`${serviceUrl}/ocr-extract`, {
    method: "POST",
    body: formData,
    signal: AbortSignal.timeout(10000),
  });

  if (!res.ok) {
    throw new Error(`OCR service returned HTTP ${res.status}`);
  }

  const data = (await res.json()) as { text?: string; confidence?: number };
  return {
    text: data.text || "",
    confidence: data.confidence || 0,
  };
}

/** Uses the OpenCV sidecar to detect card bounding boxes in a bulk photo. */
export async function detectOpenCvBoxes(imageBytes: Buffer): Promise<DetectedBox[]> {
  const serviceUp = await isOcrServiceAvailable();
  if (!serviceUp) return [];

  try {
    const formData = new FormData();
    const blob = new Blob([new Uint8Array(imageBytes)], { type: "image/jpeg" });
    formData.append("file", blob, "bulk.jpg");

    const res = await fetch(`${requireOcrServiceUrl()}/detect-boxes`, {
      method: "POST",
      body: formData,
      signal: AbortSignal.timeout(5000),
    });

    if (!res.ok) return [];

    const data = (await res.json()) as { boxes?: DetectedBox[] };
    return data.boxes || [];
  } catch {
    return [];
  }
}
