"use client";

import { useState, useCallback, useEffect, useRef } from "react";
import { Dropzone } from "./Dropzone";
import { StatsRow } from "./StatsRow";
import { BulkResultsList } from "./BulkResultsList";
import { ScannedBySelect } from "./ScannedBySelect";
import { CheckIcon, AlertIcon, GridIcon, ArrowLeftIcon } from "./icons";
import type { BulkScanResult } from "@/lib/types";
import {
  appendBrowserOcr,
  canRunBulkBrowserPaddleOcr,
  runBrowserPaddleOcr,
  shouldUseMemorySafeImageFlow,
} from "@/lib/browserPaddleOcr";

export function BulkScanPanel() {
  const [scannedBy, setScannedBy] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [memorySafeFlow, setMemorySafeFlow] = useState(false);
  const [scanning, setScanning] = useState(false);
  const scanInFlight = useRef(false);
  const [status, setStatus] = useState<{ text: string; kind: "" | "ok" | "err" }>({
    text: "",
    kind: "",
  });
  const [result, setResult] = useState<BulkScanResult | null>(null);

  useEffect(() => {
    return () => {
      if (previewUrl) URL.revokeObjectURL(previewUrl);
    };
  }, [previewUrl]);

  const handleFile = useCallback((f: File) => {
    const useMemorySafeFlow = shouldUseMemorySafeImageFlow();
    setFile(f);
    setMemorySafeFlow(useMemorySafeFlow);
    setPreviewUrl((prev) => {
      if (prev) URL.revokeObjectURL(prev);
      // A 48 MP iPhone photo can occupy almost 200 MB after decoding. Keeping
      // it out of the DOM prevents WebKit from terminating the whole tab.
      return useMemorySafeFlow ? null : URL.createObjectURL(f);
    });
    setStatus({ text: "", kind: "" });
    setResult(null);
  }, []);

  /** Back from the result screen to the empty upload screen. */
  const handleBackFromResult = () => {
    setFile(null);
    setPreviewUrl((prev) => {
      if (prev) URL.revokeObjectURL(prev);
      return null;
    });
    setResult(null);
    setStatus({ text: "", kind: "" });
  };

  const handleScan = async () => {
    if (!file || scanInFlight.current) return;
    scanInFlight.current = true;
    setStatus({
      text: "Detecting and reading cards — this can take a while for large batches…",
      kind: "",
    });
    setScanning(true);
    try {
      const useBrowserOcr = canRunBulkBrowserPaddleOcr();
      setStatus({
        text: useBrowserOcr
          ? "Running PaddleOCR on this device before bulk extraction…"
          : "Uploading the bulk photo for memory-safe server processing…",
        kind: "",
      });
      const paddleOcr = useBrowserOcr ? await runBrowserPaddleOcr(file) : null;
      setPreviewUrl((prev) => {
        if (prev) URL.revokeObjectURL(prev);
        return null;
      });
      setStatus({ text: "Detecting, deduplicating, and saving cards…", kind: "" });
      let res: Response;
      if (memorySafeFlow) {
        // Passing the File directly lets Mobile Safari stream the original
        // bytes instead of building a second multipart copy in tab memory.
        res = await fetch("/api/scan/bulk", {
          method: "POST",
          headers: {
            "Content-Type": file.type || "application/octet-stream",
            "X-AuraScan-Upload": "raw",
            "X-AuraScan-Scanned-By": encodeURIComponent(scannedBy),
          },
          body: file,
        });
      } else {
        const fd = new FormData();
        fd.append("file", file);
        fd.append("scanned_by", scannedBy);
        appendBrowserOcr(fd, "paddle_ocr", paddleOcr);
        res = await fetch("/api/scan/bulk", { method: "POST", body: fd });
      }
      
      const rawText = await res.text();
      let data: BulkScanResult | { detail?: string; message?: string } | null = null;
      try {
        data = JSON.parse(rawText);
      } catch {
        if (!res.ok) {
          throw new Error(`Server returned HTTP ${res.status}: ${res.statusText || rawText.slice(0, 150)}`);
        }
        throw new Error("Server response was not valid JSON.");
      }

      if (!res.ok) {
        const errorDetail = (data as { detail?: string; message?: string })?.detail || (data as { detail?: string; message?: string })?.message || "Scan failed";
        throw new Error(errorDetail);
      }

      const scanResult = data as BulkScanResult;
      setResult(scanResult);
      setStatus({ text: scanResult.message, kind: scanResult.saved > 0 ? "ok" : "err" });
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      setStatus({ text: message, kind: "err" });
    } finally {
      scanInFlight.current = false;
      setScanning(false);
    }
  };

  return (
    <section className="panel active">
      <div className="upload-card">
        <ScannedBySelect value={scannedBy} onChange={setScannedBy} disabled={scanning} bulk />
        <Dropzone
          onFile={handleFile}
          previewUrl={previewUrl}
          emptyState={
            file ? (
              <div className="selected-file">
                <div className="dz-icon-wrap"><CheckIcon /></div>
                <h3>Bulk photo selected</h3>
                <p>{file.name}</p>
                <p className="dz-hint">Tap here to choose a different photo</p>
              </div>
            ) : <>
              <div className="dz-icon-wrap">
                <GridIcon />
              </div>
              <h3>Upload bulk photo</h3>
              <p>Drop a photo containing up to 10 cards laid flat</p>
              <p className="dz-hint">Ensure cards are spaced apart on a contrasting plain background</p>
            </>
          }
        />
        <button
          className="btn btn-primary"
          disabled={!file || scanning}
          onClick={handleScan}
          type="button"
        >
          <span className="btn-text" style={{ opacity: scanning ? 0.55 : 1 }}>
            Scan &amp; Save All Cards
          </span>
          {scanning && <span className="loader" />}
        </button>
        <p className={"status-line" + (status.kind ? ` ${status.kind}` : "")}>{status.text}</p>
      </div>

      {result && (
        <div className="result-card">
          <div className="result-header">
            <div className={"result-indicator " + (result.saved > 0 ? "indicator-ok" : "indicator-fail")}>
              {result.saved > 0 ? <CheckIcon /> : <AlertIcon />}
            </div>
            <h2>Scan Result</h2>
            <button
              id="btn-back-from-bulk-result"
              className="btn btn-ghost btn-retake"
              onClick={handleBackFromResult}
              type="button"
              style={{ marginLeft: "auto" }}
            >
              <ArrowLeftIcon />
              Back
            </button>
          </div>
          <StatsRow detected={result.detected} saved={result.saved} failed={result.failed} />
          {result.cards.length > 0 && <BulkResultsList cards={result.cards} />}
        </div>
      )}
    </section>
  );
}
