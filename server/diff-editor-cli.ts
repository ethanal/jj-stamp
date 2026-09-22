import { applyDiffEditor } from "./diff-editor.ts";

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.length !== 3)
    throw new Error("Usage: diff-editor <manifest> <left> <right>");
  await applyDiffEditor(args[0], args[1], args[2]);
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
