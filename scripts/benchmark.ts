// Reproducible local benchmark. Only touches disposable real-jj fixtures.
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { parseArgs } from "node:util";
import { ReviewService } from "../server/service.ts";
import type { OperationTiming } from "../server/timing.ts";
import { jj } from "../server/process.ts";
import { createDemo } from "../tests/fixtures.ts";

const { values } = parseArgs({
  options: {
    runs: { type: "string", default: "3" },
    "extra-files": { type: "string", default: "0" },
    trace: { type: "boolean", default: false },
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
const results = new Map<
  string,
  Array<{ ms: number; timing: OperationTiming }>
>();
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
    const timings: OperationTiming[] = [];
    const options = {
      repoPath,
      onTiming: (record: OperationTiming) => {
        timings.push(record);
      },
    };
    let service = new ReviewService(options);
    async function measure<T>(
      name: string,
      task: () => Promise<T>,
    ): Promise<T> {
      timings.length = 0;
      const start = performance.now();
      const result = await task();
      const ms = performance.now() - start;
      const timing = timings.pop();
      if (!timing) throw new Error(`Missing service timing for ${name}`);
      const samples = results.get(name) ?? [];
      samples.push({ ms, timing });
      results.set(name, samples);
      if (values.trace)
        console.error(JSON.stringify({ run: i + 1, action: name, ...timing }));
      return result;
    }
    const initial = await measure("Startup state", () => service.getState());
    await measure("Warm state", () => service.getState());
    await measure("Full log (compatibility API)", () => service.getLog());
    await measure("Graph rows (browser)", () =>
      service.getLog({ includeOutput: false }),
    );
    const selected = await measure("Switch to parent (uncached)", () =>
      service.selectRevision({
        version: initial.version,
        changeId: initial.parent!.changeId,
      }),
    );
    await measure("Graph after switch (browser)", () =>
      service.getLog({ includeOutput: false }),
    );
    await measure("Switch back (cached)", () =>
      service.selectRevision({
        version: selected.state.version,
        changeId: initial.source.changeId,
      }),
    );
    // Measure entering the LARGE diff on a miss, not just the small parent.
    // A separate session clears only the app cache, not the OS page cache.
    service = new ReviewService({
      ...options,
      revision: initial.parent!.changeId,
    });
    const parent = await service.getState();
    const returned = await measure("Switch to source (uncached)", () =>
      service.selectRevision({
        version: parent.version,
        changeId: initial.source.changeId,
      }),
    );
    const hunk = returned.state.files.flatMap((file) => file.hunks)[0];
    const squashed = await measure("Squash one hunk", () =>
      service.squashLines({
        version: returned.state.version,
        selections: [
          {
            id: hunk.id,
            lines: hunk.rows
              .filter((row) => /^[+-]/.test(row.raw))
              .map((row) => row.index),
          },
        ],
      }),
    );
    await measure("Graph after squash (browser)", () =>
      service.getLog({ includeOutput: false }),
    );
    await measure("Undo", () => service.undo(squashed.state.version));
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
    subprocesses: median(
      samples.map((sample) => sample.timing.subprocesses.length),
    ),
  })),
);
if (values.trace) {
  console.log(
    "Command totals (overlapping spans are summed, not wall time; nested tool commands are included in their parent span):",
  );
  console.table(
    [...results].flatMap(([action, samples]) => {
      const names = new Set(
        samples.flatMap((sample) =>
          sample.timing.subprocesses.map((span) => span.name),
        ),
      );
      return [...names].map((command) => ({
        action,
        command,
        calls: median(
          samples.map(
            (sample) =>
              sample.timing.subprocesses.filter((span) => span.name === command)
                .length,
          ),
        ),
        milliseconds: Math.round(
          median(
            samples.map((sample) =>
              sample.timing.subprocesses
                .filter((span) => span.name === command)
                .reduce((total, span) => total + span.durationMs, 0),
            ),
          ),
        ),
      }));
    }),
  );
}
