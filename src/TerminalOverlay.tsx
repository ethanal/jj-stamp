import { useCallback, useEffect, useId, useRef, useState } from "react";
import type { ITheme, Terminal } from "ghostty-web";
import type { ColorScheme } from "./preference-values";
import { terminalTheme } from "./terminal-theme";
import { TerminalInputQueue } from "./terminal-input";
import { useDialogBackdropDismiss } from "./useDialogBackdropDismiss";
import "./terminal-overlay.css";

type Phase = "loading" | "connecting" | "running" | "ended";

export function TerminalOverlay({
  disabled,
  fontSize,
  colorScheme,
  settingsSaving,
}: {
  disabled: boolean;
  fontSize: number;
  colorScheme: ColorScheme;
  settingsSaving: boolean;
}) {
  const id = useId();
  const dialog = useRef<HTMLDialogElement>(null);
  const container = useRef<HTMLDivElement>(null);
  const terminal = useRef<Terminal | null>(null);
  const fit = useRef<() => void>(() => {});
  const applyTheme = useRef<(theme: ITheme) => void>(() => {});
  const previousFocus = useRef<HTMLElement | null>(null);
  const backdropDismiss = useDialogBackdropDismiss();
  const [activated, setActivated] = useState(false);
  const [generation, setGeneration] = useState(0);
  const [phase, setPhase] = useState<Phase>("loading");
  const [message, setMessage] = useState("Loading terminal…");
  const [shell, setShell] = useState("");
  const [dimensions, setDimensions] = useState("");
  const [inputWarning, setInputWarning] = useState("");
  const appearance = useRef({ fontSize });
  appearance.current = { fontSize };

  const show = useCallback(() => {
    if (
      disabled ||
      (!activated && settingsSaving) ||
      document.querySelector("dialog[open]") ||
      !dialog.current
    )
      return;
    previousFocus.current =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    dialog.current.showModal();
    setActivated(true);
    fit.current();
    terminal.current?.focus();
  }, [disabled, activated, settingsSaving]);

  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (
        event.key !== "x" ||
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
    const subscriptions: Array<{ dispose(): void }> = [];
    setPhase("loading");
    setMessage("Loading terminal…");
    setShell("");
    setDimensions("");
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
        end("Terminal input backed up. Restart the shell to reconnect.");
        socket.close();
        return false;
      }
      socket.send(JSON.stringify(value));
      return true;
    };
    const inputQueue = new TerminalInputQueue((message) => {
      if (!send(message)) throw new Error("Terminal is disconnected");
    }, setInputWarning);

    void (async () => {
      try {
        const runtime = await import("./terminal-runtime");
        const [ghostty] = await Promise.all([
          runtime.loadGhostty(),
          document.fonts.ready,
        ]);
        if (disposed || !container.current) return;
        const theme = terminalTheme(getComputedStyle(document.documentElement));
        term = new runtime.Terminal({
          ghostty,
          fontFamily: '"Source Code Pro", monospace',
          fontSize: appearance.current.fontSize,
          theme,
          cursorBlink: true,
          scrollback: 5000,
          disableStdin: true,
        });
        terminal.current = term;
        term.open(container.current);
        container.current.setAttribute("aria-label", "Shell input");
        term.textarea?.setAttribute("aria-label", "Shell paste input");
        applyTheme.current = runtime.installTerminalTheme(term, theme);
        const addon = new runtime.FitAddon();
        term.loadAddon(addon);
        fit.current = () => {
          if (!dialog.current?.open || !term) return;
          const size = addon.proposeDimensions();
          if (size)
            term.resize(Math.min(500, size.cols), Math.min(300, size.rows));
        };
        fit.current();
        setDimensions(`${term.cols} × ${term.rows}`);
        observer = new ResizeObserver(() => fit.current());
        observer.observe(container.current);
        subscriptions.push(
          term.onResize(({ cols, rows }) => {
            setDimensions(`${cols} × ${rows}`);
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
        setMessage("Connecting to shell…");
        socket = new WebSocket(url);
        socket.onmessage = (event) => {
          if (disposed || !term) return;
          try {
            const value = JSON.parse(event.data);
            switch (value.type) {
              case "ready":
                ready = true;
                setShell(value.shell);
                setPhase("running");
                setMessage("Session running");
                term.options.disableStdin = false;
                send({ type: "resize", cols: term.cols, rows: term.rows });
                if (dialog.current?.open) term.focus();
                break;
              case "data":
                term.write(value.data);
                break;
              case "exit":
                end(`Shell exited (${value.exitCode}).`);
                break;
              case "error":
                end(value.message);
                break;
              default:
                throw new Error("Unexpected terminal message");
            }
          } catch {
            end("Invalid terminal response. Restart the shell to reconnect.");
            socket?.close();
          }
        };
        socket.onerror = () =>
          end("Could not connect to the shell. Restart to try again.");
        socket.onclose = () =>
          end("Terminal disconnected. Restart the shell to reconnect.");
      } catch (error) {
        end(
          `Could not start terminal: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    })();
    return () => {
      disposed = true;
      inputQueue.dispose();
      observer?.disconnect();
      subscriptions.forEach((subscription) => subscription.dispose());
      socket?.close();
      term?.dispose();
      terminal.current = null;
      fit.current = () => {};
      applyTheme.current = () => {};
      container.current?.replaceChildren();
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
        disabled={disabled || (!activated && settingsSaving)}
        aria-haspopup="dialog"
        aria-controls={id}
        title="Open terminal (x)"
        onClick={show}
      >
        Terminal
      </button>
      <dialog
        {...backdropDismiss}
        id={id}
        ref={dialog}
        className="terminal-dialog"
        aria-labelledby={`${id}-title`}
        aria-describedby={`${id}-help`}
        onCancel={(event) => {
          event.preventDefault();
          dialog.current?.close();
        }}
        onClose={() => {
          if (previousFocus.current?.isConnected)
            previousFocus.current.focus({ preventScroll: true });
          previousFocus.current = null;
        }}
        onKeyDownCapture={(event) => {
          if (event.key !== "Escape" || event.nativeEvent.isComposing) return;
          event.preventDefault();
          event.stopPropagation();
          dialog.current?.close();
        }}
        onKeyDown={(event) => event.stopPropagation()}
      >
        <header className="terminal-heading">
          <span className="terminal-mark" aria-hidden="true">
            &gt;_
          </span>
          <h2 id={`${id}-title`}>Terminal</h2>
          <span className="terminal-shell" title={shell}>
            {shell || "Native shell"}
          </span>
          <button
            type="button"
            className="action-button"
            disabled={
              phase === "loading" || phase === "connecting" || settingsSaving
            }
            onClick={() => {
              if (
                phase === "running" &&
                !window.confirm(
                  "Restart the shell? Running commands will be stopped.",
                )
              )
                return;
              setGeneration((value) => value + 1);
            }}
          >
            Restart shell
          </button>
          <button
            type="button"
            className="terminal-close"
            aria-label="Hide terminal"
            onClick={() => dialog.current?.close()}
          >
            ×
          </button>
        </header>
        <div
          className="terminal-surface"
          ref={container}
          data-phase={phase}
          aria-label="Shell terminal"
        />
        {phase !== "running" && (
          <p
            className={`terminal-notice ${phase === "ended" ? "terminal-failure" : ""}`}
            role="status"
          >
            {message}
          </p>
        )}
        {inputWarning && phase === "running" && (
          <p className="terminal-notice terminal-failure" role="status">
            {inputWarning}
          </p>
        )}
        <footer className="terminal-footer">
          <span id={`${id}-help`}>Escape to hide · session stays running</span>
          <span className="terminal-dimensions">
            Ghostty · {dimensions || "PTY"}
          </span>
        </footer>
      </dialog>
    </>
  );
}
