import { NextRequest, NextResponse } from "next/server";
import { extractCard } from "@/lib/extractCard";
import { mergeCardSides } from "@/lib/mergeCardFields";
import { appendRow } from "@/lib/storage";
import { SingleScanResult } from "@/lib/types";

export const runtime = "nodejs";
export const maxDuration = 60;

const MAX_UPLOAD_BYTES = (Number(process.env.MAX_UPLOAD_MB) || 15) * 1024 * 1024;

async function parseFile(formData: FormData, key: string): Promise<Buffer | null> {
  const f = formData.get(key);
  if (!(f instanceof File) || f.size === 0) return null;
  if (f.size > MAX_UPLOAD_BYTES) throw new Error(`${key} exceeds size limit.`);
  return Buffer.from(await f.arrayBuffer());
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  let frontBytes: Buffer | null = null;
  let backBytes:  Buffer | null = null;

  try {
    const formData = await req.formData();
    frontBytes = await parseFile(formData, "file_front");
    backBytes  = await parseFile(formData, "file_back");
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ detail: message }, { status: 400 });
  }

  if (!frontBytes) {
    return NextResponse.json({ detail: "No front image uploaded." }, { status: 400 });
  }

  // Extract both sides in parallel for speed
  let frontFields, backFields;
  try {
    [frontFields, backFields] = await Promise.all([
      extractCard(frontBytes),
      backBytes ? extractCard(backBytes) : Promise.resolve(null),
    ]);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    const result: SingleScanResult = {
      detected: 1,
      saved: 0,
      failed: 1,
      message: `Could not read card: ${message}`,
      card: null,
    };
    return NextResponse.json(result);
  }

  // Merge front + back if we have both sides
  const merged = backFields
    ? mergeCardSides(frontFields, backFields)
    : frontFields;

  try {
    await appendRow(merged);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    const result: SingleScanResult = {
      detected: 1,
      saved: 0,
      failed: 1,
      message: `Card read but could not be saved: ${message}`,
      card: merged,
    };
    return NextResponse.json(result);
  }

  const result: SingleScanResult = {
    detected: 1,
    saved: 1,
    failed: 0,
    message: backFields
      ? "Both sides scanned and merged — card saved."
      : "Front side scanned — card saved.",
    card: merged,
  };
  return NextResponse.json(result);
}
