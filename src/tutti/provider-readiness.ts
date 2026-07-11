import type { AgentDetection } from "../core/provider-plugin.js";
import type { TuttiAgentProviderAvailability } from "./contracts.js";

export function isDetectedProviderAuthReady(
  authState: AgentDetection["authState"] | undefined,
  requiresKnownAuth: boolean,
) {
  if (authState === "missing" || authState === "expired") return false;
  if (authState === "unknown") return !requiresKnownAuth;
  return authState === "ok";
}

export function providerAuthAvailability(
  authState: AgentDetection["authState"],
  requiresKnownAuth: boolean,
): TuttiAgentProviderAvailability | undefined {
  if (authState === "missing") {
    return {
      status: "unavailable",
      reasonCode: "auth_required",
      detail: "Authentication is required.",
    };
  }
  if (authState === "expired") {
    return {
      status: "unavailable",
      reasonCode: "auth_expired",
      detail: "Authentication has expired.",
    };
  }
  if (authState === "unknown" && requiresKnownAuth) {
    return {
      status: "unknown",
      reasonCode: "auth_unknown",
      detail: "Authentication status is unknown.",
    };
  }
  return undefined;
}

export function localProviderReadinessReason(
  detection: AgentDetection | null | undefined,
  requiresKnownAuth: boolean,
) {
  if (!detection) return "Provider runtime was not detected.";
  const auth = providerAuthAvailability(
    detection.authState,
    requiresKnownAuth,
  );
  return auth?.detail ?? "Provider is not available.";
}
