/**
 * Sanitize Codex tool-call `function.arguments` JSON before handing it
 * to DeepSeek Harness (DSH).
 *
 * Codex models often emit optional fields (`sandbox_permissions`,
 * `justification`, `max_goal_rounds`, empty `objective`) that DSH treats
 * as formal sandbox escalations / schema violations. Always strip
 * `sandbox_permissions` and `justification` — even `danger-full-access`
 * with a non-empty justification — because DSH rejects same-level
 * escalations when the session is already at that tier or approval is off.
 *
 * Parse failure → return the original string unchanged.
 */

export function sanitizeDshToolArguments(
  name: string,
  argumentsJson: string,
): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(argumentsJson);
  } catch {
    return argumentsJson;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return argumentsJson;
  }

  const args = { ...(parsed as Record<string, unknown>) };
  let changed = false;

  if ("sandbox_permissions" in args || "justification" in args) {
    delete args.sandbox_permissions;
    delete args.justification;
    changed = true;
  }

  if (name === "update_goal" && args.action !== "edit") {
    if ("max_goal_rounds" in args) {
      delete args.max_goal_rounds;
      changed = true;
    }
    if (args.objective === "") {
      delete args.objective;
      changed = true;
    }
  }

  return changed ? JSON.stringify(args) : argumentsJson;
}
