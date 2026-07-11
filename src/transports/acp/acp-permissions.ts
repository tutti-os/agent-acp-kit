import type { AgentPermissionSelection } from "../../core/permissions.js";

export function choosePermissionOutcome(
  options: Array<{ kind?: string; optionId?: string }> = [],
  permission?: AgentPermissionSelection,
) {
  if (permission?.semantic !== "full-access") {
    return null;
  }
  return (
    options.find((option) => option.optionId === "approve_for_session")?.optionId ??
    options.find((option) => option.kind === "allow_always")?.optionId ??
    options.find((option) => option.kind === "allow_once")?.optionId ??
    options.find((option) => option.optionId === "allow")?.optionId ??
    options.find((option) => option.optionId === "approve")?.optionId ??
    null
  );
}
