export const terminalPanelLimits = { min: 96, initial: 240, review: 80 };

export function terminalPanelMaximum(
  workspace: number,
  log: number,
  reviewChrome = 0,
) {
  return Math.max(
    terminalPanelLimits.min,
    Math.floor(workspace - log - reviewChrome - terminalPanelLimits.review),
  );
}

export function clampTerminalHeight(height: number, maximum: number) {
  return Math.max(
    terminalPanelLimits.min,
    Math.min(maximum, Math.round(height)),
  );
}

export function terminalHeightFromKey(
  height: number,
  maximum: number,
  key: string,
  shift: boolean,
) {
  const step = shift ? 40 : 10;
  switch (key) {
    case "ArrowUp":
      return clampTerminalHeight(height + step, maximum);
    case "ArrowDown":
      return clampTerminalHeight(height - step, maximum);
    case "Home":
      return terminalPanelLimits.min;
    case "End":
      return maximum;
    default:
      return null;
  }
}

/** An interactive exit gets a fresh shell, but a broken startup executable
 * must not turn auto-respawn into an unbounded fork/reconnect loop. */
export class TerminalExitPolicy {
  private startedAt = 0;
  private rapidExits = 0;

  started(now: number) {
    this.startedAt = now;
  }

  interacted() {
    this.rapidExits = 0;
  }

  exited(now: number) {
    if (now - this.startedAt >= 2000) this.rapidExits = 0;
    return ++this.rapidExits <= 3;
  }
}
