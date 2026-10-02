import { useEffect, useState, type HTMLAttributes } from "react";

/** A temporary overlay, independent of the persisted expanded preference. */
export function useSidebarReveal(expanded: boolean, enabled: boolean) {
  const [hovered, setHovered] = useState(false);
  const peeking = enabled && !expanded && hovered;
  useEffect(() => {
    setHovered(false);
  }, [expanded, enabled]);
  const dismiss = () => setHovered(false);
  const close = (element: HTMLElement) => {
    // Don't leave keyboard focus in content that is about to become hidden.
    if (peeking && element.contains(document.activeElement))
      element.querySelector<HTMLButtonElement>(".sidebar-toggle")?.focus();
    dismiss();
  };
  const handlers: HTMLAttributes<HTMLElement> = {
    onPointerEnter(event) {
      if (
        enabled &&
        !expanded &&
        event.pointerType !== "touch" &&
        !event.buttons
      )
        setHovered(true);
    },
    onPointerLeave(event) {
      close(event.currentTarget);
    },
    onPointerCancel(event) {
      close(event.currentTarget);
    },
    onKeyDownCapture(event) {
      if (peeking && event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        close(event.currentTarget);
      }
    },
  };
  return { peeking, visible: expanded || peeking, dismiss, handlers };
}
