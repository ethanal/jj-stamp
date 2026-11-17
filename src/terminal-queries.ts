import type { GhosttyTerminal } from "ghostty-web";

export interface TerminalQuerySupport {
  primary: boolean;
  secondary: boolean;
}

// Match ghostty-web's upstream WASM device-attributes fix (2ede417). These report
// VT220/color, not unsupported sixel, clipboard, or advanced keyboard features.
const PRIMARY = "\x1b[?62;22c";
const SECONDARY = "\x1b[>1;10;0c";
const BATCH_CHARS = 4096;

/** Consume and free a fresh scratch terminal, never the user's terminal. */
export function detectTerminalQuerySupport(
  probe: Pick<GhosttyTerminal, "write" | "readResponse" | "free">,
): TerminalQuerySupport {
  try {
    probe.write("\x1b[c");
    const primary = /\x1b\[\?[0-9;]+c/.test(probe.readResponse() ?? "");
    probe.write("\x1b[>c");
    const secondary = /\x1b\[>[0-9;]+c/.test(probe.readResponse() ?? "");
    return { primary, secondary };
  } finally {
    probe.free();
  }
}

type State = "ground" | "escape" | "escape-intermediate" | "csi" | "string";

/**
 * Supply only DA1/DA2 replies missing from the shipped WASM. Native output is
 * never rewritten; DSR/cursor replies remain Ghostty's responsibility.
 *
 * Recognize 7-bit CSI c / 0c / >c / >0c across PTY chunks, with constant parser
 * state (no retained payload/parameter strings). OSC/DCS/APC/SOS/PM payload is
 * ignored. Like Ghostty, ESC interrupts any string, CAN/SUB cancel, OSC alone
 * ends on BEL, and C0/DEL do not cancel a CSI. Do not answer DA replies or
 * noncanonical/nonzero parameters, which could otherwise cause reply loops.
 */
export class TerminalQueryResponder {
  private state: State = "ground";
  private osc = false;
  private valid = false;
  private secondary = false;
  private parameter = false;

  constructor(private readonly native: TerminalQuerySupport) {}

  write(data: string, send: (response: string) => boolean): void {
    if (this.native.primary && this.native.secondary) return;
    let pending = "";
    let rejected = false;
    const reply = (response: string) => {
      if (rejected) return;
      if (pending.length + response.length > BATCH_CHARS) {
        if (!send(pending)) {
          rejected = true;
          pending = "";
          return;
        }
        pending = "";
      }
      pending += response;
    };
    for (const char of data) {
      const code = char.charCodeAt(0);
      if (code === 0x1b) {
        this.state = "escape";
        continue;
      }
      if (code === 0x18 || code === 0x1a) {
        this.state = "ground";
        continue;
      }
      if (this.state === "string") {
        if (this.osc && code === 7) this.state = "ground";
        continue;
      }
      if (code < 0x20 || code === 0x7f) continue;
      switch (this.state) {
        case "escape":
          if (char === "[") {
            this.state = "csi";
            this.valid = true;
            this.secondary = this.parameter = false;
          } else if ("]P_^X".includes(char)) {
            this.state = "string";
            this.osc = char === "]";
          } else if (code >= 0x20 && code <= 0x2f) {
            this.state = "escape-intermediate";
          } else {
            this.state = "ground";
          }
          break;
        case "escape-intermediate":
          if (code >= 0x30 && code <= 0x7e) this.state = "ground";
          break;
        case "csi":
          if (code >= 0x40 && code <= 0x7e) {
            if (char === "c" && this.valid) {
              if (
                this.secondary ? !this.native.secondary : !this.native.primary
              )
                reply(this.secondary ? SECONDARY : PRIMARY);
            }
            this.state = "ground";
          } else if (char === ">" && !this.parameter && !this.secondary) {
            this.secondary = true;
          } else if (char === "0") {
            this.parameter = true;
          } else {
            this.valid = false;
          }
          break;
      }
    }
    if (pending) send(pending);
  }
}
