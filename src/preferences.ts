import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useSyncExternalStore,
} from "react";
import type { Config } from "./config.ts";
import { configStore } from "./config-store.ts";
export * from "./preference-values.ts";

export const resetInvalidConfig = () => configStore.resetInvalid();

export function useConfigStatus() {
  return useSyncExternalStore(
    configStore.subscribe,
    configStore.getSnapshot,
    configStore.getServerSnapshot,
  );
}

export function usePreference<K extends keyof Config>(key: K) {
  const { config } = useConfigStatus();
  const setValue = useCallback(
    (action: Config[K] | ((previous: Config[K]) => Config[K])) => {
      configStore.set(key, action);
    },
    [key],
  );
  return [config[key], setValue] as const;
}
export function useAppearancePreferences() {
  const [logRevset, setLogRevset] = usePreference("log-revset");
  const [fontSize, setFontSize] = usePreference("font-size");
  useLayoutEffect(() => {
    document.documentElement.style.setProperty("--font-size", `${fontSize}px`);
  }, [fontSize]);
  const [vimMode, setVimMode] = usePreference("vim-mode");
  const [hoverSidebars, setHoverSidebars] = usePreference("hover-sidebars");
  const [fileView, setFileView] = usePreference("file-view");
  const [colorScheme, setColorScheme] = usePreference("color-scheme");
  const [filesWidth, setFilesWidth] = usePreference("files-width");
  const [logWidth, setLogWidth] = usePreference("log-width");
  const [filesPeekWidth, setFilesPeekWidth] = usePreference("files-peek-width");
  const [logPeekWidth, setLogPeekWidth] = usePreference("log-peek-width");
  useEffect(() => {
    document.documentElement.dataset.colorScheme = colorScheme;
  }, [colorScheme]);
  return {
    logRevset,
    setLogRevset,
    fontSize,
    setFontSize,
    vimMode,
    setVimMode,
    hoverSidebars,
    setHoverSidebars,
    fileView,
    setFileView,
    colorScheme,
    setColorScheme,
    filesWidth,
    setFilesWidth,
    logWidth,
    setLogWidth,
    filesPeekWidth,
    setFilesPeekWidth,
    logPeekWidth,
    setLogPeekWidth,
  };
}

export function useSplitDiffPreference() {
  return usePreference("split-diff-ratio");
}
