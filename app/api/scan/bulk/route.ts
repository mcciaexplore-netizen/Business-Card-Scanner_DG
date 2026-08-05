import { NextRequest, NextResponse } from "next/server";
import { extractCard } from "@/lib/extractCard";
import { detectCardBoxes, cropCard } from "@/lib/detectCards";
import { appendRow } from "@/lib/storage";
import { mapWithConcurrency } from "@/lib/concurrency";
import { BulkCardResult, BulkScanResult, emptyFields } from "@/lib/types";

export const runtime = "nodejs";
// Bulk scan needs real headroom: each card costs two Gemini calls plus a
// storage POST. 60s is the safe default that works on every Vercel plan
// without extra configuration - see the README for what to do if you
// need longer (Vercel Pro allows raising this considerably).
export const maxDuration = 60;

const MAX_UPLOAD_BYTES = (Number(process.env.MAX_UPLOAD_MB) || 15) * 1024 * 1024;
const CARD_CONCURRENCY = 5;

export async function POST(req: NextRequest): Promise<NextResponse> {
  let file: File;
  try {
    const formData = await req.formData();
    const f = formData.get("file");
    if (!(f instanceof File)) {
      return NextResponse.json({ detail: "No file uploaded." }, { status: 400 });
    }
    file = f;
  } catch {
    return NextResponse.json({ detail: "Could not read the uploaded file." }, { status: 400 });
  }

  if (file.size === 0) {
    return NextResponse.json({ detail: "Uploaded file is empty." }, { status: 400 });
  }
  if (file.size > MAX_UPLOAD_BYTES) {
    return NextResponse.json(
      { detail: `File exceeds ${process.env.MAX_UPLOAD_MB || 15}MB limit.` },
      { status: 413 }
    );
  }

  const bytes = Buffer.from(await file.arrayBuffer());

  let boxes;
  try {
    boxes = await detectCardBoxes(bytes);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ detail: `Could not process image: ${message}` }, { status: 422 });
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
    return NextResponse.json(result);
  }

  // Each card is processed fully independently: one failing (bad crop,
  // bad read, or a save error) never stops or affects any other card,
  // and running them concurrently keeps total time reasonable.
  const results = await mapWithConcurrency<(typeof boxes)[number], BulkCardResult>(
    boxes,
    CARD_CONCURRENCY,
    async (box) => {
      try {
        const cropBytes = await cropCard(bytes, box);
        const fields = await extractCard(cropBytes);
        await appendRow(fields);
        return { ...fields, _status: "saved" };
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        return { ...emptyFields(), _status: `failed: ${message}` };
      }
    }
  );

  const saved = results.filter((r) => r._status === "saved").length;
  const failed = results.length - saved;

  const result: BulkScanResult = {
    detected: boxes.length,
    saved,
    failed,
    message: `Detected ${boxes.length} card(s): ${saved} saved, ${failed} failed.`,
    cards: results,
  };
  return NextResponse.json(result);
}
