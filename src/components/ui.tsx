/** Small form/layout primitives shared by the page's two tools. */

export const input =
  "w-full rounded-lg border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-blue-500/40 disabled:opacity-60";

export function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="space-y-4">
      <h3 className="text-xs font-semibold uppercase tracking-wide text-muted">{title}</h3>
      {children}
    </div>
  );
}

export function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <span className="mb-1 flex items-baseline justify-between gap-1.5">
        <span className="truncate text-sm font-medium">{label}</span>
        {hint && <span className="shrink-0 text-[11px] text-muted">{hint}</span>}
      </span>
      {children}
    </label>
  );
}

export function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border bg-background px-3 py-2">
      <div className="text-xs text-muted">{label}</div>
      <div className="truncate text-sm font-semibold" title={value}>
        {value}
      </div>
    </div>
  );
}
