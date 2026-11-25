import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { classify as mockClassify } from "./mock-ai.mjs";

export const MODEL_TIMEOUT_MS = 300;
export const MAX_BODY_BYTES = 64 * 1024;
const TOPICS = new Set(["delivery", "pricing", "other"]);

const INVALID_INPUT = { status: "invalid_input" };
const PAYLOAD_TOO_LARGE = { status: "payload_too_large" };
const MANUAL_REVIEW = { status: "manual_review", topic: null, draft: null };

const html = await readFile(new URL("./index.html", import.meta.url));

const SECURITY_HEADERS = {
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
};

// Скрипт и стили встроены в index.html, поэтому 'unsafe-inline'. Главное здесь —
// запрет внешних ресурсов и запросов куда-либо, кроме своего API, и встраивания в iframe.
const HTML_CSP = [
  "default-src 'none'",
  "script-src 'unsafe-inline'",
  "style-src 'unsafe-inline'",
  "connect-src 'self'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join("; ");

function json(response, status, body) {
  response.writeHead(status, { ...SECURITY_HEADERS, "Content-Type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(body));
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Текст заявки из тела запроса или null, если ввод некорректный. */
export function parseInput(rawBody) {
  let body;
  try {
    body = JSON.parse(rawBody);
  } catch {
    return null;
  }
  if (!isPlainObject(body)) return null;
  const { text } = body;
  if (typeof text !== "string" || text.trim() === "") return null;
  return text;
}

/**
 * Проверка ответа модели. HTTP 200 от провайдера ничего не гарантирует:
 * принимаем только JSON-объект с темой из списка и непустым черновиком.
 * Возвращает { topic, draft } или null.
 */
export function parseModelOutput(raw) {
  if (typeof raw !== "string") return null;
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isPlainObject(data)) return null;
  const { topic, draft } = data;
  if (!TOPICS.has(topic)) return null;
  if (typeof draft !== "string" || draft.trim() === "") return null;
  return { topic, draft: draft.trim() };
}

/**
 * Ждём модель не дольше timeoutMs. AbortController останавливает работу провайдера,
 * Promise.race гарантирует ответ клиенту, даже если провайдер игнорирует signal.
 */
async function classifyWithTimeout(classify, text, timeoutMs) {
  const controller = new AbortController();
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new Error(`model timeout after ${timeoutMs} ms`));
    }, timeoutMs);
  });
  try {
    return await Promise.race([classify(text, { signal: controller.signal }), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Тело запроса строкой или null, если оно больше MAX_BODY_BYTES.
 * Лишнее дочитываем и выбрасываем, не храня в памяти, чтобы клиент
 * корректно получил ответ 413, а не обрыв соединения.
 */
async function readBody(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size <= MAX_BODY_BYTES) chunks.push(chunk);
  }
  return size > MAX_BODY_BYTES ? null : Buffer.concat(chunks).toString("utf8");
}

export function createApp({
  classify = mockClassify,
  timeoutMs = MODEL_TIMEOUT_MS,
  log = console.warn,
} = {}) {
  async function handleTriage(request, response) {
    const rawBody = await readBody(request);
    if (rawBody === null) return json(response, 413, PAYLOAD_TOO_LARGE);
    const text = parseInput(rawBody);
    if (text === null) return json(response, 400, INVALID_INPUT);

    let raw;
    try {
      raw = await classifyWithTimeout(classify, text, timeoutMs);
    } catch (error) {
      log(`[triage] manual_review: ${error.message}`);
      return json(response, 200, MANUAL_REVIEW);
    }

    const result = parseModelOutput(raw);
    if (result === null) {
      log("[triage] manual_review: invalid model output");
      return json(response, 200, MANUAL_REVIEW);
    }
    return json(response, 200, { status: "ready", ...result });
  }

  return createServer(async (request, response) => {
    if (request.method === "GET" && request.url === "/") {
      response.writeHead(200, {
        ...SECURITY_HEADERS,
        "Content-Security-Policy": HTML_CSP,
        "Content-Type": "text/html; charset=utf-8",
      });
      response.end(html);
      return;
    }
    if (request.method !== "POST" || request.url !== "/api/triage") {
      return json(response, 404, { status: "not_found" });
    }
    try {
      await handleTriage(request, response);
    } catch {
      json(response, 500, { status: "server_error" });
    }
  });
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  createApp().listen(Number(process.env.PORT || 3000), "127.0.0.1");
}
