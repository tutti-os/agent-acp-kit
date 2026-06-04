import type { AgentRunMessage } from "../core/provider-plugin.js";
import type { SkillMaterializationRecord } from "../core/skills.js";

export function composePromptWithSkills(input: {
  history?: AgentRunMessage[];
  prompt: string;
  skills: SkillMaterializationRecord[];
  systemPrompt?: string;
}) {
  const history = (input.history ?? [])
    .map((message) => `${message.role.toUpperCase()}:\n${message.content}`)
    .join("\n\n");
  const injectedSkills = input.skills.filter(
    (skill) =>
      skill.deliveryMode === "prompt-injection" ||
      skill.deliveryMode === "project-instructions",
  );
  const skillText =
    injectedSkills.length > 0
      ? `Skills:\n${input.skills
          .filter((skill) => injectedSkills.includes(skill))
          .map((skill) => {
            const base = `- ${skill.slug}${skill.materializedPath ? ` -> ${skill.materializedPath}` : ""}`;
            if (skill.content?.trim()) {
              return `${base}\n${skill.content.trim()}`;
            }
            return base;
          })
          .join("\n")}`
      : "";

  return [
    input.systemPrompt?.trim(),
    skillText,
    history,
    "Current request:",
    input.prompt,
  ]
    .filter(Boolean)
    .join("\n\n");
}

export function composePromptWithSystem(input: {
  prompt: string;
  systemPrompt?: string;
}) {
  return [input.systemPrompt?.trim(), input.prompt]
    .filter(Boolean)
    .join("\n\n");
}
