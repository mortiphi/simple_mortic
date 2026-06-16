export function formatMs(ms: number | undefined): string {
  if (typeof ms !== "number") return "-";
  if (ms < 1000) return `${ms} ms`;
  return `${(ms / 1000).toFixed(1)} s`;
}

export function formatSignedMs(ms: number | undefined): string {
  if (typeof ms !== "number") return "-";
  const sign = ms >= 0 ? "+" : "-";
  return `${sign}${formatMs(Math.abs(ms))}`;
}

export function formatCount(value: number): string {
  return Math.max(0, Math.round(value)).toLocaleString();
}

export function formatBytes(value: number | undefined): string {
  if (typeof value !== "number") return "-";
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}

export function formatPercent(value: number | undefined): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return "unknown";
  return `${Math.round(value * 100)}%`;
}
