import { COMPUTER_SKILL_NAME } from "@oh-my-opencode/senpi-desktop-tool/registration"
import type { ContributedSkill } from "../bundled-skills/contributed-skill"

export function skillStatusLine(skill: ContributedSkill | undefined): string {
  if (skill?.kind !== "yielded") return ""
  const where = skill.ownerPath === undefined ? "" : ` (${skill.ownerPath})`
  return `\nskill: your own ${COMPUTER_SKILL_NAME} skill is active in place of the built-in guide${where}`
}
