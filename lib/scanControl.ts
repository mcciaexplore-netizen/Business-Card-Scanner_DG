import { createHash, randomUUID } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";

type ScanMode = "single" | "double" | "bulk";

const CLIENT_COOKIE = "aurascan_client";
const CONTROL_TIMEOUT_MS = 3000;
const DUPLICATE_WINDOW_SECONDS = 10 * 60;

interface DuplicateClaim {
  allowed: boolean;
  imageHash?: string;
  retryAfterSeconds?: number;
}

declare global {
  var auraScanRecentImages: Map<string, number> | undefined;
}

const recentImages = globalThis.auraScanRecentImages ?? new Map<string, number>();
globalThis.auraScanRecentImages = recentImages;

interface ScanPermit {
  allowed: boolean;
  requestId: string;
  clientId: string;
  shouldSetClientCookie: boolean;
  retryAfterSeconds?: number;
  reason?: string;
  bulkLeaseId?: string;
}

function getClientIdentity(req: NextRequest) {
  const existing = req.cookies.get(CLIENT_COOKIE)?.value;
  return {
    clientId: existing || randomUUID(),
    shouldSetClientCookie: !existing,
  };
}

function getHashedIp(req: NextRequest): string {
  const forwarded = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  const rawIp = forwarded || req.headers.get("x-real-ip") || "unknown";
  const salt = process.env.APPS_SCRIPT_SECRET || "aurascan-local-rate-limit";
  return createHash("sha256").update(`${salt}:${rawIp}`).digest("hex").slice(0, 24);
}

async function callControlEndpoint(
  action: "rate_check" | "release_bulk" | "duplicate_check" | "duplicate_release",
  payload: Record<string, unknown>,
  timeoutMs: number
): Promise<Record<string, unknown> | null> {
  const url = process.env.APPS_SCRIPT_URL;
  const secret = process.env.APPS_SCRIPT_SECRET;
  if (!url || !secret) return null;

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ secret, action, ...payload }),
      signal: AbortSignal.timeout(timeoutMs),
      cache: "no-store",
    });
    if (!response.ok) return null;
    return (await response.json()) as Record<string, unknown>;
  } catch (error) {
    console.warn(`[scanControl] ${action} unavailable; scan control failed open`, error);
    return null;
  }
}

function hashImages(mode: ScanMode, images: Buffer[]): string {
  const hash = createHash("sha256").update(`retry-safe-v2:${mode}:`);
  for (const image of images) {
    hash.update(String(image.length)).update(":").update(image);
  }
  return hash.digest("hex");
}

/**
 * Claims uploaded images before OCR. Only a SHA-256 fingerprint is retained;
 * the image and extracted text are never stored by this guard.
 */
export async function claimScanImages(mode: ScanMode, images: Buffer[]): Promise<DuplicateClaim> {
  const imageHash = hashImages(mode, images);
  const now = Date.now();
  const expiresAt = recentImages.get(imageHash) || 0;
  if (expiresAt > now) {
    return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil((expiresAt - now) / 1000)) };
  }

  for (const [key, expiry] of recentImages) {
    if (expiry <= now) recentImages.delete(key);
  }
  recentImages.set(imageHash, now + DUPLICATE_WINDOW_SECONDS * 1000);

  const data = await callControlEndpoint(
    "duplicate_check",
    { imageHash, windowSeconds: DUPLICATE_WINDOW_SECONDS },
    CONTROL_TIMEOUT_MS
  );
  if (data?.status === "duplicate") {
    return {
      allowed: false,
      retryAfterSeconds: Math.max(1, Number(data.retryAfterSeconds) || DUPLICATE_WINDOW_SECONDS),
    };
  }
  return { allowed: true, imageHash };
}

/** Releases a provisional fingerprint when extraction or storage fails. */
export async function releaseScanImages(claim: DuplicateClaim): Promise<void> {
  if (!claim.allowed || !claim.imageHash) return;
  recentImages.delete(claim.imageHash);
  await callControlEndpoint(
    "duplicate_release",
    { imageHash: claim.imageHash },
    CONTROL_TIMEOUT_MS
  );
}

/**
 * Checks shared limits in Apps Script before expensive OCR work begins.
 * If the control service is unavailable, scanning deliberately continues.
 */
export async function beginScanRequest(req: NextRequest, mode: ScanMode): Promise<ScanPermit> {
  const identity = getClientIdentity(req);
  const requestId = randomUUID();
  const data = await callControlEndpoint(
    "rate_check",
    {
      mode,
      clientId: identity.clientId,
      ipHash: getHashedIp(req),
    },
    CONTROL_TIMEOUT_MS
  );

  if (data?.status === "limited") {
    return {
      allowed: false,
      requestId,
      ...identity,
      retryAfterSeconds: Math.max(1, Number(data.retryAfterSeconds) || 30),
      reason: String(data.message || "The scanner is receiving unusually high traffic."),
    };
  }

  return {
    allowed: true,
    requestId,
    ...identity,
    bulkLeaseId: typeof data?.bulkLeaseId === "string" ? data.bulkLeaseId : undefined,
  };
}

export function withScanClientCookie(response: NextResponse, permit: ScanPermit): NextResponse {
  response.headers.set("X-Request-Id", permit.requestId);
  if (permit.shouldSetClientCookie) {
    response.cookies.set(CLIENT_COOKIE, permit.clientId, {
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      maxAge: 60 * 60 * 24 * 365,
      path: "/",
    });
  }
  return response;
}

export function rateLimitedResponse(permit: ScanPermit): NextResponse {
  const retryAfter = permit.retryAfterSeconds || 30;
  const response = NextResponse.json(
    {
      detail: permit.reason || "The scanner is receiving unusually high traffic.",
      retryAfterSeconds: retryAfter,
    },
    { status: 429 }
  );
  response.headers.set("Retry-After", String(retryAfter));
  return withScanClientCookie(response, permit);
}

export async function releaseBulkPermit(permit: ScanPermit): Promise<void> {
  if (!permit.bulkLeaseId) return;
  await callControlEndpoint(
    "release_bulk",
    { bulkLeaseId: permit.bulkLeaseId },
    CONTROL_TIMEOUT_MS
  );
}
