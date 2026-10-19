import { useCallback, useLayoutEffect, useState, type RefObject } from "react";
import type { DiffFile } from "./types";

/** Scroll tracking only drives the picker, not the file that owns line picks. */
export function useScrollActiveFile(
  enabled: boolean,
  files: DiffFile[] | undefined,
  activePath: string | undefined,
  scroll: RefObject<HTMLDivElement | null>,
  sections: RefObject<Map<string, HTMLElement>>,
) {
  const [visiblePath, setVisiblePath] = useState<string>();
  useLayoutEffect(() => {
    setVisiblePath(undefined);
    const viewport = scroll.current;
    if (!enabled || !viewport || !files?.length) return;
    let frame = 0;
    const update = () => {
      frame = 0;
      const top = viewport.getBoundingClientRect().top + 1;
      let path = files[0].path;
      // Section wrappers keep their height even when their diff is virtualized.
      // Follow the heading at the top rather than a partially visible next file.
      for (const file of files) {
        const section = sections.current.get(file.path);
        if (!section) continue;
        if (section.getBoundingClientRect().top > top) break;
        path = file.path;
      }
      // Short final files cannot reach the top; select them at the scroll end.
      if (
        viewport.scrollTop > 0 &&
        viewport.scrollTop + viewport.clientHeight >= viewport.scrollHeight - 1
      )
        path = files[files.length - 1].path;
      setVisiblePath(path);
    };
    const onScroll = () => {
      if (!frame) frame = requestAnimationFrame(update);
    };
    viewport.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      viewport.removeEventListener("scroll", onScroll);
      cancelAnimationFrame(frame);
    };
  }, [enabled, files, activePath, scroll, sections]);
  const reset = useCallback(() => setVisiblePath(undefined), []);
  return {
    path: enabled ? (visiblePath ?? activePath) : activePath,
    reset,
  };
}
