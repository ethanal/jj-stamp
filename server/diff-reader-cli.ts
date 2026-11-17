import path from "node:path";
import { captureMergedParentFiles } from "./diff-reader.ts";

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.length !== 3)
    throw new Error("Usage: diff-reader <manifest> <left> <right>");
  // jj diff runs in its temporary directory and passes literal "left"/"right".
  // Other relative paths are not accepted or normalized away by the callback.
  await captureMergedParentFiles(
    args[0],
    args[1] === "left" ? path.resolve("left") : args[1],
    args[2] === "right" ? path.resolve("right") : args[2],
  );
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
