import { after, NextRequest, NextResponse } from "next/server";
import { extractCard } from "@/lib/extractCard";
import { detectCardBoxes, cropCard } from "@/lib/detectCards";
import { appendRow } from "@/lib/storage";
import { mapWithConcurrency } from "@/lib/concurrency";
import { BulkCardResult, BulkScanResult, CardFields, emptyFields } from "@/lib/types";
import { readScannedBy } from "@/lib/people";
import { enrichIndustry } from "@/lib/industry";
import { searchCompanyIndustry } from "@/lib/industrySearch";
import { assertMeaningfulCardData } from "@/lib/cardValidation";
import { deduplicateExtractedCards } from "@/lib/cardDeduplication";
import { browserOcrCandidateForBox, readBrowserOcrPayload } from "@/lib/browserOcrPayload";
import type { BrowserOcrPayload } from "@/lib/browserOcrPayload";
import {
  beginScanRequest,
  claimScanImages,
  rateLimitedResponse,
  releaseBulkPermit,
  releaseScanImages,
  withScanClientCookie,
} from "@/lib/scanControl";

export const runtime = "nodejs";
// Fluid Compute supports five minutes on Hobby and longer on paid plans.
// Keeping this at 300 seconds removes the old self-imposed 60-second ceiling
// while retaining a bounded request lifetime.
export const maxDuration = 300;

const MAX_UPLOAD_BYTES = (Number(process.env.MAX_UPLOAD_MB) || 15) * 1024 * 1024;
const CARD_CONCURRENCY = 5;
const MAX_BULK_CARDS = 50;

export async function POST(req: NextRequest): Promise<NextResponse> {
  const startedAt = Date.now();
  const permit = await beginScanRequest(req, "bulk");
  if (!permit.allowed) return rateLimitedResponse(permit);

  const respond = (body: unknown, status?: number) =>
    withScanClientCookie(NextResponse.json(body, status ? { status } : undefined), permit);
  let duplicateClaim: Awaited<ReturnType<typeof claimScanImages>> | null = null;
  let keepDuplicateClaim = false;

  try {
    let file: File;
    let scannedBy = "";
    let paddlePayload: BrowserOcrPayload | null = null;
    try {
      const formData = await req.formData();
      scannedBy = readScannedBy(formData);
      paddlePayload = readBrowserOcrPayload(formData, "paddle_ocr");
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
      return respond(
        { detail: `File exceeds ${process.env.MAX_UPLOAD_MB || 15}MB limit.` },
        413
      );
    }

    const bytes = Buffer.from(await file.arrayBuffer());
    duplicateClaim = await claimScanImages("bulk", [bytes]);
    if (!duplicateClaim.allowed) {
      return respond(
        { detail: "This exact bulk image was submitted recently, so it was not processed or charged again. Take a new photo or wait before retrying." },
        409
      );
    }

    let boxes;
    try {
      boxes = await detectCardBoxes(bytes);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return respond({ detail: `Could not process image: ${message}` }, 422);
    }

    if (boxes.length > MAX_BULK_CARDS) {
      return respond(
        {
          detail: `Detected ${boxes.length} cards. A bulk scan can process up to ${MAX_BULK_CARDS} cards at once; split this photo into smaller groups.`,
        },
        422
      );
    }

    if (boxes.length === 0) {
      const result: BulkScanResult = {
        detected: 0,
        saved: 0,
        failed: 0,
        message:
          "No cards detected. Try a photo with better contrast against the background, more spacing between cards, and even lighting.",
        cards: [],
      };
      return respond(result);
    }

    type ExtractionAttempt = { index: number; fields: CardFields | null; error?: string };
    const extractionAttempts = await mapWithConcurrency<(typeof boxes)[number], ExtractionAttempt>(
      boxes,
      CARD_CONCURRENCY,
      async (box, index) => {
        try {
          const cropBytes = await cropCard(bytes, box);
          const extracted = await extractCard(
            cropBytes,
            browserOcrCandidateForBox(paddlePayload, box)
          );
          assertMeaningfulCardData(extracted);
          extracted["Scanned By"] = scannedBy;
          return { index, fields: extracted };
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          return { index, fields: null, error: message };
        }
      }
    );

    const readableCards = extractionAttempts
      .filter((attempt): attempt is ExtractionAttempt & { fields: CardFields } => attempt.fields !== null)
      .map(({ index, fields }) => ({ index, fields }));
    const { unique, duplicates } = deduplicateExtractedCards(readableCards);

    const resultByIndex = new Map<number, BulkCardResult>();
    extractionAttempts.forEach((attempt) => {
      if (!attempt.fields) {
        resultByIndex.set(attempt.index, {
          ...emptyFields(),
          "Scanned By": scannedBy,
          _status: `failed: ${attempt.error || "Could not read card"}`,
        });
      }
    });
    duplicates.forEach((duplicate) => {
      resultByIndex.set(duplicate.index, {
        ...duplicate.fields,
        _status: `skipped: duplicate of card ${duplicate.duplicateOf + 1}`,
      });
    });

    const savedAttempts = await mapWithConcurrency(
      unique,
      CARD_CONCURRENCY,
      async ({ index, fields }) => {
        try {
          const enriched = await enrichIndustry(
            fields,
            searchCompanyIndustry,
            Math.min(10000, 275000 - (Date.now() - startedAt))
          );
          await appendRow(enriched);
          return { index, result: { ...enriched, _status: "saved" } as BulkCardResult };
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          return { index, result: { ...fields, _status: `failed: ${message}` } as BulkCardResult };
        }
      }
    );
    savedAttempts.forEach(({ index, result }) => resultByIndex.set(index, result));

    const results = boxes.map((_, index) => resultByIndex.get(index) || {
      ...emptyFields(),
      "Scanned By": scannedBy,
      _status: "failed: unknown processing error",
    });
    const saved = results.filter((result) => result._status === "saved").length;
    const skipped = results.filter((result) => result._status.startsWith("skipped:")).length;
    const failed = results.length - saved - skipped;

    const result: BulkScanResult = {
      detected: boxes.length,
      saved,
      failed,
      skipped,
      message: `Detected ${boxes.length} card(s): ${saved} saved, ${skipped} duplicate(s) skipped, ${failed} failed.`,
      cards: results,
    };
    keepDuplicateClaim = saved > 0;
    return respond(result);
  } finally {
    if (duplicateClaim && !keepDuplicateClaim) await releaseScanImages(duplicateClaim);
    after(() => releaseBulkPermit(permit));
  }
}
