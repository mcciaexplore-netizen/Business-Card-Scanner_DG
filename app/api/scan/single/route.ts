import { NextRequest, NextResponse } from "next/server";
import { extractCard } from "@/lib/extractCard";
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

export async function POST(req: NextRequest): Promise<NextResponse> {
  const startedAt = Date.now();
  const permit = await beginScanRequest(req, "single");
  if (!permit.allowed) return rateLimitedResponse(permit);

  const respond = (body: unknown, status?: number) =>
    withScanClientCookie(NextResponse.json(body, status ? { status } : undefined), permit);

  let file: File;
  let scannedBy = "";
  let paddleCandidate: OcrCandidate | null = null;
  try {
    const formData = await req.formData();
    scannedBy = readScannedBy(formData);
    paddleCandidate = browserOcrCandidate(readBrowserOcrPayload(formData, "paddle_ocr"));
    const uploaded = formData.get("file");
    if (!(uploaded instanceof File)) {
      return respond({ detail: "No file uploaded." }, 400);
    }
    file = uploaded;
  } catch (error) {
    return respond({ detail: error instanceof Error ? error.message : "Could not read the uploaded file." }, 400);
  }

  if (file.size === 0) {
    return respond({ detail: "Uploaded file is empty." }, 400);
  }
  if (file.size > MAX_UPLOAD_BYTES) {
    return respond({ detail: `File exceeds ${process.env.MAX_UPLOAD_MB || 15}MB limit.` }, 413);
  }

  const bytes = Buffer.from(await file.arrayBuffer());
  const duplicateClaim = await claimScanImages("single", [bytes]);
  if (!duplicateClaim.allowed) {
    return respond(
      { detail: "This exact card image was submitted recently, so it was not processed or charged again. Take a new photo or wait before retrying." },
      409
    );
  }

  let scanSaved = false;
  try {
    let fields;
    try {
      fields = await extractCard(bytes, paddleCandidate);
      assertMeaningfulCardData(fields);
      fields["Scanned By"] = scannedBy;
      fields = await enrichIndustry(fields, searchCompanyIndustry, Math.min(10000, 35000 - (Date.now() - startedAt)));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const result: SingleScanResult = {
        detected: 1,
        saved: 0,
        failed: 1,
        message: `Could not read this card: ${message}`,
        card: null,
      };
      return respond(result);
    }

    try {
      await appendRow(fields);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const result: SingleScanResult = {
        detected: 1,
        saved: 0,
        failed: 1,
        message: `The card was read but could not be saved: ${message}`,
        card: fields,
      };
      return respond(result);
    }

    scanSaved = true;
    const result: SingleScanResult = {
      detected: 1,
      saved: 1,
      failed: 0,
      message: "Card scanned and saved.",
      card: fields,
    };
    return respond(result);
  } finally {
    if (!scanSaved) await releaseScanImages(duplicateClaim);
  }
}
