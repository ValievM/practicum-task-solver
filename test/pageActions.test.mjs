import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { afterEach, test } from "node:test";

const source = await readFile(new URL("../pageActions.js", import.meta.url), "utf8");
const { submitSolutionsInPage } = await import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`);
const original = { fetch: globalThis.fetch, window: globalThis.window, document: globalThis.document };
const taskId = "11111111-1111-1111-1111-111111111111";
const lessonId = "22222222-2222-2222-2222-222222222222";
const rules = {
  requestCount: 3,
  requestSpacingMs: 0,
  requestPathTemplate: "/api/tasks/{taskId}/solutions/",
  requestBody: { panes: [], solved: true },
  serverTrainerTypes: ["react"],
  serverCheckTimeoutMs: 1000,
  serverCheckPollMs: 1,
  checkSelectors: ["button.check"]
};

afterEach(() => {
  Object.assign(globalThis, original);
});

function prepare(handler) {
  const calls = [];
  const button = {
    disabled: false,
    clickCount: 0,
    click() { this.clickCount++; },
    closest() { return this; },
    getAttribute() { return null; },
    getBoundingClientRect() { return { width: 100, height: 30 }; }
  };
  globalThis.window = {
    location: { href: `https://practicum.yandex.ru/task/${taskId}/` },
    setTimeout,
    getComputedStyle() { return { display: "block", visibility: "visible" }; }
  };
  globalThis.document = { querySelectorAll() { return [button]; } };
  globalThis.fetch = async (url, options = {}) => {
    calls.push({ url, options });
    const { status = 200, data } = handler(url, options, calls);
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => data,
      text: async () => JSON.stringify(data)
    };
  };
  return { calls, button };
}

test("an HTTP 403 response stops client requests and reports failure", async () => {
  const { calls } = prepare((url) => {
    if (url.endsWith("/solutions/")) return { status: 403, data: { message: "Permission denied" } };
    if (url.includes("/lessons/")) return { data: { lesson_type: "web" } };
    return { data: { lesson_id: lessonId } };
  });
  const result = await submitSolutionsInPage(null, false, rules);
  assert.equal(result.success, false);
  assert.match(result.error, /Permission denied/);
  assert.equal(calls.filter(call => call.options.method === "POST").length, 1);
});

test("successful client tasks retain the three-request sequence", async () => {
  const { calls } = prepare((url) => {
    if (url.endsWith("/solutions/")) return { status: 201, data: { id: 1 } };
    if (url.includes("/lessons/")) return { data: { lesson_type: "web" } };
    return { data: { lesson_id: lessonId } };
  });
  const result = await submitSolutionsInPage(null, false, rules);
  assert.equal(result.success, true);
  assert.equal(calls.filter(call => call.options.method === "POST").length, 3);
});

test("server tasks click the normal check button and wait for saved success", async () => {
  let taskReads = 0;
  const { calls, button } = prepare((url) => {
    if (url.includes("/lessons/")) return { data: { lesson_type: "react" } };
    taskReads++;
    return { data: { lesson_id: lessonId, solved: taskReads > 1 } };
  });
  const result = await submitSolutionsInPage(null, false, rules);
  assert.equal(result.success, true);
  assert.equal(result.kind, "server-check");
  assert.equal(button.clickCount, 1);
  assert.ok(calls.every(call => !call.options.method));
});

test("an unpassed server check does not count as completion", async () => {
  const { calls } = prepare((url) => {
    if (url.includes("/lessons/")) return { data: { lesson_type: "react" } };
    return { data: { lesson_id: lessonId, solved: false } };
  });
  const result = await submitSolutionsInPage(null, false, { ...rules, serverCheckTimeoutMs: 5 });
  assert.equal(result.success, false);
  assert.match(result.error, /не засчитана/);
  assert.ok(calls.every(call => !call.options.method));
});

test("completed server tasks do not run another check", async () => {
  const { button } = prepare((url) => {
    if (url.includes("/lessons/")) return { data: { lesson_type: "react" } };
    return { data: { lesson_id: lessonId, solved: true } };
  });
  const result = await submitSolutionsInPage(null, false, rules);
  assert.equal(result.success, true);
  assert.equal(button.clickCount, 0);
});
