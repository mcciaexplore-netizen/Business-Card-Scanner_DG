import { NextRequest, NextResponse } from "next/server";
import { extractCard } from "@/lib/extractCard";
import { appendRow } from "@/lib/storage";
import { SingleScanResult } from "@/lib/types";

export const runtime = "nodejs";
export const maxDuration = 60;

const MAX_UPLOAD_BYTES = (Number(process.env.MAX_UPLOAD_MB) || 15) * 1024 * 1024;

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

  let fields;
  try {
    fields = await extractCard(bytes);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    const result: SingleScanResult = {
      detected: 1,
      saved: 0,
      failed: 1,
      message: `Could not read this card: ${message}`,
      card: null,
    };
    return NextResponse.json(result);
  }

  try {
    await appendRow(fields);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    const result: SingleScanResult = {
      detected: 1,
      saved: 0,
      failed: 1,
      message: `The card was read but could not be saved: ${message}`,
      card: fields,
    };
    return NextResponse.json(result);
  }

  const result: SingleScanResult = {
    detected: 1,
    saved: 1,
    failed: 0,
    message: "Card scanned and saved.",
    card: fields,
  };
  return NextResponse.json(result);
}
