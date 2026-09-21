import { ReviewService } from "../server/service.ts";

// Safe to run repeatedly: reuses the persistent active manifest, never resets or deletes.
const service = new ReviewService();
const state = await service.getState();
console.log(
  JSON.stringify(
    {
      repo: state.repo,
      source: state.source,
      files: state.files.length,
      hunks: state.files.reduce((sum, file) => sum + file.hunks.length, 0),
    },
    null,
    2,
  ),
);
