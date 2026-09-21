// Reproducible local benchmark. Only touches disposable real-jj fixtures.
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { parseArgs } from "node:util";
import { ReviewService } from "../server/service.ts";
import { jj, run } from "../server/process.ts";
import { createDemo } from "../tests/fixtures.ts";

const { values } = parseArgs({
  options: {
    runs: { type: "string", default: "3" },
    "extra-files": { type: "string", default: "0" },
  },
});
const runs = Number(values.runs),
  extraFiles = Number(values["extra-files"]);
if (
  !Number.isSafeInteger(runs) ||
  runs < 1 ||
  runs > 100 ||
  !Number.isSafeInteger(extraFiles) ||
  extraFiles < 0 ||
  extraFiles > 1000
)
  throw new Error("Use --runs 1..100 and --extra-files 0..1000.");
const results = new Map<string, Array<{ ms: number; calls: number }>>();
for (let i = 0; i < runs; i++) {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "jj-stamp-benchmark-"));
  try {
    const repoPath = await createDemo(dataDir);
    for (let file = 0; file < extraFiles; file++)
      await writeFile(
        path.join(repoPath, `extra-${file}.txt`),
        `extra file ${file}\n`,
      );
    // Exclude fixture snapshot cost from the comparison.
    await jj(repoPath, ["status"]);
    let calls = 0;
    const service = new ReviewService({
      dataDir,
      repoPath,
      jjRunner: (cwd, args) => {
        calls++;
        return jj(cwd, args);
      },
      toolRunner: (command, args, cwd) => {
        calls++;
        return run(command, args, cwd);
      },
    });
    async function measure<T>(
      name: string,
      task: () => Promise<T>,
    ): Promise<T> {
      calls = 0;
      const start = performance.now();
      const result = await task();
      const samples = results.get(name) ?? [];
      samples.push({ ms: performance.now() - start, calls });
      results.set(name, samples);
      return result;
    }
    const initial = await measure("Startup state", () => service.getState());
    await measure("Warm state", () => service.getState());
    await measure("Full log (compatibility API)", () => service.getLog());
    await measure("Graph rows (browser)", () =>
      service.getLog({ includeOutput: false }),
    );
    await measure("Switch change", () =>
      service.selectRevision({
        version: initial.version,
        changeId: initial.parent!.changeId,
      }),
    );
    await measure("Graph after switch (browser)", () =>
      service.getLog({ includeOutput: false }),
    );
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
}
const median = (values: number[]) =>
  values.sort((a, b) => a - b)[Math.floor(values.length / 2)];
console.log(
  `${runs} run(s), ${3 + extraFiles} changed files. Service-launched subprocesses; elapsed times are local medians.`,
);
console.table(
  [...results].map(([action, samples]) => ({
    action,
    milliseconds: Math.round(median(samples.map((sample) => sample.ms))),
    subprocesses: median(samples.map((sample) => sample.calls)),
  })),
);
