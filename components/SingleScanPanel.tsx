"use client";

import { useState, useCallback, useEffect } from "react";
import { Dropzone } from "./Dropzone";
import { CameraCapture } from "./CameraCapture";
import { StatsRow } from "./StatsRow";
import { FieldList } from "./FieldList";
import { CheckIcon, AlertIcon, ImageIcon, CameraIcon, ArrowLeftIcon } from "./icons";
import type { SingleScanResult } from "@/lib/types";

type Source = "upload" | "camera";
type Step   = "front" | "back" | "done";

export function SingleScanPanel() {
  const [source, setSource] = useState<Source>("upload");

  // ── Per-step file & preview state ────────────────────────────────────────
  const [step,       setStep]       = useState<Step>("front");
  const [frontFile,  setFrontFile]  = useState<File | null>(null);
  const [backFile,   setBackFile]   = useState<File | null>(null);
  const [frontPreview, setFrontPreview] = useState<string | null>(null);
  const [backPreview,  setBackPreview]  = useState<string | null>(null);

  const [scanning, setScanning] = useState(false);
  const [isTwoSided, setIsTwoSided] = useState(false);
  const [status,  setStatus]  = useState<{ text: string; kind: "" | "ok" | "err" }>({ text: "", kind: "" });
  const [result,  setResult]  = useState<SingleScanResult | null>(null);

  // Clean up object URLs on unmount / replacement
  useEffect(() => {
    return () => {
      if (frontPreview) URL.revokeObjectURL(frontPreview);
      if (backPreview)  URL.revokeObjectURL(backPreview);
    };
  }, [frontPreview, backPreview]);

  // ── Helpers ───────────────────────────────────────────────────────────────
  const makePreview = (f: File) => URL.createObjectURL(f);

  const handleFrontFile = useCallback((f: File) => {
    setFrontFile(f);
    setFrontPreview((prev) => { if (prev) URL.revokeObjectURL(prev); return makePreview(f); });
    setStatus({ text: "", kind: "" });
    setResult(null);
  }, []);

  const handleBackFile = useCallback((f: File) => {
    setBackFile(f);
    setBackPreview((prev) => { if (prev) URL.revokeObjectURL(prev); return makePreview(f); });
  }, []);

  const handleCameraCapture = useCallback((f: File) => {
    if (step === "front") {
      setFrontFile(f);
      setFrontPreview((prev) => { if (prev) URL.revokeObjectURL(prev); return makePreview(f); });
      setStatus({ text: "", kind: "" });
      setResult(null);
    } else {
      setBackFile(f);
      setBackPreview((prev) => { if (prev) URL.revokeObjectURL(prev); return makePreview(f); });
    }
  }, [step]);

  /** Back from the result screen to the last capture step, keeping the
   *  already-captured images so the user doesn't have to redo them. */
  const handleBackFromDone = () => {
    setStep(isTwoSided ? "back" : "front");
    setResult(null);
    setStatus({ text: "", kind: "" });
  };

  // ── Reset entire flow ─────────────────────────────────────────────────────
  const resetAll = () => {
    setStep("front");
    setFrontFile(null);
    setBackFile(null);
    if (frontPreview) URL.revokeObjectURL(frontPreview);
    if (backPreview)  URL.revokeObjectURL(backPreview);
    setFrontPreview(null);
    setBackPreview(null);
    setStatus({ text: "", kind: "" });
    setResult(null);
    setIsTwoSided(false);
  };

  // ── Actions ───────────────────────────────────────────────────────────────

  /** Single-sided: original flow, unchanged. */
  const handleScanSingle = async () => {
    if (!frontFile) return;
    setStatus({ text: "Scanning card…", kind: "" });
    setScanning(true);
    setIsTwoSided(false);
    try {
      const fd = new FormData();
      fd.append("file", frontFile);
      const res = await fetch("/api/scan/single", { method: "POST", body: fd });
      const rawText = await res.text();
      let data: SingleScanResult | { detail?: string; message?: string } | null = null;
      try { data = JSON.parse(rawText); } catch {
        throw new Error(res.ok
          ? "Server response was not valid JSON."
          : `Server error ${res.status}: ${rawText.slice(0, 150)}`);
      }
      if (!res.ok) throw new Error((data as { detail?: string })?.detail || "Scan failed");
      const r = data as SingleScanResult;
      setResult(r);
      setStep("done");
      setStatus({ text: r.message, kind: r.saved > 0 ? "ok" : "err" });
    } catch (e) {
      setStatus({ text: e instanceof Error ? e.message : String(e), kind: "err" });
    } finally {
      setScanning(false);
    }
  };

  /** Two-sided step 1: go to back-capture UI. */
  const handleGoToBack = () => {
    if (!frontFile) return;
    setIsTwoSided(true);
    setBackFile(null);
    setBackPreview(null);
    setStatus({ text: "", kind: "" });
    setStep("back");
  };

  /** Two-sided step 2: send both sides, merge, save. */
  const handleScanDouble = async () => {
    if (!frontFile || !backFile) return;
    setStatus({ text: "Scanning both sides…", kind: "" });
    setScanning(true);
    try {
      const fd = new FormData();
      fd.append("file_front", frontFile);
      fd.append("file_back",  backFile);
      const res = await fetch("/api/scan/double", { method: "POST", body: fd });
      const rawText = await res.text();
      let data: SingleScanResult | { detail?: string; message?: string } | null = null;
      try { data = JSON.parse(rawText); } catch {
        throw new Error(res.ok
          ? "Server response was not valid JSON."
          : `Server error ${res.status}: ${rawText.slice(0, 150)}`);
      }
      if (!res.ok) throw new Error((data as { detail?: string })?.detail || "Scan failed");
      const r = data as SingleScanResult;
      setResult(r);
      setStep("done");
      setStatus({ text: r.message, kind: r.saved > 0 ? "ok" : "err" });
    } catch (e) {
      setStatus({ text: e instanceof Error ? e.message : String(e), kind: "err" });
    } finally {
      setScanning(false);
    }
  };

  // ── Current preview for the active step ───────────────────────────────────
  const activePreview = step === "back" ? backPreview : (source === "upload" ? frontPreview : null);

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <section className="panel active">
      <div className="upload-card">

        {/* ── Step indicator (shown during back-capture) ─────────────── */}
        {step === "back" && (
          <div className="step-indicator" aria-label="Scan progress">
            <span className="step-pill done">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="20 6 9 17 4 12" />
              </svg>
              Front scanned
            </span>
            <svg className="step-chevron" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="9 18 15 12 9 6" />
            </svg>
            <span className="step-pill active">Back side</span>
          </div>
        )}

        {/* ── Source switch (hidden when result is shown) ─────────────── */}
        {step !== "done" && (
          <div className="source-switch">
            <button
              className={"source-btn" + (source === "upload" ? " active" : "")}
              onClick={() => setSource("upload")}
              type="button"
            >
              <ImageIcon />
              Upload Photo
            </button>
            <button
              className={"source-btn" + (source === "camera" ? " active" : "")}
              onClick={() => setSource("camera")}
              type="button"
            >
              <CameraIcon />
              Use Camera
            </button>
          </div>
        )}

        {/* ── Image / camera panes ────────────────────────────────────── */}
        {step !== "done" && (
          <>
            <div className={"source-pane" + (source === "upload" ? " active" : "")}>
              <Dropzone
                onFile={step === "back" ? handleBackFile : handleFrontFile}
                previewUrl={activePreview}
                emptyState={
                  <>
                    <div className="dz-icon-wrap">
                      <ImageIconLarge />
                    </div>
                    <h3>{step === "back" ? "Upload back side" : "Upload business card"}</h3>
                    <p>{step === "back" ? "Drop or click to upload the card's back side" : "Drag and drop image here, or browse files"}</p>
                    <p className="dz-hint">PNG, JPG, or WebP</p>
                  </>
                }
              />
            </div>

            <div className={"source-pane" + (source === "camera" ? " active" : "")}>
              <CameraCapture key={step} active={source === "camera"} onCapture={handleCameraCapture} />
            </div>
          </>
        )}

        {/* ── STEP: front — action buttons ────────────────────────────── */}
        {step === "front" && (
          <div className="two-sided-actions">
            <button
              id="btn-scan-single"
              className="btn btn-primary btn-scan-single"
              disabled={!frontFile || scanning}
              onClick={handleScanSingle}
              type="button"
              title="Scan this one-sided card and save"
            >
              <span className="btn-text" style={{ opacity: scanning ? 0.55 : 1 }}>
                Scan &amp; Save Card
              </span>
              {scanning && <span className="loader" />}
            </button>

            <button
              id="btn-scan-double-start"
              className="btn btn-outline-accent btn-scan-next"
              disabled={!frontFile || scanning}
              onClick={handleGoToBack}
              type="button"
              title="This card has a back side — scan both"
            >
              <FlipIcon />
              <span>Scan Front &amp; Continue</span>
              <ArrowRightIcon />
            </button>
          </div>
        )}

        {/* ── STEP: back — action buttons ─────────────────────────────── */}
        {step === "back" && (
          <div className="two-sided-actions">
            <button
              id="btn-retake-front"
              className="btn btn-ghost btn-retake"
              onClick={() => { setStep("front"); setStatus({ text: "", kind: "" }); }}
              type="button"
              disabled={scanning}
            >
              <ArrowLeftIcon />
              Retake Front
            </button>

            <button
              id="btn-scan-both"
              className="btn btn-primary btn-scan-both"
              disabled={!backFile || scanning}
              onClick={handleScanDouble}
              type="button"
            >
              <span className="btn-text" style={{ opacity: scanning ? 0.55 : 1 }}>
                Scan Both &amp; Save
              </span>
              {scanning && <span className="loader" />}
            </button>
          </div>
        )}

        {/* ── Back / scan-another buttons after done ───────────────────── */}
        {step === "done" && (
          <div className="two-sided-actions">
            <button
              id="btn-back-from-done"
              className="btn btn-ghost btn-retake"
              onClick={handleBackFromDone}
              type="button"
            >
              <ArrowLeftIcon />
              Back
            </button>

            <button
              id="btn-scan-another"
              className="btn btn-ghost btn-scan-another"
              onClick={resetAll}
              type="button"
            >
              <RefreshIcon />
              Scan Another Card
            </button>
          </div>
        )}

        <p className={"status-line" + (status.kind ? ` ${status.kind}` : "")}>{status.text}</p>
      </div>

      {/* ── Result card ─────────────────────────────────────────────────── */}
      {result && step === "done" && (
        <div className="result-card">
          <div className="result-header">
            <div className={"result-indicator " + (result.saved > 0 ? "indicator-ok" : "indicator-fail")}>
              {result.saved > 0 ? <CheckIcon /> : <AlertIcon />}
            </div>
            <h2>Scan Result</h2>
            {isTwoSided && (
              <span className="badge-dual" aria-label="Two-sided scan">
                <FlipIcon size={11} />
                2-Sided
              </span>
            )}
          </div>
          <StatsRow detected={result.detected} saved={result.saved} failed={result.failed} />
          {result.card && <FieldList fields={result.card} />}
        </div>
      )}
    </section>
  );
}

// ── Inline SVG icons ──────────────────────────────────────────────────────────

function ImageIconLarge() {
  return (
    <svg viewBox="0 0 24 24" width="40" height="40" stroke="currentColor" strokeWidth="1.5" fill="none" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
      <polyline points="17 8 12 3 7 8" />
      <line x1="12" y1="3" x2="12" y2="15" />
    </svg>
  );
}

function FlipIcon({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M17 1l4 4-4 4"/>
      <path d="M3 11V9a4 4 0 0 1 4-4h14"/>
      <path d="M7 23l-4-4 4-4"/>
      <path d="M21 13v2a4 4 0 0 1-4 4H3"/>
    </svg>
  );
}

function ArrowRightIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <line x1="5" y1="12" x2="19" y2="12" />
      <polyline points="12 5 19 12 12 19" />
    </svg>
  );
}

function RefreshIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <polyline points="23 4 23 10 17 10" />
      <polyline points="1 20 1 14 7 14" />
      <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" />
    </svg>
  );
}
