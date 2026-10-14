import { useEffect, useRef, useState } from "react";
import { MapPin, X } from "lucide-react";
import { useJobLocationsQuery } from "../lib/api";
import type { PlaceOption } from "../lib/types";

const HEADINGS = { remote: "Remote", metro: "Metro areas", city: "Cities", region: "States & regions", country: "Countries" } as const;

/**
 * Location filter: type a city, metro, state, country, or "remote" and pick from grouped suggestions (with how many
 * open jobs each has). Several picks combine: a job in any of them matches.
 */
export function LocationFilter({ value, onChange }: { value: string[]; onChange: (keys: string[]) => void }) {
  const [q, setQ] = useState("");
  const [dq, setDq] = useState("");
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const t = setTimeout(() => setDq(q.trim().toLowerCase()), 150);
    return () => clearTimeout(t);
  }, [q]);
  // currentData: only suggestions for what's typed now, never the previous query's while the next one loads.
  const { currentData, data: last, isFetching } = useJobLocationsQuery({ q: dq, selected: value });
  const data = currentData;
  const flat: PlaceOption[] = data?.groups.flatMap((g) => g.items) ?? [];
  useEffect(() => setActive(0), [dq]);
  useEffect(() => {
    const close = (e: MouseEvent) => !box.current?.contains(e.target as Node) && setOpen(false);
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, []);

  const label = (key: string) => (data ?? last)?.selected.find((s) => s.key === key)?.label ?? key;
  const pick = (p: PlaceOption) => {
    onChange([...value, p.key]);
    setQ("");
    setActive(0);
  };
  const onKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setOpen(true);
      setActive((a) => Math.min(a + 1, flat.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((a) => Math.max(a - 1, 0));
    } else if (e.key === "Enter" && open && flat[active]) {
      e.preventDefault();
      pick(flat[active]);
    } else if (e.key === "Escape") setOpen(false);
    else if (e.key === "Backspace" && !q && value.length) onChange(value.slice(0, -1));
  };

  let i = -1;
  return (
    <div ref={box} className="relative min-w-[240px] flex-1">
      <div
        className="flex min-h-9 flex-wrap items-center gap-1 rounded-lg border border-line bg-card py-1 pr-2 pl-8 focus-within:border-ink/40"
        onClick={() => {
          setOpen(true);
          box.current?.querySelector("input")?.focus();
        }}
      >
        <MapPin className="pointer-events-none absolute top-2.5 left-3 h-4 w-4 text-faint" />
        {value.map((k) => (
          <span key={k} className="flex items-center gap-1 rounded-md bg-ink/[0.06] py-0.5 pr-1 pl-2 text-[12.5px]">
            {label(k)}
            <button
              aria-label={`Remove ${label(k)}`}
              className="rounded p-0.5 text-muted hover:text-ink"
              onClick={(e) => {
                e.stopPropagation();
                onChange(value.filter((v) => v !== k));
              }}
            >
              <X className="h-3 w-3" />
            </button>
          </span>
        ))}
        <input
          className="min-w-[110px] flex-1 bg-transparent text-[13.5px] outline-none placeholder:text-faint"
          placeholder={value.length ? "Add another place" : "Location: city, metro, state, country, or remote"}
          value={q}
          onChange={(e) => {
            setQ(e.target.value);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          onKeyDown={onKey}
          aria-label="Filter by location"
          role="combobox"
          aria-expanded={open}
          aria-controls="location-options"
        />
      </div>
      {open && (
        <div id="location-options" role="listbox" className="absolute top-full right-0 left-0 z-30 mt-1 max-h-[360px] overflow-auto rounded-xl border border-line bg-card p-1 shadow-lg">
          {!data && isFetching && <div className="px-3 py-2 text-[13px] text-muted">Finding places…</div>}
          {data && !flat.length && <div className="px-3 py-2 text-[13px] text-muted">{dq ? `No places with open jobs match “${q}”.` : "Type a city, state, or country."}</div>}
          {data?.groups.map((g) => (
            <div key={g.kind} className="py-1">
              <div className="px-3 pt-1 pb-0.5 text-[11px] font-semibold tracking-wide text-faint uppercase">{HEADINGS[g.kind]}</div>
              {g.items.map((p) => {
                i++;
                const idx = i;
                return (
                  <button
                    key={p.key}
                    role="option"
                    aria-selected={idx === active}
                    onMouseEnter={() => setActive(idx)}
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => pick(p)}
                    className={`flex w-full items-center justify-between gap-3 rounded-lg px-3 py-1.5 text-left text-[13.5px] ${idx === active ? "bg-ink/[0.06]" : ""}`}
                  >
                    <span className="truncate">{p.label}</span>
                    <span className="shrink-0 text-[12px] text-muted tabular-nums">{p.n.toLocaleString()}</span>
                  </button>
                );
              })}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
