import assert from "node:assert/strict";
import test from "node:test";
import {
  createSampleReviews,
  filterSamplePullRequests,
  resolveSamplePullRequest,
} from "../src/pr-review-prototype-data.ts";

test("sample PR input accepts numbers and current-repository HTTPS URLs", () => {
  for (const input of [
    "284",
    " #284 ",
    "https://github.com/orbit/notifications/pull/284",
    "https://github.com/orbit/notifications/pull/284/",
  ])
    assert.equal(resolveSamplePullRequest(input).pr?.number, 284);
});

test("sample PR input rejects foreign hosts/repos and malformed URL forms", () => {
  for (const input of [
    "",
    "0",
    "-284",
    "284.5",
    "1e3",
    "9007199254740993",
    "https://github.com/another/repo/pull/284",
    "http://github.com/orbit/notifications/pull/284",
    "https://github.com.evil.example/orbit/notifications/pull/284",
    "https://github.com:1234/orbit/notifications/pull/284",
    "https://user:pass@github.com/orbit/notifications/pull/284",
    "https://github.com/orbit/notifications/pull/284?redirect=evil",
    "https://github.com/orbit/notifications/pull/284#discussion",
    "javascript:alert(1)",
    "/orbit/notifications/pull/284",
  ])
    assert.ok(resolveSamplePullRequest(input).error, input);
  assert.match(
    resolveSamplePullRequest("99999").error!,
    /No network lookup was made/,
  );
});

test("sample list scopes, filtering, and current local-review membership", () => {
  assert.equal(filterSamplePullRequests("", "requested", []).length, 5);
  assert.equal(filterSamplePullRequests("", "all", []).length, 7);
  assert.deepEqual(
    filterSamplePullRequests("", "active", [284, 271]).map((pr) => pr.number),
    [284, 271],
  );
  assert.equal(filterSamplePullRequests("", "active", []).length, 0);
  assert.equal(filterSamplePullRequests("  MIRA  ", "requested", []).length, 2);
  assert.equal(filterSamplePullRequests("#284", "all", [])[0]?.number, 284);
  assert.equal(filterSamplePullRequests("no such PR", "all", []).length, 0);
});

test("prototype sessions never share mutable review/comment data", () => {
  const first = createSampleReviews();
  first[284].comments[0].body = "edited locally";
  first[284].comments.pop();
  first[284].refreshed = true;
  delete first[276];
  const second = createSampleReviews();
  assert.equal(second[284].comments.length, 2);
  assert.equal(second[284].refreshed, false);
  assert.notEqual(second[284].comments[0].body, "edited locally");
  assert.ok(second[276]);
});
