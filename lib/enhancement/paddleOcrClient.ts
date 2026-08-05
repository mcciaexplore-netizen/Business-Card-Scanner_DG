import { DetectedBox } from "../detectCards";
import { OcrResult } from "../ocr";

const OCR_SERVICE_URL = process.env.OCR_SERVICE_URL || "http://127.0.0.1:8000";

/** Checks if the OpenCV + RapidOCR service is healthy and running. */
export async function isOcrServiceAvailable(): Promise<boolean> {
  try {
    const res = await fetch(`${OCR_SERVICE_URL}/health`, {
      method: "GET",
      signal: AbortSignal.timeout(300),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/** Sends card crop to OpenCV + RapidOCR service for deskewing and OCR text recognition. */
export async function runRapidOcr(imageBytes: Buffer): Promise<OcrResult> {
  const formData = new FormData();
  const blob = new Blob([new Uint8Array(imageBytes)], { type: "image/jpeg" });
  formData.append("file", blob, "card.jpg");

  const res = await fetch(`${OCR_SERVICE_URL}/ocr-extract`, {
    method: "POST",
    body: formData,
    signal: AbortSignal.timeout(5000),
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

/** Uses OpenCV contour detection microservice to detect card bounding boxes in a bulk photo. */
export async function detectOpenCvBoxes(imageBytes: Buffer): Promise<DetectedBox[]> {
  const serviceUp = await isOcrServiceAvailable();
  if (!serviceUp) return [];

  try {
    const formData = new FormData();
    const blob = new Blob([new Uint8Array(imageBytes)], { type: "image/jpeg" });
    formData.append("file", blob, "bulk.jpg");

    const res = await fetch(`${OCR_SERVICE_URL}/detect-boxes`, {
      method: "POST",
      body: formData,
      signal: AbortSignal.timeout(3000),
    });

    if (!res.ok) return [];

    const data = (await res.json()) as { boxes?: DetectedBox[] };
    return data.boxes || [];
  } catch {
    return [];
  }
}
