import { useEffect, useState } from "react";
import { CheckCircle2, Info, XCircle } from "lucide-react";
import { cx } from "./ui";

type Kind = "success" | "error" | "info";
interface T {
  id: number;
  text: string;
  kind: Kind;
}
let listeners: ((t: T) => void)[] = [];
let n = 0;
export function toast(text: string, kind: Kind = "info") {
  const t = { id: ++n, text, kind };
  listeners.forEach((l) => l(t));
}

export function Toaster() {
  const [items, setItems] = useState<T[]>([]);
  useEffect(() => {
    const l = (t: T) => {
      setItems((x) => [...x.slice(-3), t]);
      setTimeout(() => setItems((x) => x.filter((i) => i.id !== t.id)), 4500);
    };
    listeners.push(l);
    return () => {
      listeners = listeners.filter((x) => x !== l);
    };
  }, []);
  return (
    <div className="pointer-events-none fixed right-4 bottom-[calc(16px+env(safe-area-inset-bottom,0px))] z-50 flex w-[min(380px,calc(100vw-32px))] flex-col gap-2" role="status" aria-live="polite">
      {items.map((t) => (
        <div key={t.id} className="slide-up pointer-events-auto flex items-start gap-2.5 rounded-xl border border-line bg-card px-3.5 py-3 text-sm shadow-pop">
          {t.kind === "success" ? <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-kelp" /> : t.kind === "error" ? <XCircle className="mt-0.5 h-4 w-4 shrink-0 text-coral" /> : <Info className="mt-0.5 h-4 w-4 shrink-0 text-sea" />}
          <span className={cx("leading-snug")}>{t.text}</span>
        </div>
      ))}
    </div>
  );
}
