import type { OcrCandidate } from "./enhancement/ocrPolicy";
import type { DetectedBox } from "./detectCards";

type Point = [number, number];
interface BrowserOcrItem { poly: Point[]; text: string; score: number }
export interface BrowserOcrPayload { width: number; height: number; items: BrowserOcrItem[] }

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

export function readBrowserOcrPayload(formData: FormData, field: string): BrowserOcrPayload | null {
  const raw = formData.get(field);
  if (typeof raw !== "string" || raw.length > 250000) return null;

  try {
    const value = JSON.parse(raw) as Partial<BrowserOcrPayload>;
    if (!isFiniteNumber(value.width) || value.width <= 0 || !isFiniteNumber(value.height) || value.height <= 0) return null;
    if (!Array.isArray(value.items)) return null;

    const items = value.items.slice(0, 500).flatMap((item): BrowserOcrItem[] => {
      if (!item || typeof item.text !== "string" || !item.text.trim() || item.text.length > 500) return [];
      if (!isFiniteNumber(item.score) || !Array.isArray(item.poly) || item.poly.length < 4) return [];
      const poly = item.poly.filter((point): point is Point =>
        Array.isArray(point) && point.length === 2 &&
        isFiniteNumber(point[0]) && isFiniteNumber(point[1])
      );
      if (poly.length < 4) return [];
      return [{ poly, text: item.text.trim(), score: Math.max(0, Math.min(1, item.score)) }];
    });
    return { width: value.width, height: value.height, items };
  } catch {
    return null;
  }
}

function candidateFromItems(items: BrowserOcrItem[]): OcrCandidate | null {
  if (!items.length) return null;
  const ordered = [...items].sort((left, right) => {
    const leftY = Math.min(...left.poly.map((point) => point[1]));
    const rightY = Math.min(...right.poly.map((point) => point[1]));
    if (Math.abs(leftY - rightY) > 8) return leftY - rightY;
    return Math.min(...left.poly.map((point) => point[0])) - Math.min(...right.poly.map((point) => point[0]));
  });
  const weight = ordered.reduce((sum, item) => sum + Math.max(1, item.text.length), 0);
  const confidence = ordered.reduce(
    (sum, item) => sum + item.score * Math.max(1, item.text.length),
    0
  ) / weight * 100;
  return { engine: "paddleocr-browser", text: ordered.map((item) => item.text).join("\n"), confidence };
}

export function browserOcrCandidate(payload: BrowserOcrPayload | null): OcrCandidate | null {
  return payload ? candidateFromItems(payload.items) : null;
}

export function browserOcrCandidateForBox(
  payload: BrowserOcrPayload | null,
  box: DetectedBox
): OcrCandidate | null {
  if (!payload) return null;
  const items = payload.items.filter((item) => {
    const centerX = item.poly.reduce((sum, point) => sum + point[0], 0) / item.poly.length;
    const centerY = item.poly.reduce((sum, point) => sum + point[1], 0) / item.poly.length;
    const normalizedX = centerX / payload.width * 1000;
    const normalizedY = centerY / payload.height * 1000;
    return normalizedX >= box.xmin && normalizedX <= box.xmax && normalizedY >= box.ymin && normalizedY <= box.ymax;
  });
  return candidateFromItems(items);
}
