export type WindowKey = "rolling" | "weekly" | "monthly";

export type WindowStatus = "ok" | "rate-limited" | string;

export interface UsageWindow {
  /** Provider-reported status for this window. */
  status: WindowStatus;
  /** Usage percentage in the range [0, 100] (or higher for rate-limited). */
  percent: number;
  /** Optional ISO 8601 reset time. */
  resetsAt?: string;
}

export interface UsageReport {
  rolling?: UsageWindow;
  weekly?: UsageWindow;
  monthly?: UsageWindow;
  /** When the report was fetched from OpenCode. */
  fetchedAt: Date;
}

export type FormatStyle = "compact" | "regular" | "plain";

export interface FormatOptions {
  /** Display style for window labels. */
  style?: FormatStyle;
  /** Separator between windows. */
  separator?: string;
  /** Prefix shown before the windows. */
  prefix?: string;
  /** Include countdown to reset, e.g. `↻ 2h30m`. */
  showResetCountdown?: boolean;
  /** Fallback string when no windows are displayable. */
  fallback?: string;
}
