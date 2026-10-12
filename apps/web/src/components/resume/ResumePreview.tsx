import { useEffect, useRef, useState } from "react";
import { AlertTriangle, Check, Scissors } from "lucide-react";
import { API_ORIGIN, errorMessage, usePreviewResumeMutation } from "../../lib/api";
import type { FitInfo, ResumeDoc, ResumeLayout } from "../../lib/types";
import { Badge, cx, Spinner } from "../ui";

const PAGE_W = 816; // 8.5in at 96px

/** The résumé exactly as it prints: rendered and page-fitted by the server, scaled to the panel. */
export function ResumePreview({ doc, layout, applicationId, onFit, className }: { doc: ResumeDoc; layout?: ResumeLayout; applicationId?: string; onFit?: (f: FitInfo) => void; className?: string }) {
  const [preview, { isLoading }] = usePreviewResumeMutation();
  const [html, setHtml] = useState("");
  const [fit, setFit] = useState<FitInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [height, setHeight] = useState(1056);
  const [width, setWidth] = useState(PAGE_W);
  const box = useRef<HTMLDivElement>(null);
  const frame = useRef<HTMLIFrameElement>(null);
  const key = JSON.stringify([doc, layout]);
  const fitRef = useRef(onFit);
  fitRef.current = onFit;

  // Re-render shortly after edits stop.
  useEffect(() => {
    let live = true;
    const t = setTimeout(() => {
      preview({ doc, layout, applicationId })
        .unwrap()
        .then((r) => {
          if (!live) return;
          setHtml(API_ORIGIN ? r.html.replaceAll("url(/resume-fonts/", `url(${API_ORIGIN}/resume-fonts/`) : r.html);
          setFit(r.fit);
          setError(null);
          fitRef.current?.(r.fit);
        })
        .catch((e) => live && setError(errorMessage(e)));
    }, 450);
    return () => {
      live = false;
      clearTimeout(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, applicationId]);

  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setWidth(el.clientWidth));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const scale = Math.min(1, width / (PAGE_W + 48));
  const onLoad = () => {
    const d = frame.current?.contentDocument;
    if (d) setHeight(Math.max(1056, d.documentElement.scrollHeight));
  };

  return (
    <div className={cx("flex min-w-0 flex-col", className)}>
      <div className="mb-2 flex min-h-7 flex-wrap items-center gap-2">
        {fit ? <FitBadge fit={fit} /> : <span className="text-[13px] text-muted">Rendering…</span>}
        {isLoading && fit && <Spinner className="h-3.5 w-3.5 text-muted" />}
        {error && <span className="text-[12px] text-coral">{error}</span>}
      </div>
      <div ref={box} className="relative overflow-hidden rounded-xl border border-line bg-[#eef0f3]" style={{ height: html ? height * scale : 480 }}>
        {html ? (
          <iframe
            ref={frame}
            title="Résumé preview"
            srcDoc={html}
            onLoad={onLoad}
            sandbox="allow-same-origin"
            className="absolute top-0 left-1/2 border-0"
            style={{ width: PAGE_W + 48, height, transform: `translateX(-50%) scale(${scale})`, transformOrigin: "top center" }}
          />
        ) : (
          <div className="grid h-full place-items-center">
            <Spinner className="h-5 w-5 text-muted" />
          </div>
        )}
      </div>
    </div>
  );
}

export function FitBadge({ fit }: { fit: FitInfo }) {
  const pages = `${fit.pages} page${fit.pages === 1 ? "" : "s"}`;
  if (!fit.limit) return <Badge tone="ink">{pages} · no page limit</Badge>;
  if (fit.overflow)
    return (
      <Badge tone="coral">
        <AlertTriangle className="h-3 w-3" /> {pages}, over your {fit.limit}-page limit at the smallest readable size
      </Badge>
    );
  return (
    <span className="flex flex-wrap items-center gap-1.5">
      <Badge tone="kelp">
        <Check className="h-3 w-3" /> Fits on {pages}
      </Badge>
      {fit.step > 0 && <Badge tone="ink">tightened · {fit.fontSize}pt</Badge>}
      {fit.cut.length > 0 && (
        <Badge tone="amber">
          <Scissors className="h-3 w-3" /> {fit.cut.length} lower-priority line{fit.cut.length === 1 ? "" : "s"} cut
        </Badge>
      )}
    </span>
  );
}
