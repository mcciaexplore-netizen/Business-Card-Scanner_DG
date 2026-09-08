import { NextRequest, NextResponse } from "next/server";
import { extractCard } from "@/lib/extractCard";
import { mergeCardSides } from "@/lib/mergeCardFields";
import { appendRow } from "@/lib/storage";
import { SingleScanResult } from "@/lib/types";
import { readScannedBy } from "@/lib/people";
import { enrichIndustry } from "@/lib/industry";
import { searchCompanyIndustry } from "@/lib/industrySearch";
import { assertMeaningfulCardData } from "@/lib/cardValidation";
import { browserOcrCandidate, readBrowserOcrPayload } from "@/lib/browserOcrPayload";
import type { OcrCandidate } from "@/lib/enhancement/ocrPolicy";
import {
  beginScanRequest,
  claimScanImages,
  rateLimitedResponse,
  releaseScanImages,
  withScanClientCookie,
} from "@/lib/scanControl";

export const runtime = "nodejs";
export const maxDuration = 60;

const MAX_UPLOAD_BYTES = (Number(process.env.MAX_UPLOAD_MB) || 15) * 1024 * 1024;

async function parseFile(formData: FormData, key: string): Promise<Buffer | null> {
  const file = formData.get(key);
  if (!(file instanceof File) || file.size === 0) return null;
  if (file.size > MAX_UPLOAD_BYTES) throw new Error(`${key} exceeds size limit.`);
  return Buffer.from(await file.arrayBuffer());
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  const startedAt = Date.now();
  const permit = await beginScanRequest(req, "double");
  if (!permit.allowed) return rateLimitedResponse(permit);

  const respond = (body: unknown, status?: number) =>
    withScanClientCookie(NextResponse.json(body, status ? { status } : undefined), permit);

  let frontBytes: Buffer | null = null;
  let backBytes: Buffer | null = null;
  let scannedBy = "";
  let frontPaddleCandidate: OcrCandidate | null = null;
  let backPaddleCandidate: OcrCandidate | null = null;

  try {
    const formData = await req.formData();
    scannedBy = readScannedBy(formData);
    frontPaddleCandidate = browserOcrCandidate(readBrowserOcrPayload(formData, "paddle_ocr_front"));
    backPaddleCandidate = browserOcrCandidate(readBrowserOcrPayload(formData, "paddle_ocr_back"));
    frontBytes = await parseFile(formData, "file_front");
    backBytes = await parseFile(formData, "file_back");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return respond({ detail: message }, 400);
  }

  if (!frontBytes) {
    return respond({ detail: "No front image uploaded." }, 400);
  }

  const duplicateClaim = await claimScanImages("double", backBytes ? [frontBytes, backBytes] : [frontBytes]);
  if (!duplicateClaim.allowed) {
    return respond(
      { detail: "These exact card images were submitted recently, so they were not processed or charged again. Take a new photo or wait before retrying." },
      409
    );
  }

  let scanSaved = false;
  try {
    let frontFields;
    let backFields;
    try {
      [frontFields, backFields] = await Promise.all([
        extractCard(frontBytes, frontPaddleCandidate),
        backBytes ? extractCard(backBytes, backPaddleCandidate) : Promise.resolve(null),
      ]);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const result: SingleScanResult = {
        detected: 1,
        saved: 0,
        failed: 1,
        message: `Could not read card: ${message}`,
        card: null,
      };
      return respond(result);
    }

    const extracted = backFields ? mergeCardSides(frontFields, backFields) : frontFields;
    try {
      assertMeaningfulCardData(extracted);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return respond({
        detected: 1,
        saved: 0,
        failed: 1,
        message: `Could not read card: ${message}`,
        card: null,
      } satisfies SingleScanResult);
    }
    extracted["Scanned By"] = scannedBy;
    // Research once, after combining both sides and their business descriptions.
    const merged = await enrichIndustry(extracted, searchCompanyIndustry, Math.min(10000, 35000 - (Date.now() - startedAt)));

    try {
      await appendRow(merged);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const result: SingleScanResult = {
        detected: 1,
        saved: 0,
        failed: 1,
        message: `Card read but could not be saved: ${message}`,
        card: merged,
      };
      return respond(result);
    }

    scanSaved = true;
    const result: SingleScanResult = {
      detected: 1,
      saved: 1,
      failed: 0,
      message: backFields
        ? "Both sides scanned and merged — card saved."
        : "Front side scanned — card saved.",
      card: merged,
    };
    return respond(result);
  } finally {
    if (!scanSaved) await releaseScanImages(duplicateClaim);
  }
}
