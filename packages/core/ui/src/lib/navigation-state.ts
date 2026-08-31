import type { NavigationTarget } from "../types.ts";

export function matchesNavigationTarget(
  current: NavigationTarget,
  target: NavigationTarget,
): boolean {
  return (
    current.type === target.type &&
    (current.type === "roll" && target.type === "roll"
      ? current.key === target.key
      : current.type === "agent" && target.type === "agent" && current.name === target.name)
  );
}

export function isConfigTargetHighlighted(
  current: NavigationTarget,
  target: NavigationTarget,
  overlayActive: boolean,
): boolean {
  if (overlayActive) {
    return false;
  }
  return matchesNavigationTarget(current, target);
}
