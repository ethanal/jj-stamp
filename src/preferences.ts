import { useEffect, useState } from "react";

export type ColorScheme = "dark" | "dim" | "light";
export type SidebarSide = "files" | "log";
export const sidebarLimits = {
  files: { min: 120, max: 520, initial: 245 },
  log: { min: 160, max: 640, initial: 350 },
} as const;

export function parseColorScheme(value: string | null): ColorScheme {
  return value === "light" || value === "dim" ? value : "dark";
}
export function clampSidebarWidth(side: SidebarSide, width: number): number {
  const { min, max, initial } = sidebarLimits[side];
  return Number.isFinite(width)
    ? Math.round(Math.min(max, Math.max(min, width)))
    : initial;
}
export function parseSidebarWidth(
  side: SidebarSide,
  value: string | null,
): number {
  return value?.trim()
    ? clampSidebarWidth(side, Number(value))
    : sidebarLimits[side].initial;
}
export function resizeFromKey(
  side: SidebarSide,
  width: number,
  key: string,
  large = false,
): number | null {
  if (key === "Home") return sidebarLimits[side].min;
  if (key === "End") return sidebarLimits[side].max;
  if (key !== "ArrowLeft" && key !== "ArrowRight") return null;
  const direction =
    (key === "ArrowRight" ? 1 : -1) * (side === "files" ? 1 : -1);
  return clampSidebarWidth(side, width + direction * (large ? 40 : 10));
}
function readPreference(key: string): string | null {
  try {
    return localStorage.getItem(`jj-stamp.${key}`);
  } catch {
    return null;
  }
}
function usePreference<T extends string | number>(
  key: string,
  parse: (value: string | null) => T,
) {
  const [value, setValue] = useState(() => parse(readPreference(key)));
  useEffect(() => {
    try {
      localStorage.setItem(`jj-stamp.${key}`, String(value));
    } catch {
      // Browsing and resizing still work when preference storage is unavailable.
    }
  }, [key, value]);
  return [value, setValue] as const;
}
export function useAppearancePreferences() {
  const [colorScheme, setColorScheme] = usePreference(
    "color-scheme",
    parseColorScheme,
  );
  const [filesWidth, setFilesWidth] = usePreference("files-width", (value) =>
    parseSidebarWidth("files", value),
  );
  const [logWidth, setLogWidth] = usePreference("log-width", (value) =>
    parseSidebarWidth("log", value),
  );
  useEffect(() => {
    document.documentElement.dataset.colorScheme = colorScheme;
  }, [colorScheme]);
  return {
    colorScheme,
    setColorScheme,
    filesWidth,
    setFilesWidth,
    logWidth,
    setLogWidth,
  };
}
