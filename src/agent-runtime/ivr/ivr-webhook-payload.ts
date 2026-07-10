/**
 * Webhook node request body — WH-1 variable whitelist + payload template.
 */

function substituteVars(text: string, variables: Record<string, string>): string {
  return text.replace(/\{\{([^}]+)\}\}/g, (_, key: string) => {
    const trimmed = key.trim();
    return variables[trimmed] ?? `{{${trimmed}}}`;
  });
}

export function buildWebhookRequestBody(
  nodeData: Record<string, unknown>,
  variables: Record<string, string>
): Record<string, unknown> {
  const eventType = (nodeData.eventType as string) || '';
  const includeVariables = (nodeData.includeVariables as string[]) ?? [];
  const payload = (nodeData.payload as Record<string, unknown>) ?? {};

  const resolvedPayload: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(payload)) {
    resolvedPayload[k] = typeof v === 'string' ? substituteVars(v, variables) : v;
  }

  const body: Record<string, unknown> = {
    event: eventType,
    ...resolvedPayload,
  };

  if (includeVariables.length > 0) {
    const vars: Record<string, string> = {};
    for (const key of includeVariables) {
      if (key in variables) vars[key] = variables[key];
    }
    body.variables = vars;
  }

  return body;
}
