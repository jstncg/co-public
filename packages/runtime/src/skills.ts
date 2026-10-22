import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, parse as parsePath, resolve } from "node:path";

export interface LoadedSkill {
  name: string;
  version: number;
  description: string;
  keywords: string[];
  path: string;
  instructions: string;
}

function files(root: string, depth = 0, budget = { remaining: 5_000 }): string[] {
  if (!existsSync(root) || !statSync(root).isDirectory() || depth > 5 || budget.remaining <= 0) return [];
  if (depth === 0) {
    const canonical = realpathSync(root);
    if (canonical === parsePath(canonical).root) return [];
  }
  const output: string[] = [];
  const entries = readdirSync(root, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of entries) {
    if (budget.remaining <= 0) break;
    budget.remaining -= 1;
    const path = resolve(root, entry.name);
    if (entry.isFile() && entry.name === "SKILL.md" && statSync(path).size <= 256 * 1_024 && !existsSync(resolve(dirname(path), "RETIRED"))) output.push(path);
    else if (entry.isDirectory() && !entry.name.startsWith(".")) output.push(...files(path, depth + 1, budget));
  }
  return output;
}

function frontmatter(raw: string): { fields: Record<string, string>; body: string } {
  if (!raw.startsWith("---\n")) return { fields: {}, body: raw };
  const end = raw.indexOf("\n---\n", 4);
  if (end < 0) return { fields: {}, body: raw };
  const fields: Record<string, string> = {};
  for (const line of raw.slice(4, end).split("\n")) {
    const match = line.match(/^([a-zA-Z0-9_-]+):\s*(.*)$/);
    if (match?.[1]) fields[match[1]] = (match[2] ?? "").replace(/^['"]|['"]$/g, "");
  }
  return { fields, body: raw.slice(end + 5).trim() };
}

function words(value: string): Set<string> {
  return new Set(value.toLowerCase().split(/[^a-z0-9]+/).filter((word) => word.length > 2));
}

type SelectableSkill = Pick<LoadedSkill, "name" | "description" | "keywords" | "instructions">;

export function selectSkills<T extends SelectableSkill>(skills: T[], query: string, limit = 3): T[] {
  const queryWords = words(query);
  return skills
    .map((skill) => {
      const target = words(`${skill.name} ${skill.description} ${skill.keywords.join(" ")}`);
      let score = skill.keywords.some((keyword) => query.toLowerCase().includes(keyword)) ? 5 : 0;
      for (const word of queryWords) if (target.has(word)) score += 1;
      return { skill, score };
    })
    .filter((item) => item.score > 0)
    .sort((left, right) => right.score - left.score || left.skill.name.localeCompare(right.skill.name))
    .slice(0, limit)
    .map((item) => item.skill);
}

export function formatSkills(selected: SelectableSkill[]): string {
  if (!selected.length) return "";
  return `ACTIVE SKILLS (trusted release-pinned procedures selected for this turn):\n${selected.map((skill) => `\n## ${skill.name}\n${skill.instructions}`).join("\n")}`;
}

export class SkillRegistry {
  readonly skills: LoadedSkill[];

  constructor(roots: string[]) {
    const byName = new Map<string, LoadedSkill>();
    // Earlier roots have higher precedence.
    for (const root of [...roots].reverse()) {
      const fromRoot = new Map<string, LoadedSkill>();
      for (const path of files(root).sort()) {
        const raw = readFileSync(path, "utf8");
        const parsed = frontmatter(raw);
        const name = parsed.fields.name || basename(dirname(path));
        const rawVersion = Number.parseInt(parsed.fields.version ?? "1", 10);
        const version = Number.isInteger(rawVersion) && rawVersion > 0 ? rawVersion : 1;
        const description = parsed.fields.description || parsed.body.split("\n").find((line) => line.trim())?.replace(/^#+\s*/, "") || name;
        const keywords = (parsed.fields.keywords ?? "").split(",").map((item) => item.trim().toLowerCase()).filter(Boolean);
        const skill = { name, version, description, keywords, path, instructions: parsed.body.slice(0, 30_000) };
        const current = fromRoot.get(name);
        if (!current || current.version < version) fromRoot.set(name, skill);
      }
      for (const [name, skill] of fromRoot) byName.set(name, skill);
    }
    this.skills = [...byName.values()].sort((left, right) => left.name.localeCompare(right.name));
  }

  select(query: string, limit = 3): LoadedSkill[] {
    return selectSkills(this.skills, query, limit);
  }

  format(selected: LoadedSkill[]): string {
    return formatSkills(selected);
  }
}
