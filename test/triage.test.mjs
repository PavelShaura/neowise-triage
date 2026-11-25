import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createApp, MAX_BODY_BYTES, MODEL_TIMEOUT_MS } from "../server.mjs";

const MANUAL_REVIEW = { status: "manual_review", topic: null, draft: null };

let server;
let baseUrl;

before(async () => {
  server = createApp({ log: () => {} });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(() => new Promise((resolve) => server.close(resolve)));

async function triage(rawBody, url = baseUrl) {
  const response = await fetch(`${url}/api/triage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: rawBody,
  });
  return { status: response.status, body: await response.json() };
}

const send = (text) => triage(JSON.stringify({ text }));

test("корректная заявка: тема и черновик", async () => {
  const { status, body } = await send("Когда будет доставка заказа?");
  assert.equal(status, 200);
  assert.equal(body.status, "ready");
  assert.equal(body.topic, "delivery");
  assert.ok(body.draft.trim().length > 0);
});

test("таймаут модели: manual_review не позже чем через ~300 мс", async () => {
  const started = performance.now();
  const { status, body } = await send("Где мой заказ? [timeout]");
  const elapsed = performance.now() - started;
  assert.equal(status, 200);
  assert.deepEqual(body, MANUAL_REVIEW);
  assert.ok(elapsed < MODEL_TIMEOUT_MS + 300, `ответ через ${Math.round(elapsed)} мс`);
});

for (const tag of ["[error]", "[bad-json]", "[bad-topic]", "[empty-draft]"]) {
  test(`сбой модели ${tag}: manual_review без темы и черновика`, async () => {
    const { status, body } = await send(`Вопрос по доставке ${tag}`);
    assert.equal(status, 200);
    assert.deepEqual(body, MANUAL_REVIEW);
  });
}

test("провайдер игнорирует signal: всё равно manual_review по таймауту", async () => {
  const app = createApp({ classify: () => new Promise(() => {}), timeoutMs: 50, log: () => {} });
  await new Promise((resolve) => app.listen(0, "127.0.0.1", resolve));
  try {
    const { status, body } = await triage(
      JSON.stringify({ text: "Сколько стоит?" }),
      `http://127.0.0.1:${app.address().port}`,
    );
    assert.equal(status, 200);
    assert.deepEqual(body, MANUAL_REVIEW);
  } finally {
    await new Promise((resolve) => app.close(resolve));
  }
});

const invalidBodies = {
  "битый JSON": "{text:",
  "пустое тело": "",
  "null": "null",
  "массив": '["текст"]',
  "нет поля text": "{}",
  "text не строка": '{"text":42}',
  "пустая строка": '{"text":""}',
  "строка из пробелов": '{"text":"  \\n\\t "}',
};

for (const [name, rawBody] of Object.entries(invalidBodies)) {
  test(`некорректный ввод (${name}): 400 invalid_input`, async () => {
    const { status, body } = await triage(rawBody);
    assert.equal(status, 400);
    assert.deepEqual(body, { status: "invalid_input" });
  });
}

test("слишком большое тело: 413 payload_too_large", async () => {
  const { status, body } = await send("а".repeat(MAX_BODY_BYTES));
  assert.equal(status, 413);
  assert.deepEqual(body, { status: "payload_too_large" });
});

test("страница отдаётся с CSP и nosniff", async () => {
  const response = await fetch(`${baseUrl}/`);
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-security-policy"), /frame-ancestors 'none'/);
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
});
