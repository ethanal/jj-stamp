import { z } from "zod";
import {
  colorSchemes,
  defaultLogRevset,
  type ColorScheme,
} from "./preference-values.ts";

/** Shared wire/disk format. Files may omit keys to use the defaults below. */
export const configSchema = z
  .object({
    "color-scheme": z.enum(
      Object.keys(colorSchemes) as [ColorScheme, ...ColorScheme[]],
    ),
    "font-size": z.number().int().min(10).max(24),
    "file-view": z.enum(["single", "all"]),
    "hover-sidebars": z.boolean(),
    "vim-mode": z.boolean(),
    "files-width": z.number().int().min(120).max(Number.MAX_SAFE_INTEGER),
    "log-width": z.number().int().min(160).max(Number.MAX_SAFE_INTEGER),
    "files-peek-width": z.number().int().min(120).max(Number.MAX_SAFE_INTEGER),
    "log-peek-width": z.number().int().min(160).max(Number.MAX_SAFE_INTEGER),
    "split-diff-ratio": z.number().int().min(20).max(80),
    "files-expanded": z.boolean(),
    "log-expanded": z.boolean(),
    "diff-style": z.enum(["unified", "split"]),
    "log-revset": z
      .string()
      .trim()
      .min(1)
      .max(4096)
      .refine((value) => !value.includes("\0")),
  })
  .strict();

export const configPatchSchema = configSchema.partial();
export type Config = z.infer<typeof configSchema>;
export const defaultConfig: Config = {
  "color-scheme": "dark",
  "font-size": 13,
  "file-view": "single",
  "hover-sidebars": false,
  "vim-mode": false,
  "files-width": 245,
  "log-width": 350,
  "files-peek-width": 245,
  "log-peek-width": 350,
  "split-diff-ratio": 50,
  "files-expanded": true,
  "log-expanded": true,
  "diff-style": "unified",
  "log-revset": defaultLogRevset,
};
