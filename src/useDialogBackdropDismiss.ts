import { useRef, type MouseEvent, type PointerEvent } from "react";

function onBackdrop(event: MouseEvent<HTMLDialogElement>) {
  if (event.target !== event.currentTarget) return false;
  const box = event.currentTarget.getBoundingClientRect();
  return (
    event.clientX < box.left ||
    event.clientX >= box.right ||
    event.clientY < box.top ||
    event.clientY >= box.bottom
  );
}

/** Native dialog backdrops target the dialog itself, just like its padding. */
export function useDialogBackdropDismiss() {
  const startedOnBackdrop = useRef(false);
  return {
    onPointerDown(event: PointerEvent<HTMLDialogElement>) {
      startedOnBackdrop.current = event.button === 0 && onBackdrop(event);
    },
    onPointerCancel() {
      startedOnBackdrop.current = false;
    },
    onClick(event: MouseEvent<HTMLDialogElement>) {
      const dismiss = startedOnBackdrop.current;
      startedOnBackdrop.current = false;
      if (!dismiss || event.button !== 0 || !onBackdrop(event)) return;
      event.preventDefault();
      event.stopPropagation();
      event.currentTarget.close();
    },
  };
}
