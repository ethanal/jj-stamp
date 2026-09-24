import { inferHunkContexts } from "./hunk-context";
import {
  HUNK_CONTEXT_SCHEMA,
  type HunkContextRequest,
  type HunkContextResponse,
} from "./hunk-context-protocol";

// The client sends only one request at a time: no unbounded worker-side queue.
// A defensive busy check also protects against accidentally bypassing the client.
const scope = globalThis as unknown as {
  onmessage: (event: MessageEvent<HunkContextRequest>) => void;
  postMessage: (message: HunkContextResponse) => void;
};
let busy = false;
scope.onmessage = async ({ data }) => {
  const { id, schema, path, hunks, files } = data;
  if (busy || schema !== HUNK_CONTEXT_SCHEMA) {
    scope.postMessage({
      id,
      schema,
      error: "Scope worker busy or incompatible.",
    });
    return;
  }
  busy = true;
  try {
    const contexts = await inferHunkContexts(path, hunks, files);
    scope.postMessage({ id, schema, contexts });
  } catch (error) {
    scope.postMessage({
      id,
      schema,
      error: error instanceof Error ? error.message : "Scope inference failed.",
    });
  } finally {
    busy = false;
  }
};
