import { after, NextRequest, NextResponse } from "next/server";
import { extractCard } from "@/lib/extractCard";
import { detectCardBoxes, cropCard } from "@/lib/detectCards";
import { appendRow } from "@/lib/storage";
import { mapWithConcurrency } from "@/lib/concurrency";
import { BulkCardResult, BulkScanResult, emptyFields } from "@/lib/types";
import { readDepartment } from "@/lib/departments";
import { enrichIndustry } from "@/lib/industry";
import { searchCompanyIndustry } from "@/lib/industrySearch";
import {
  beginScanRequest,
  rateLimitedResponse,
  releaseBulkPermit,
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

  try {
    let file: File;
    let department = "";
    try {
      const formData = await req.formData();
      department = readDepartment(formData);
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

    const results = await mapWithConcurrency<(typeof boxes)[number], BulkCardResult>(
      boxes,
      CARD_CONCURRENCY,
      async (box) => {
        try {
          const cropBytes = await cropCard(bytes, box);
          const extracted = await extractCard(cropBytes);
          extracted.Department = department;
          const fields = await enrichIndustry(extracted, searchCompanyIndustry, Math.min(10000, 275000 - (Date.now() - startedAt)));
          await appendRow(fields);
          return { ...fields, _status: "saved" };
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          return { ...emptyFields(), Department: department, _status: `failed: ${message}` };
        }
      }
    );

    const saved = results.filter((result) => result._status === "saved").length;
    const failed = results.length - saved;

    const result: BulkScanResult = {
      detected: boxes.length,
      saved,
      failed,
      message: `Detected ${boxes.length} card(s): ${saved} saved, ${failed} failed.`,
      cards: results,
    };
    return respond(result);
  } finally {
    after(() => releaseBulkPermit(permit));
  }
}
