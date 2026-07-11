export type AgentPermissionSemantic =
  | "ask-before-write"
  | "accept-edits"
  | "locked-down"
  | "auto"
  | "full-access"
  | "unconfigurable";

/**
 * A provider-neutral permission decision, optionally paired with the provider
 * mode id that produced it. Providers execute the semantic policy; the mode id
 * is retained so hosts can round-trip the composer's exact selection.
 */
export type AgentPermissionSelection = {
  readonly semantic: AgentPermissionSemantic;
  readonly modeId?: string;
};

/**
 * Workspace Apps are autonomous by default. Hosts can pass an explicit
 * selection to narrow permissions for an individual run.
 */
export const DEFAULT_AGENT_PERMISSION_SELECTION: AgentPermissionSelection =
  Object.freeze({ semantic: "full-access" });

const AGENT_PERMISSION_SEMANTICS: ReadonlySet<string> = new Set([
  "ask-before-write",
  "accept-edits",
  "locked-down",
  "auto",
  "full-access",
  "unconfigurable",
]);

export function isAgentPermissionSemantic(
  value: unknown,
): value is AgentPermissionSemantic {
  return typeof value === "string" && AGENT_PERMISSION_SEMANTICS.has(value);
}

export function resolveAgentPermissionSelection(
  permission: AgentPermissionSelection | undefined,
): AgentPermissionSelection {
  return permission ?? DEFAULT_AGENT_PERMISSION_SELECTION;
}
