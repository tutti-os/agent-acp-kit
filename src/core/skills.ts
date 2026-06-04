export type SkillMaterializationFile = {
  content: string;
  path: string;
};

export type SkillMaterializationRecord = {
  content?: string;
  files?: SkillMaterializationFile[];
  skillId: string;
  slug: string;
  materializedPath?: string;
  deliveryMode:
    | "materialized-files"
    | "prompt-injection"
    | "project-instructions";
};
