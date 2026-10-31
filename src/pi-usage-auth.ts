// MIT License
// Copyright (c) 2024-2026 narumitw (https://github.com/narumiruna/pi-extensions)
//
// The code in this file is derived from pi-usage:
// - Runtime-auth resolution and origin validation:
//   https://github.com/narumiruna/pi-extensions/blob/486f5c553cfc60ee0cecc99fdd16b23b75b0fd5a/packages/pi-usage/src/query.ts
// - OpenCode usage normalization and response handling:
//   https://github.com/narumiruna/pi-extensions/blob/486f5c553cfc60ee0cecc99fdd16b23b75b0fd5a/packages/pi-usage/src/providers/opencode-zen.ts
//
// This file isolates those derived patterns so they are easy to review and
// audit separately from the rest of this project.

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { UsageReport, UsageWindow } from "./types.ts";

const USAGE_URL = "https://opencode.ai/zen/go/v1/usage";
const OFFICIAL_ORIGIN = "https://opencode.ai";
const PROVIDER_ID = "opencode-go";

// Pi runtime auth registry methods are not yet part of the public typing,
// so we declare the small surface we need.
type Model = NonNullable<ExtensionContext["model"]>;

type RequestAuth = {
  apiKey?: string;
  headers?: Record<string, string | null>;
  baseUrl?: string;
  env?: Record<string, string>;
};

type AuthRegistry = {
  getProvider?: (providerId: string) => { baseUrl?: string } | undefined;
  getApiKeyAndHeaders?: (
    model: Model,
  ) => Promise<({ ok: true } & RequestAuth) | { ok: false; error: string }>;
  getProviderAuth?: (
    providerId: string,
  ) => Promise<{ auth: RequestAuth; env?: Record<string, string>; source?: string } | undefined>;
};

export interface ResolvedAuth {
  headers: Record<string, string>;
  secrets: string[];
  effectiveBaseUrl: string;
}

export class OriginValidationError extends Error {
  override readonly name = "OriginValidationError";
}

function hasOrigin(baseUrl: string | undefined, origin: string): boolean {
  if (!baseUrl) return false;
  try {
    return new URL(baseUrl).origin === origin;
  } catch {
    return false;
  }
}

function headerValue(
  headers: Record<string, string | null> | undefined,
  name: string,
): string | undefined {
  const entry = Object.entries(headers ?? {}).find(
    ([key]) => key.toLowerCase() === name.toLowerCase(),
  );
  return entry?.[1] ?? undefined;
}

function authorizationFrom(auth: RequestAuth): string | undefined {
  return (
    headerValue(auth.headers, "Authorization") ??
    (auth.apiKey ? `Bearer ${auth.apiKey}` : undefined)
  );
}

/**
 * Resolve the active OpenCode Go authorization from Pi's runtime registry.
 * Throws OriginValidationError if the effective base URL is not the official origin.
 */
export async function resolveOpenCodeAuth(
  ctx: ExtensionContext,
): Promise<ResolvedAuth | undefined> {
  if (ctx.model?.provider !== PROVIDER_ID) return undefined;

  const registry = ctx.modelRegistry as unknown as AuthRegistry;
  const model = ctx.model;

  const providerBase = registry.getProvider?.(PROVIDER_ID)?.baseUrl;
  if (providerBase && !hasOrigin(providerBase, OFFICIAL_ORIGIN)) {
    throw new OriginValidationError(
      "Refusing to send OpenCode credentials from a custom provider base URL.",
    );
  }

  let selectedAuth: RequestAuth | undefined;
  if (typeof registry.getApiKeyAndHeaders === "function") {
    const result = await registry.getApiKeyAndHeaders(model);
    if (result.ok) selectedAuth = result;
  }

  const providerResult = await registry.getProviderAuth?.(PROVIDER_ID);
  const auth = selectedAuth ?? providerResult?.auth;
  if (!auth) return undefined;

  const effectiveBaseUrl =
    selectedAuth?.baseUrl ??
    providerResult?.auth.baseUrl ??
    providerBase ??
    model.baseUrl;

  if (!hasOrigin(effectiveBaseUrl, OFFICIAL_ORIGIN)) {
    throw new OriginValidationError(
      "Refusing to send OpenCode credentials to a non-official usage endpoint.",
    );
  }

  const authorization = authorizationFrom(auth);
  if (!authorization) return undefined;

  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(auth.headers ?? {})) {
    if (value !== null && value !== undefined) headers[name] = value;
  }
  if (!headerValue(headers, "Authorization")) {
    headers.Authorization = authorization;
  }

  const secrets = [
    auth.apiKey,
    headerValue(auth.headers, "Authorization"),
    authorization,
    providerResult?.auth.apiKey,
    headerValue(providerResult?.auth.headers, "Authorization"),
  ].filter((s): s is string => Boolean(s));

  return { headers, secrets, effectiveBaseUrl };
}

function normalizeWindow(value: unknown): UsageWindow | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const obj = value as Record<string, unknown>;
  if (typeof obj.status !== "string") return undefined;
  if (typeof obj.percent !== "number" || !Number.isFinite(obj.percent)) return undefined;
  const window: UsageWindow = { status: obj.status, percent: obj.percent };
  if (typeof obj.resetsAt === "string" && obj.resetsAt.trim()) {
    window.resetsAt = obj.resetsAt;
  }
  return window;
}

function redact(value: string, secrets: string[]): string {
  let result = value;
  for (const secret of [...new Set(secrets)].filter(Boolean).sort((a, b) => b.length - a.length)) {
    result = result.replaceAll(secret, "<redacted>");
  }
  return result.replace(/Bearer\s+\S+/gi, "Bearer <redacted>");
}

/**
 * Fetch OpenCode Go usage for the given auth.
 */
export async function fetchOpenCodeUsage(
  auth: ResolvedAuth,
  signal: AbortSignal,
  timeoutMs: number,
): Promise<UsageReport> {
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  signal.addEventListener("abort", onAbort, { once: true });

  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(USAGE_URL, {
      method: "GET",
      headers: {
        ...auth.headers,
        "User-Agent": "pi-opencode-usage",
      },
      redirect: "error",
      signal: controller.signal,
    });

    if (response.redirected) {
      throw new Error("OpenCode usage endpoint returned a redirect.");
    }

    const text = await response.text();
    if (!response.ok) {
      throw new Error(
        `OpenCode usage returned ${response.status}: ${redact(text, auth.secrets).slice(0, 200)}`,
      );
    }

    const payload = JSON.parse(text) as Record<string, unknown>;
    const usage =
      payload.usage && typeof payload.usage === "object" && !Array.isArray(payload.usage)
        ? (payload.usage as Record<string, unknown>)
        : {};

    return {
      rolling: normalizeWindow(usage.rolling),
      weekly: normalizeWindow(usage.weekly),
      monthly: normalizeWindow(usage.monthly),
      fetchedAt: new Date(),
    };
  } catch (error) {
    if ((error as Error).name === "AbortError") {
      throw new Error("OpenCode usage fetch aborted.");
    }
    throw error;
  } finally {
    clearTimeout(timeout);
    signal.removeEventListener("abort", onAbort);
  }
}
