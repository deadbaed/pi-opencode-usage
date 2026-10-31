import type { FormatOptions, FormatStyle, UsageReport, UsageWindow, WindowKey } from "./types.ts";

const LABELS: Record<WindowKey, { compact: string; regular: string; plain: string }> = {
  rolling: { compact: "r", regular: "rolling", plain: "" },
  weekly: { compact: "w", regular: "weekly", plain: "" },
  monthly: { compact: "m", regular: "monthly", plain: "" },
};

/**
 * Format a single usage window.
 */
export function formatWindow(
  key: WindowKey,
  window: UsageWindow | undefined,
  style: FormatStyle = "compact",
  showResetCountdown = true,
): string | undefined {
  if (!window) return undefined;
  if (window.status !== "ok" && window.status !== "rate-limited") return undefined;
  if (typeof window.percent !== "number" || !Number.isFinite(window.percent)) return undefined;

  const label = LABELS[key][style];
  const suffix = showResetCountdown && window.resetsAt ? ` ↻ ${formatDuration(window.resetsAt)}` : "";
  const value = `${Math.round(window.percent)}%${suffix}`;
  if (!label) return value;
  return `${label}:${value}`;
}

/**
 * Format a full usage report.
 *
 * Compact: `opencode r:0% · w:4% · m:2%`
 * Regular: `opencode rolling:0% · weekly:4% · monthly:2%`
 * Plain:   `opencode 0% · 4% · 2%`
 */
export function formatUsage(
  report: UsageReport,
  options: FormatOptions = {},
): string {
  const {
    style = "compact",
    separator = " · ",
    prefix,
    showResetCountdown = true,
    fallback = "—",
  } = options;

  const parts: string[] = [
    formatWindow("rolling", report.rolling, style, showResetCountdown),
    formatWindow("weekly", report.weekly, style, showResetCountdown),
    formatWindow("monthly", report.monthly, style, showResetCountdown),
  ].filter((part): part is string => Boolean(part));

  if (parts.length === 0) return fallback;

  const body = parts.join(separator);
  if (prefix) return `${prefix} ${body}`;
  return body;
}

/**
 * Format a duration from an ISO 8601 timestamp to a short human string.
 */
export function formatDuration(iso: string): string {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return "?";

  const diff = Math.max(0, ms - Date.now());
  const days = Math.floor(diff / 86_400_000);
  const hours = Math.floor((diff % 86_400_000) / 3_600_000);
  const minutes = Math.floor((diff % 3_600_000) / 60_000);

  if (days > 0) return `${days}d${hours}h`;
  if (hours > 0) return `${hours}h${minutes}m`;
  return `${minutes}m`;
}
