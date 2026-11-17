import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import type { ITheme, Terminal } from "ghostty-web";
import type { ColorScheme } from "./preference-values";
import { terminalNativeTheme, terminalTheme } from "./terminal-theme";
import { TerminalInputQueue } from "./terminal-input";
import { TerminalResize } from "./TerminalResize";
import {
  clampTerminalHeight,
  TerminalExitPolicy,
  terminalPanelLimits,
  terminalPanelMaximum,
} from "./terminal-panel-state";
import "./terminal-panel.css";

type Phase = "loading" | "connecting" | "running" | "ended";

export function TerminalPanel({
  mount,
  open,
  onOpenChange,
  disabled,
  fontSize,
  colorScheme,
  settingsSaving,
}: {
  mount: HTMLElement | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  disabled: boolean;
  fontSize: number;
  colorScheme: ColorScheme;
  settingsSaving: boolean;
}) {
  const id = useId();
  const panel = useRef<HTMLElement>(null);
  const container = useRef<HTMLDivElement>(null);
  const terminal = useRef<Terminal | null>(null);
  const fit = useRef<() => void>(() => {});
  const applyTheme = useRef<(theme: ITheme) => void>(() => {});
  const previousFocus = useRef<HTMLElement | null>(null);

  const [activated, setActivated] = useState(false);
  const [generation, setGeneration] = useState(0);
  const [phase, setPhase] = useState<Phase>("loading");
  const [message, setMessage] = useState("");
  const [inputWarning, setInputWarning] = useState("");
  const [height, setHeight] = useState(terminalPanelLimits.initial);
  const [maximum, setMaximum] = useState(terminalPanelLimits.initial);
  const geometry = useRef({ cols: 80, rows: 24 });
  const visible = useRef(open);
  visible.current = open;
  const saving = useRef(settingsSaving);
  saving.current = settingsSaving;
  const exits = useRef(new TerminalExitPolicy());
  const appearance = useRef({ fontSize });
  appearance.current = { fontSize };

  const show = useCallback(() => {
    if (
      disabled ||
      (!activated && settingsSaving) ||
      document.querySelector("dialog[open]") ||
      !mount
    )
      return;
    if (!open)
      previousFocus.current =
        document.activeElement instanceof HTMLElement
          ? document.activeElement
          : null;

    onOpenChange(true);
    setActivated(true);
    fit.current();
    container.current?.focus({ preventScroll: true });
  }, [disabled, activated, settingsSaving, mount, open, onOpenChange]);

  const hide = () => {
    onOpenChange(false);
    if (previousFocus.current?.isConnected)
      previousFocus.current.focus({ preventScroll: true });
    previousFocus.current = null;
  };

  useLayoutEffect(() => {
    if (!mount?.parentElement) return;
    const workspace = mount.parentElement;
    const fileBar = workspace.querySelector(".file-bar");
    const measure = () => {
      const log =
        parseFloat(
          getComputedStyle(workspace).getPropertyValue("--log-height"),
        ) || 0;
      setMaximum(
        terminalPanelMaximum(
          workspace.clientHeight,
          log,
          fileBar?.getBoundingClientRect().height ?? 0,
        ),
      );
    };
    const observer = new ResizeObserver(measure);
    observer.observe(workspace);
    if (fileBar) observer.observe(fileBar);
    const log = workspace.querySelector(".log-panel");
    if (log) observer.observe(log);
    measure();
    return () => observer.disconnect();
  }, [mount]);

  useLayoutEffect(() => {
    if (open) {
      fit.current();
      container.current?.focus({ preventScroll: true });
    }
  }, [open]);

  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (
        event.key !== "t" ||
        event.defaultPrevented ||
        event.repeat ||
        event.ctrlKey ||
        event.metaKey ||
        event.altKey ||
        event.isComposing ||
        event
          .composedPath()
          .some(
            (node) =>
              node instanceof HTMLElement &&
              (node.closest("input, textarea, select, dialog") ||
                node.isContentEditable),
          )
      )
        return;
      event.preventDefault();
      show();
    };
    document.addEventListener("keydown", key);
    return () => document.removeEventListener("keydown", key);
  }, [show]);

  useEffect(() => {
    if (!activated) return;
    let disposed = false;
    let socket: WebSocket | undefined;
    let term: Terminal | undefined;
    let observer: ResizeObserver | undefined;
    let ready = false;
    let ended = false;
    let respawnTimer: ReturnType<typeof setTimeout> | undefined;
    const subscriptions: Array<{ dispose(): void }> = [];
    setPhase("loading");
    setMessage("");
    setInputWarning("");

    const end = (reason: string) => {
      if (disposed || ended) return;
      ended = true;
      ready = false;
      inputQueue.dispose();
      if (term) term.options.disableStdin = true;
      setPhase("ended");
      setMessage(reason);
    };
    const send = (value: unknown) => {
      if (socket?.readyState !== WebSocket.OPEN) return false;
      if (socket.bufferedAmount > 1024 * 1024) {
        end("Terminal input backed up. Retry to reconnect.");
        socket.close();
        return false;
      }
      socket.send(JSON.stringify(value));
      return true;
    };
    const inputQueue = new TerminalInputQueue((message) => {
      if (!send(message)) throw new Error("Terminal is disconnected");
    }, setInputWarning);
    const respawn = () => {
      if (disposed) return;
      if (saving.current) {
        respawnTimer = setTimeout(respawn, 100);
        return;
      }
      setGeneration((value) => value + 1);
    };

    void (async () => {
      try {
        const runtime = await import("./terminal-runtime");
        const [ghostty] = await Promise.all([
          runtime.loadGhostty(),
          document.fonts.ready,
        ]);
        if (disposed || !container.current) return;
        const theme = terminalTheme(getComputedStyle(document.documentElement));
        const nativeTheme = terminalNativeTheme(theme);
        term = new runtime.Terminal({
          ghostty,
          ...geometry.current,
          fontFamily: '"Source Code Pro", monospace',
          fontSize: appearance.current.fontSize,
          theme: nativeTheme,
          cursorBlink: true,
          scrollback: 5000,
          disableStdin: true,
        });
        terminal.current = term;
        // Ghostty 0.4 auto-focuses on open(), including an unguarded deferred
        // refocus. A dock must not steal focus from the review while WASM or a
        // respawn loads. Use its public element for synchronous explicit focus.
        let opening = true;
        term.focus = () => {
          if (
            !opening &&
            !disposed &&
            visible.current &&
            !document.querySelector("dialog[open]")
          )
            term?.element?.focus({ preventScroll: true });
        };
        term.open(container.current);
        opening = false;
        container.current.setAttribute("aria-label", "Shell input");
        term.textarea?.setAttribute("aria-label", "Shell paste input");
        applyTheme.current = runtime.installTerminalTheme(
          term,
          nativeTheme,
          theme,
        );
        // open() painted the native identity palette before the adapter existed.
        // Reused geometry needn't trigger a resize/full redraw to replace it.
        applyTheme.current(theme);
        const addon = new runtime.FitAddon();
        term.loadAddon(addon);
        fit.current = () => {
          if (!visible.current || !term) return;
          const size = addon.proposeDimensions();
          if (size) {
            const cols = Math.max(1, Math.min(500, size.cols));
            const rows = Math.max(1, Math.min(300, size.rows));
            if (cols !== term.cols || rows !== term.rows)
              term.resize(cols, rows);
          }
        };
        fit.current();
        geometry.current = { cols: term.cols, rows: term.rows };
        observer = new ResizeObserver(() => fit.current());
        observer.observe(container.current);
        subscriptions.push(
          term.onResize(({ cols, rows }) => {
            geometry.current = { cols, rows };
            if (ready) send({ type: "resize", cols, rows });
          }),
          term.onData((data) => {
            if (!ready) return;
            setInputWarning("");
            inputQueue.enqueue(data);
          }),
        );
        const url = new URL("/api/terminal", location.href);
        url.protocol = location.protocol === "https:" ? "wss:" : "ws:";
        url.searchParams.set("cols", String(term.cols));
        url.searchParams.set("rows", String(term.rows));
        setPhase("connecting");
        socket = new WebSocket(url);
        socket.onmessage = (event) => {
          if (disposed || ended || !term) return;
          try {
            const value = JSON.parse(event.data);
            switch (value.type) {
              case "ready":
                ready = true;
                setPhase("running");
                exits.current.started(performance.now());
                term.options.disableStdin = false;
                send({ type: "resize", cols: term.cols, rows: term.rows });
                if (
                  visible.current &&
                  container.current?.contains(document.activeElement) &&
                  !document.querySelector("dialog[open]")
                )
                  term.focus();

                break;
              case "data":
                term.write(value.data);
                break;
              case "exit":
                if (!Number.isInteger(value.exitCode))
                  throw new Error("Invalid exit response");
                if (!exits.current.exited(performance.now())) {
                  end("Shell keeps exiting. Check Terminal shell in Settings.");
                  break;
                }
                ended = true;
                ready = false;
                inputQueue.dispose();
                term.options.disableStdin = true;
                // Keep focus on the stable surface while its old textarea is
                // disposed, but don't take it back from the review or log.
                if (container.current?.contains(document.activeElement))
                  container.current.focus({ preventScroll: true });
                setPhase("connecting");
                respawnTimer = setTimeout(respawn, 200);
                break;
              case "error":
                end(value.message);
                break;
              default:
                throw new Error("Unexpected terminal message");
            }
          } catch {
            end("Invalid terminal response. Retry to reconnect.");
            socket?.close();
          }
        };
        socket.onerror = () =>
          end("Could not connect to the shell. Retry to reconnect.");
        socket.onclose = () =>
          end("Terminal disconnected. Retry to reconnect.");
      } catch (error) {
        end(
          `Could not start terminal: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    })();
    return () => {
      disposed = true;
      clearTimeout(respawnTimer);
      inputQueue.dispose();
      observer?.disconnect();
      subscriptions.forEach((subscription) => subscription.dispose());
      socket?.close();
      term?.dispose();
      terminal.current = null;
      fit.current = () => {};
      applyTheme.current = () => {};
      container.current?.replaceChildren();
      // Ghostty cleanup removes these attributes from the shared surface.
      container.current?.setAttribute("role", "textbox");
      container.current?.setAttribute("aria-label", "Shell input");
      container.current?.setAttribute("aria-multiline", "true");
    };
  }, [activated, generation]);

  useEffect(() => {
    // The root appearance effect updates CSS variables after children commit.
    // Read on the next frame so existing terminals pick up the selected theme.
    const frame = requestAnimationFrame(() => {
      if (!terminal.current) return;
      const theme = terminalTheme(getComputedStyle(document.documentElement));
      applyTheme.current(theme);
      terminal.current.options.fontSize = fontSize;
      fit.current();
    });
    return () => cancelAnimationFrame(frame);
  }, [colorScheme, fontSize]);

  return (
    <>
      <button
        className="action-button terminal-trigger"
        disabled={disabled || !mount || (!activated && settingsSaving)}
        aria-controls={id}
        aria-expanded={open}
        title="Open terminal (t)"
        onClick={show}
      >
        Terminal
      </button>
      {mount &&
        createPortal(
          <section
            id={id}
            ref={panel}
            className="terminal-panel"
            role="region"
            aria-labelledby={`${id}-title`}
            aria-busy={phase === "loading" || phase === "connecting"}
            hidden={!open}
            style={{ height: clampTerminalHeight(height, maximum) }}
            onKeyDownCapture={(event) => {
              if (container.current?.contains(event.target as Node)) {
                exits.current.interacted();
                // Loading a shell must not leak early keystrokes to review
                // shortcuts or browser defaults, nor queue them for replay.
                if (!terminal.current) event.preventDefault();
              }
              if (event.key !== "Escape" || event.nativeEvent.isComposing)
                return;
              event.preventDefault();
              event.stopPropagation();
              hide();
            }}
            onPasteCapture={() => exits.current.interacted()}
            onKeyDown={(event) => event.stopPropagation()}
          >
            <TerminalResize
              height={clampTerminalHeight(height, maximum)}
              maximum={maximum}
              onResize={setHeight}
              disabled={disabled || !open}
              controls={`${id}-surface`}
            />
            <header className="terminal-heading">
              <h2 id={`${id}-title`}>Terminal</h2>
              <button
                type="button"
                className="terminal-close"
                aria-label="Hide terminal"
                onClick={hide}
              >
                ×
              </button>
            </header>
            <div
              id={`${id}-surface`}
              className="terminal-surface"
              ref={container}
              data-phase={phase}
              role="textbox"
              aria-label="Shell input"
              aria-multiline="true"
              aria-readonly={phase !== "running"}
              tabIndex={0}
            />
            {phase === "ended" && (
              <div className="terminal-notice terminal-failure" role="status">
                <span>{message}</span>
                <button
                  type="button"
                  className="action-button"
                  disabled={settingsSaving}
                  onClick={() => {
                    exits.current.interacted();
                    container.current?.focus({ preventScroll: true });
                    setGeneration((value) => value + 1);
                  }}
                >
                  Retry
                </button>
              </div>
            )}
            {inputWarning && phase === "running" && (
              <p className="terminal-notice terminal-failure" role="status">
                {inputWarning}
              </p>
            )}
          </section>,
          mount,
        )}
    </>
  );
}
