import { NextRequest, NextResponse } from "next/server";
import { extractCard } from "@/lib/extractCard";
import { mergeCardSides } from "@/lib/mergeCardFields";
import { appendRow } from "@/lib/storage";
import { SingleScanResult } from "@/lib/types";
import { readDepartment } from "@/lib/departments";
import { enrichIndustry } from "@/lib/industry";
import { searchCompanyIndustry } from "@/lib/industrySearch";
import {
  beginScanRequest,
  rateLimitedResponse,
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
  let department = "";

  try {
    const formData = await req.formData();
    department = readDepartment(formData);
    frontBytes = await parseFile(formData, "file_front");
    backBytes = await parseFile(formData, "file_back");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return respond({ detail: message }, 400);
  }

  if (!frontBytes) {
    return respond({ detail: "No front image uploaded." }, 400);
  }

  let frontFields;
  let backFields;
  try {
    [frontFields, backFields] = await Promise.all([
      extractCard(frontBytes),
      backBytes ? extractCard(backBytes) : Promise.resolve(null),
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
  extracted.Department = department;
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
}
