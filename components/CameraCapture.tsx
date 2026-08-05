"use client";

import { useRef, useState, useEffect, useCallback } from "react";
import { CameraIcon, CaptureIcon, RetakeIcon } from "./icons";

type CameraState = "idle" | "live" | "captured";

interface CameraCaptureProps {
  active: boolean; // whether the "Use Camera" source pane is currently selected
  onCapture: (file: File) => void;
}

export function CameraCapture({ active, onCapture }: CameraCaptureProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const [state, setState] = useState<CameraState>("idle");
  const [capturedUrl, setCapturedUrl] = useState<string | null>(null);
  const [error, setError] = useState("");

  const stopStream = useCallback(() => {
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
  }, []);

  // Release the camera whenever the user switches away from this pane,
  // and on unmount - same intent as the original stopCameraStream(),
  // just triggered by React lifecycle instead of manual event handlers.
  useEffect(() => {
    if (!active) stopStream();
    return () => stopStream();
  }, [active, stopStream]);

  const startCamera = async () => {
    setError("");
    if (!navigator.mediaDevices?.getUserMedia) {
      setError("Camera access isn't supported in this browser.");
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: "environment" } },
        audio: false,
      });
      streamRef.current = stream;
      if (videoRef.current) videoRef.current.srcObject = stream;
      setState("live");
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      setError("Could not access the camera: " + message);
    }
  };

  const capturePhoto = () => {
    const video = videoRef.current;
    if (!video || !streamRef.current) return;
    const w = video.videoWidth;
    const h = video.videoHeight;
    if (!w || !h) return;

    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.drawImage(video, 0, 0, w, h);

    canvas.toBlob(
      (blob) => {
        if (!blob) {
          setError("Could not capture photo, please try again.");
          return;
        }
        const file = new File([blob], "camera-capture.jpg", { type: "image/jpeg" });
        setCapturedUrl(URL.createObjectURL(blob));
        setState("captured");
        stopStream(); // frame is captured; release the camera hardware
        onCapture(file);
      },
      "image/jpeg",
      0.92
    );
  };

  const retake = () => {
    if (capturedUrl) URL.revokeObjectURL(capturedUrl);
    setCapturedUrl(null);
    setState("idle");
  };

  return (
    <>
      <div className="camera-box">
        <video
          ref={videoRef}
          className="camera-video"
          autoPlay
          playsInline
          muted
          hidden={state !== "live"}
        />
        {state === "captured" && capturedUrl && (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={capturedUrl} className="camera-video" alt="Captured business card" />
        )}
        {state === "idle" && (
          <div className="camera-empty">
            <div className="camera-placeholder-icon">
              <CameraIcon large />
            </div>
            <p>Camera feed is inactive</p>
          </div>
        )}
      </div>
      <div className="camera-controls">
        {state === "idle" && (
          <button className="btn btn-secondary" type="button" onClick={startCamera}>
            <CameraIcon />
            Start Camera
          </button>
        )}
        {state === "live" && (
          <button className="btn btn-secondary" type="button" onClick={capturePhoto}>
            <CaptureIcon />
            Capture Photo
          </button>
        )}
        {state === "captured" && (
          <button className="btn btn-secondary" type="button" onClick={retake}>
            <RetakeIcon />
            Retake
          </button>
        )}
      </div>
      <p className={"status-line" + (error ? " err" : "")}>{error}</p>
    </>
  );
}
