// MIT License
// Copyright (c) 2024-2026 narumitw (https://github.com/narumiruna/pi-extensions)
//
// The extension lifecycle, caching, and status-publishing patterns in this file
// are derived from pi-usage:
// https://github.com/narumiruna/pi-extensions/blob/486f5c553cfc60ee0cecc99fdd16b23b75b0fd5a/packages/pi-usage/src/usage.ts
//
// Code that is directly derived from pi-usage (runtime-auth resolution, origin
// validation, and OpenCode usage fetching) is intentionally isolated in
// `src/pi-usage-auth.ts` for easier review.

import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { formatUsage } from "./format.ts";
import { fetchOpenCodeUsage, OriginValidationError, resolveOpenCodeAuth } from "./pi-usage-auth.ts";
import type { FormatStyle, UsageReport } from "./types.ts";

export { formatUsage, formatWindow, formatDuration } from "./format.ts";
export type { UsageReport, UsageWindow, FormatStyle, FormatOptions } from "./types.ts";
export { resolveOpenCodeAuth, fetchOpenCodeUsage, OriginValidationError } from "./pi-usage-auth.ts";

const STATUS_KEY = "opencode-go-usage";
const PI_FOOTER_WIDGET_ID = "opencode-go-usage";
const PI_FOOTER_UPDATE_CHANNEL = "pi-footer:update-widget";
const PROVIDER_ID = "opencode-go";
const CACHE_TTL_MS = 5 * 60 * 1000;
const REFRESH_INTERVAL_MS = 5 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 15_000;
const SETTINGS_FILE = "pi-opencode-usage.json";

interface ExtensionSettings {
  style: FormatStyle;
}

const DEFAULT_SETTINGS: ExtensionSettings = { style: "regular" };

function settingsPath(): string {
  return join(getAgentDir(), SETTINGS_FILE);
}

async function loadSettings(): Promise<ExtensionSettings> {
  const path = settingsPath();
  try {
    const text = await readFile(path, "utf8");
    const parsed = JSON.parse(text) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const style = (parsed as ExtensionSettings).style;
      if (style === "compact" || style === "regular" || style === "plain") {
        return { style };
      }
    }
  } catch {
    // missing or malformed settings fall back to defaults
  }
  return DEFAULT_SETTINGS;
}

async function saveSettings(settings: ExtensionSettings): Promise<void> {
  const path = settingsPath();
  await mkdir(getAgentDir(), { recursive: true });
  await writeFile(path, `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600 });
}

export default function opencodeUsageExtension(pi: ExtensionAPI) {
  let activeCtx: ExtensionContext | undefined;
  let settings: ExtensionSettings = DEFAULT_SETTINGS;
  let lastReport: UsageReport | undefined;
  let refreshTimer: ReturnType<typeof setTimeout> | undefined;
  let abortController: AbortController | undefined;
  let refreshInFlight = false;
  let sessionActive = false;

  const clearTimers = () => {
    if (refreshTimer) clearTimeout(refreshTimer);
    refreshTimer = undefined;
  };

  const clearAbort = () => {
    abortController?.abort();
    abortController = undefined;
  };

  const safeSetStatus = (ctx: ExtensionContext, value: string | undefined) => {
    try {
      ctx.ui.setStatus(STATUS_KEY, value);
    } catch {
      // ignore stale context
    }
  };

  const publishPiFooterWidget = (value: string | undefined) => {
    // Loose integration with pi-footer: emit on its public event channel.
    // If pi-footer is not installed, the event is simply ignored.
    try {
      pi.events.emit(PI_FOOTER_UPDATE_CHANNEL, {
        widgetId: PI_FOOTER_WIDGET_ID,
        value: value ?? null,
      });
    } catch {
      // ignore event bus errors
    }
  };

  const publishReport = (ctx: ExtensionContext, report: UsageReport | undefined) => {
    if (!report) {
      safeSetStatus(ctx, undefined);
      publishPiFooterWidget(undefined);
      return;
    }

    const statusText = formatUsage(report, {
      style: settings.style,
      prefix: "opencode",
      showResetCountdown: true,
      fallback: "opencode —",
    });

    // For pi-footer's Pi Event Value widget we publish a plain value without
    // prefix, so users can supply their own icon/label in pi-footer.
    const widgetText = formatUsage(report, {
      style: "plain",
      showResetCountdown: true,
      fallback: "—",
    });

    safeSetStatus(ctx, statusText);
    publishPiFooterWidget(widgetText);
  };

  const refresh = async (ctx: ExtensionContext, reason: string) => {
    if (!sessionActive || refreshInFlight) return;
    refreshInFlight = true;

    try {
      const cacheValid =
        lastReport &&
        reason !== "manual" &&
        Date.now() - lastReport.fetchedAt.getTime() < CACHE_TTL_MS;

      if (cacheValid) {
        publishReport(ctx, lastReport);
        scheduleRefresh(ctx);
        return;
      }

      clearAbort();
      abortController = new AbortController();

      try {
        const auth = await resolveOpenCodeAuth(ctx);
        if (!auth) {
          if (ctx.model?.provider !== PROVIDER_ID) {
            publishReport(ctx, undefined);
          }
          return;
        }

        const report = await fetchOpenCodeUsage(auth, abortController.signal, REQUEST_TIMEOUT_MS);
        lastReport = report;
        publishReport(ctx, report);
        scheduleRefresh(ctx);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`[opencode-usage] ${message}`);

        if (error instanceof OriginValidationError) {
          safeSetStatus(ctx, "opencode proxy");
        } else {
          safeSetStatus(ctx, "opencode err");
        }
        scheduleRefresh(ctx);
      } finally {
        if (abortController?.signal.aborted === false) {
          abortController = undefined;
        }
      }
    } finally {
      refreshInFlight = false;
    }
  };

  const scheduleRefresh = (ctx: ExtensionContext) => {
    clearTimers();
    refreshTimer = setTimeout(() => {
      refreshTimer = undefined;
      refresh(ctx, "scheduled");
    }, REFRESH_INTERVAL_MS);
    refreshTimer.unref?.();
  };

  const reset = (ctx: ExtensionContext) => {
    clearTimers();
    clearAbort();
    lastReport = undefined;
    publishReport(ctx, undefined);
  };

  pi.on("session_start", async (_event, ctx) => {
    activeCtx = ctx;
    sessionActive = true;
    settings = await loadSettings();
    await refresh(ctx, "session_start");
  });

  pi.on("session_shutdown", () => {
    sessionActive = false;
    if (activeCtx) reset(activeCtx);
    activeCtx = undefined;
  });

  pi.on("model_select", (event, ctx) => {
    if (event.model?.provider === PROVIDER_ID) {
      lastReport = undefined;
      refresh(ctx, "model_select");
    } else if (activeCtx) {
      reset(activeCtx);
    }
  });

  pi.on("agent_start", (_event, ctx) => {
    // Auth may not be ready at model_select time (e.g. first request after
    // switching models). Trigger a refresh on the first run without awaiting,
    // so we do not delay the user's request.
    if (ctx.model?.provider === PROVIDER_ID && !lastReport) {
      refresh(ctx, "agent_start").catch(() => undefined);
    }
  });

  pi.registerCommand("opencode-usage", {
    description: "Refresh or configure OpenCode Go usage footer",
    handler: async (args, ctx) => {
      const subcommand = String(args ?? "").trim();

      if (subcommand === "style") {
        const styles: FormatStyle[] = ["compact", "regular", "plain"];
        const nextIndex = (styles.indexOf(settings.style) + 1) % styles.length;
        settings.style = styles[nextIndex] ?? "compact";
        await saveSettings(settings);
        if (lastReport) publishReport(ctx, lastReport);
        ctx.ui.notify(`OpenCode usage style: ${settings.style}`, "info");
        return;
      }

      if (subcommand) {
        ctx.ui.notify(`Unknown subcommand: ${subcommand}. Try /opencode-usage style.`, "error");
        return;
      }

      lastReport = undefined;
      await refresh(ctx, "manual");
      if (lastReport) {
        ctx.ui.notify(
          formatUsage(lastReport, {
            style: settings.style,
            prefix: "opencode",
            fallback: "OpenCode usage unavailable",
          }),
          "info",
        );
      } else {
        ctx.ui.notify("OpenCode usage unavailable", "warning");
      }
    },
  });
}
