import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const publicDir = join(__dirname, "public");
const memoryDir = join(__dirname, "memory");
const promptPath = join(__dirname, "prompts", "personal-profile.json");

const PORT = Number(process.env.PORT || 3000);
const OLLAMA_HOST = process.env.OLLAMA_HOST || "http://localhost:11434";

const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml"
};

function sendJson(res, status, data) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(data));
}

async function readJsonBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? JSON.parse(raw) : {};
}

async function loadPersonalPrompt() {
  const raw = await readFile(promptPath, "utf8");
  const config = JSON.parse(raw);
  const profileLines = Object.entries(config.profile || {})
    .filter(([, value]) => value !== undefined && value !== null && String(value).trim() !== "")
    .map(([key, value]) => `- ${key}: ${value}`);

  return {
    model: config.model || "llama3.2",
    system: [
      config.role || "You are a helpful personal chatbot.",
      "",
      "Personal profile:",
      profileLines.length ? profileLines.join("\n") : "- No personal profile provided.",
      "",
      "Response rules:",
      ...(config.instructions || []).map((item) => `- ${item}`)
    ].join("\n")
  };
}

function createSessionId() {
  const timestamp = new Date()
    .toISOString()
    .replaceAll("-", "")
    .replaceAll(":", "")
    .replace(/\.\d{3}Z$/, "Z");
  return `session-${timestamp}-${randomUUID().slice(0, 8)}`;
}

function getSessionId(value) {
  if (typeof value === "string" && /^session-[a-zA-Z0-9TZ-]+$/.test(value)) {
    return value;
  }

  return createSessionId();
}

function isValidSessionId(value) {
  return typeof value === "string" && /^session-[a-zA-Z0-9TZ-]+$/.test(value);
}

async function readSessionFile(sessionId) {
  if (!isValidSessionId(sessionId)) {
    throw new Error("Invalid session id");
  }

  const filePath = join(memoryDir, `${sessionId}.json`);
  return JSON.parse(await readFile(filePath, "utf8"));
}

async function listSessions(res) {
  try {
    await mkdir(memoryDir, { recursive: true });
    const files = await readdir(memoryDir);
    const sessionFiles = files.filter((file) => /^session-[a-zA-Z0-9TZ-]+\.json$/.test(file));
    const sessions = [];

    for (const file of sessionFiles) {
      try {
        const session = JSON.parse(await readFile(join(memoryDir, file), "utf8"));
        sessions.push({
          id: session.id,
          title: session.title || "새 대화",
          model: session.model || "",
          createdAt: session.createdAt || "",
          updatedAt: session.updatedAt || ""
        });
      } catch {
        // Ignore broken workshop files so one malformed JSON does not break the UI.
      }
    }

    sessions.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
    sendJson(res, 200, { sessions });
  } catch (error) {
    sendJson(res, 500, {
      error: "세션 목록을 불러올 수 없습니다.",
      detail: error.message
    });
  }
}

async function getSession(req, res) {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const sessionId = decodeURIComponent(url.pathname.replace("/api/sessions/", ""));
    const session = await readSessionFile(sessionId);
    sendJson(res, 200, { session });
  } catch (error) {
    sendJson(res, 404, {
      error: "세션을 찾을 수 없습니다.",
      detail: error.message
    });
  }
}

async function saveSessionMemory(sessionId, messages, model) {
  await mkdir(memoryDir, { recursive: true });

  const now = new Date().toISOString();
  const filePath = join(memoryDir, `${sessionId}.json`);
  let createdAt = now;

  try {
    const existing = JSON.parse(await readFile(filePath, "utf8"));
    createdAt = existing.createdAt || now;
  } catch {
    createdAt = now;
  }

  const firstUserMessage = messages.find((message) => message.role === "user")?.content || "새 대화";
  const title = firstUserMessage.length > 40
    ? `${firstUserMessage.slice(0, 40)}...`
    : firstUserMessage;

  const memory = {
    id: sessionId,
    title,
    model,
    createdAt,
    updatedAt: now,
    messages
  };

  await writeFile(filePath, `${JSON.stringify(memory, null, 2)}\n`, "utf8");
}

async function proxyOllamaModels(res) {
  try {
    const response = await fetch(`${OLLAMA_HOST}/api/tags`);
    if (!response.ok) throw new Error(`Ollama responded with ${response.status}`);
    const data = await response.json();
    sendJson(res, 200, {
      models: (data.models || []).map((model) => model.name)
    });
  } catch (error) {
    sendJson(res, 503, {
      error: "Ollama 서버에 연결할 수 없습니다. `ollama serve`가 실행 중인지 확인하세요.",
      detail: error.message
    });
  }
}

async function streamChat(req, res) {
  let body;
  try {
    body = await readJsonBody(req);
  } catch {
    sendJson(res, 400, { error: "요청 JSON을 읽을 수 없습니다." });
    return;
  }

  const messages = Array.isArray(body.messages) ? body.messages : [];
  if (!messages.length) {
    sendJson(res, 400, { error: "messages 배열이 필요합니다." });
    return;
  }

  try {
    const prompt = await loadPersonalPrompt();
    const model = body.model || prompt.model;
    const sessionId = getSessionId(body.sessionId);
    const ollamaResponse = await fetch(`${OLLAMA_HOST}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        stream: true,
        messages: [
          { role: "system", content: prompt.system },
          ...messages
        ],
        options: {
          temperature: Number(body.temperature ?? 0.7)
        }
      })
    });

    if (!ollamaResponse.ok || !ollamaResponse.body) {
      const detail = await ollamaResponse.text();
      sendJson(res, ollamaResponse.status, {
        error: "Ollama 응답을 받을 수 없습니다.",
        detail
      });
      return;
    }

    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive"
    });

    res.write(`data: ${JSON.stringify({ sessionId })}\n\n`);

    const decoder = new TextDecoder();
    let buffer = "";
    let assistantContent = "";

    for await (const chunk of ollamaResponse.body) {
      buffer += decoder.decode(chunk, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        if (!line.trim()) continue;
        const event = JSON.parse(line);
        if (event.message?.content) {
          assistantContent += event.message.content;
          res.write(`data: ${JSON.stringify({ content: event.message.content })}\n\n`);
        }
        if (event.done) {
          await saveSessionMemory(sessionId, [
            ...messages,
            { role: "assistant", content: assistantContent }
          ], model);
          res.write("event: done\ndata: {}\n\n");
          res.end();
          return;
        }
      }
    }

    await saveSessionMemory(sessionId, [
      ...messages,
      { role: "assistant", content: assistantContent }
    ], model);
    res.write("event: done\ndata: {}\n\n");
    res.end();
  } catch (error) {
    if (!res.headersSent) {
      sendJson(res, 500, {
        error: "채팅 처리 중 오류가 발생했습니다.",
        detail: error.message
      });
      return;
    }
    res.write(`event: error\ndata: ${JSON.stringify({ error: error.message })}\n\n`);
    res.end();
  }
}

async function serveStatic(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const requestedPath = url.pathname === "/" ? "/index.html" : decodeURIComponent(url.pathname);
  const filePath = normalize(join(publicDir, requestedPath));

  if (!filePath.startsWith(publicDir)) {
    sendJson(res, 403, { error: "Forbidden" });
    return;
  }

  try {
    const file = await readFile(filePath);
    res.writeHead(200, {
      "Content-Type": mimeTypes[extname(filePath)] || "application/octet-stream"
    });
    res.end(file);
  } catch {
    sendJson(res, 404, { error: "Not found" });
  }
}

const server = createServer(async (req, res) => {
  if (req.method === "GET" && req.url?.startsWith("/api/sessions/")) {
    await getSession(req, res);
    return;
  }

  if (req.method === "GET" && req.url?.startsWith("/api/sessions")) {
    await listSessions(res);
    return;
  }

  if (req.method === "GET" && req.url?.startsWith("/api/models")) {
    await proxyOllamaModels(res);
    return;
  }

  if (req.method === "POST" && req.url?.startsWith("/api/chat")) {
    await streamChat(req, res);
    return;
  }

  if (req.method === "GET") {
    await serveStatic(req, res);
    return;
  }

  sendJson(res, 405, { error: "Method not allowed" });
});

server.listen(PORT, () => {
  console.log(`Personal chatbot UI: http://localhost:${PORT}`);
  console.log(`Ollama host: ${OLLAMA_HOST}`);
});
