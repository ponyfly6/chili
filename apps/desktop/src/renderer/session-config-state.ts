export function sessionConfigAfterSelectionChange<Config>(
  previousSessionId: string | undefined,
  nextSessionId: string | undefined,
  current: Config | undefined,
): Config | undefined {
  return previousSessionId === nextSessionId ? current : undefined;
}

interface SessionScopedConfigAggregate {
  model: { sessionId: string };
  delegation: { sessionId: string };
  goal: { sessionId: string } | null;
}

export function sessionConfigResponseForSelection<Config extends SessionScopedConfigAggregate>(
  selectedSessionId: string | undefined,
  response: Config,
): Config | undefined {
  return selectedSessionId
    && response.model.sessionId === selectedSessionId
    && response.delegation.sessionId === selectedSessionId
    && (!response.goal || response.goal.sessionId === selectedSessionId)
    ? response
    : undefined;
}
