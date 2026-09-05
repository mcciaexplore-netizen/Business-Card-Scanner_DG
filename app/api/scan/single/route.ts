import { NextRequest, NextResponse } from "next/server";
import { extractCard } from "@/lib/extractCard";
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

export async function POST(req: NextRequest): Promise<NextResponse> {
  const startedAt = Date.now();
  const permit = await beginScanRequest(req, "single");
  if (!permit.allowed) return rateLimitedResponse(permit);

  const respond = (body: unknown, status?: number) =>
    withScanClientCookie(NextResponse.json(body, status ? { status } : undefined), permit);

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
    return respond({ detail: `File exceeds ${process.env.MAX_UPLOAD_MB || 15}MB limit.` }, 413);
  }

  const bytes = Buffer.from(await file.arrayBuffer());

  let fields;
  try {
    fields = await extractCard(bytes);
    fields.Department = department;
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

  const result: SingleScanResult = {
    detected: 1,
    saved: 1,
    failed: 0,
    message: "Card scanned and saved.",
    card: fields,
  };
  return respond(result);
}
