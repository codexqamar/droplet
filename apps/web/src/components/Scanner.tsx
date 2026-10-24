import { ScanLine, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

/**
 * Camera barcode scanner for phones and tablets on site. Uses the browser's BarcodeDetector where
 * available (Chrome, Edge, Android) and falls back to ZXing (Safari / iOS). Each code found is
 * passed to onCode; the scanner stays open so a buyer can scan a shelf of items in one go.
 */
export function Scanner({ onCode, onClose }: { onCode: (code: string) => void; onClose: () => void }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [last, setLast] = useState<string | null>(null);
  const onCodeRef = useRef(onCode);
  onCodeRef.current = onCode;

  useEffect(() => {
    let stop = () => {};
    let cancelled = false;
    let recent = { code: "", at: 0 };
    const found = (code: string) => {
      const now = Date.now();
      if (code === recent.code && now - recent.at < 2500) return; // same item still in view
      recent = { code, at: now };
      setLast(code);
      navigator.vibrate?.(60);
      onCodeRef.current(code);
    };

    void (async () => {
      try {
        const video = videoRef.current!;
        const Detector = (window as unknown as { BarcodeDetector?: new (o: { formats: string[] }) => { detect: (v: HTMLVideoElement) => Promise<Array<{ rawValue: string }>> } }).BarcodeDetector;
        if (Detector) {
          const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" }, audio: false });
          if (cancelled) return stream.getTracks().forEach((t) => t.stop());
          video.srcObject = stream;
          await video.play();
          const detector = new Detector({ formats: ["ean_13", "ean_8", "upc_a", "upc_e", "code_128", "code_39", "qr_code"] });
          let raf = 0;
          const loop = async () => {
            try {
              const codes = await detector.detect(video);
              if (codes[0]?.rawValue) found(codes[0].rawValue);
            } catch {
              /* frame not ready */
            }
            raf = window.setTimeout(() => void loop(), 250);
          };
          void loop();
          stop = () => {
            window.clearTimeout(raf);
            stream.getTracks().forEach((t) => t.stop());
          };
        } else {
          const { BrowserMultiFormatReader } = await import("@zxing/browser");
          const reader = new BrowserMultiFormatReader();
          const controls = await reader.decodeFromVideoDevice(undefined, video, (result) => result && found(result.getText()));
          if (cancelled) return controls.stop();
          stop = () => controls.stop();
        }
      } catch (e) {
        setError((e as Error).name === "NotAllowedError" ? "Camera access was blocked. Allow the camera for this site and try again." : "No camera is available on this device.");
      }
    })();
    return () => {
      cancelled = true;
      stop();
    };
  }, []);

  return createPortal(
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/60 p-4" role="dialog" aria-modal="true" aria-label="Scan barcode">
      <div className="glass-float w-full max-w-md overflow-hidden p-4">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="flex items-center gap-2 text-base font-semibold"><ScanLine className="h-4 w-4 text-accent" /> Scan items</h2>
          <button onClick={onClose} className="grid h-8 w-8 place-items-center rounded-full text-muted hover:bg-surface hover:text-ink" aria-label="Close scanner"><X className="h-4 w-4" /></button>
        </div>
        <div className="relative overflow-hidden rounded-2xl bg-black">
          <video ref={videoRef} className="aspect-[4/3] w-full object-cover" muted playsInline />
          <div className="pointer-events-none absolute inset-x-8 top-1/2 h-24 -translate-y-1/2 rounded-xl border-2 border-white/80" />
        </div>
        {error ? <p className="mt-3 text-xs font-medium text-danger">{error}</p> : <p className="mt-3 text-xs text-muted">Point the camera at a barcode or SKU label. Each scan adds one to the order.{last && <> Last: <span className="font-mono text-ink">{last}</span></>}</p>}
        <button className="btn-primary mt-3 w-full" onClick={onClose}>Done</button>
      </div>
    </div>,
    document.body,
  );
}
