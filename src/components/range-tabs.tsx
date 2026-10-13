import Link from "next/link";
import { RANGE_LABELS, type RangeKey } from "@/lib/time";

/** Range selector rendered as links (?range=...), so it works without client JavaScript. */
export function RangeTabs({ basePath, options, active, extraParams }: { basePath: string; options: RangeKey[]; active: RangeKey; extraParams?: Record<string, string | undefined> }) {
  return <nav className="range-tabs" aria-label="ช่วงเวลา">
    {options.map((key) => {
      const params = new URLSearchParams({ range: key });
      for (const [name, value] of Object.entries(extraParams ?? {})) if (value) params.set(name, value);
      return <Link key={key} href={`${basePath}?${params.toString()}`} className={key === active ? "active" : ""} aria-current={key === active ? "page" : undefined}>{RANGE_LABELS[key]}</Link>;
    })}
  </nav>;
}
