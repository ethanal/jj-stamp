export type LanguageId =
  | "bash"
  | "c"
  | "cpp"
  | "cSharp"
  | "go"
  | "java"
  | "javascript"
  | "php"
  | "python"
  | "ruby"
  | "rust"
  | "tsx"
  | "typescript";

export function languageForPath(path: string): LanguageId | undefined {
  const name = path.split("/").at(-1)?.toLowerCase() ?? "";
  if (name === "rakefile") return "ruby";
  const extension = name.includes(".") ? name.split(".").at(-1) : undefined;
  switch (extension) {
    case "rs":
      return "rust";
    case "ts":
    case "mts":
    case "cts":
      return "typescript";
    case "tsx":
      return "tsx";
    case "js":
    case "jsx":
    case "mjs":
    case "cjs":
      return "javascript";
    case "py":
      return "python";
    case "go":
      return "go";
    case "java":
      return "java";
    case "c":
      return "c";
    case "cc":
    case "cpp":
    case "cxx":
    case "hh":
    case "hpp":
    case "hxx":
      return "cpp";
    case "cs":
      return "cSharp";
    case "rb":
    case "rake":
      return "ruby";
    case "php":
    case "phtml":
      return "php";
    case "sh":
    case "bash":
      return "bash";
    default:
      return;
  }
}

export function supportsHunkContext(path: string): boolean {
  return languageForPath(path) !== undefined;
}
