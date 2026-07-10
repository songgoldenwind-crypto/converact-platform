/** Session variable side-effect when a branch handle is taken. */
export function applyBranchHandle(
  variables: Record<string, string>,
  branch: string | undefined
): Record<string, string> {
  if (!branch) return variables;
  return { ...variables, last_branch_handle: branch };
}

/** Record branch taken; when target is missing, set `_branch_miss` for observability. */
export function applyBranchRoute(
  variables: Record<string, string>,
  nodeId: string,
  branch: string | undefined,
  target: string | null | undefined
): Record<string, string> {
  if (!branch) return variables;
  const next = applyBranchHandle(variables, branch);
  if (target == null) {
    return { ...next, _branch_miss: `${nodeId}:${branch}` };
  }
  return next;
}
