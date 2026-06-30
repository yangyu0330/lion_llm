import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const publicDir = join(__dirname, "public");
const memoryDir = join(__dirname, "memory");
const chatbotsPath = join(__dirname, "prompts", "chatbots.json");

const PORT = Number(process.env.PORT || 3000);
const OLLAMA_HOST = process.env.OLLAMA_HOST || "http://localhost:11434";
const DEFAULT_MODEL = "gemma3:1b";
const DEFAULT_BOT_ID = "maid";

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

async function readChatbotConfig() {
  const raw = await readFile(chatbotsPath, "utf8");
  const config = JSON.parse(raw);
  const chatbots = Array.isArray(config.chatbots) ? config.chatbots : [];

  if (!chatbots.length) {
    throw new Error("prompts/chatbots.json에 챗봇 설정이 없습니다.");
  }

  return {
    defaultBotId: config.defaultBotId || chatbots[0].id || DEFAULT_BOT_ID,
    chatbots
  };
}

function getBot(config, botId) {
  return (
    config.chatbots.find((bot) => bot.id === botId) ||
    config.chatbots.find((bot) => bot.id === config.defaultBotId) ||
    config.chatbots[0]
  );
}

function toPublicBot(bot) {
  return {
    id: bot.id,
    name: bot.name,
    shortName: bot.shortName || bot.name,
    avatar: bot.avatar || "AI",
    kind: bot.kind || "ollama",
    model: bot.model || "",
    description: bot.description || "",
    suggestions: Array.isArray(bot.suggestions) ? bot.suggestions : []
  };
}

function buildOllamaPrompt(bot) {
  const profileLines = Object.entries(bot.profile || {})
    .filter(([, value]) => value !== undefined && value !== null && String(value).trim() !== "")
    .map(([key, value]) => `- ${key}: ${value}`);
  const exampleLines = Array.isArray(bot.examples)
    ? bot.examples.flatMap((example, index) => [
        `Example ${index + 1} user: ${example.user}`,
        `Example ${index + 1} assistant: ${example.assistant}`
      ])
    : [];

  return {
    model: bot.model || DEFAULT_MODEL,
    system: [
      bot.role || "You are a helpful chatbot.",
      "",
      "Profile:",
      profileLines.length ? profileLines.join("\n") : "- No profile provided.",
      "",
      "Rules:",
      ...(bot.instructions || []).map((item) => `- ${item}`),
      "",
      "Examples:",
      ...(exampleLines.length ? exampleLines : ["- No examples provided."])
    ].join("\n")
  };
}

function sanitizeAssistantText(text) {
  return String(text ?? "")
    .replace(/어[\u2669-\u266f\u{1f300}-\u{1faff}\u{2600}-\u{27bf}]+히/gu, "어휴")
    .replace(/[\u2669-\u266f\u{1f300}-\u{1faff}\u{2600}-\u{27bf}\ufe0f]/gu, "")
    .replace(/[ \t]{2,}/g, " ");
}

async function fetchOllamaModels() {
  const response = await fetch(`${OLLAMA_HOST}/api/tags`);
  if (!response.ok) throw new Error(`Ollama responded with ${response.status}`);

  const data = await response.json();
  return (data.models || []).map((model) => model.name);
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

async function readExistingSession(sessionId) {
  try {
    return await readSessionFile(sessionId);
  } catch {
    return null;
  }
}

async function listSessions(res) {
  try {
    const config = await readChatbotConfig();
    const botNames = new Map(config.chatbots.map((bot) => [bot.id, bot.name]));

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
          botId: session.botId || "",
          botName: session.botName || botNames.get(session.botId) || "",
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

async function saveSessionMemory(sessionId, messages, options = {}) {
  await mkdir(memoryDir, { recursive: true });

  const now = new Date().toISOString();
  const filePath = join(memoryDir, `${sessionId}.json`);
  let existing = {};

  try {
    existing = JSON.parse(await readFile(filePath, "utf8"));
  } catch {
    existing = {};
  }

  const firstUserMessage = messages.find((message) => message.role === "user")?.content || "새 대화";
  const title = firstUserMessage.length > 40
    ? `${firstUserMessage.slice(0, 40)}...`
    : firstUserMessage;

  const memory = {
    id: sessionId,
    title,
    model: options.model ?? existing.model ?? "",
    botId: options.botId ?? existing.botId ?? "",
    botName: options.botName ?? existing.botName ?? "",
    gameState: options.gameState ?? existing.gameState,
    createdAt: existing.createdAt || now,
    updatedAt: now,
    messages
  };

  await writeFile(filePath, `${JSON.stringify(memory, null, 2)}\n`, "utf8");
}

async function proxyChatbots(res) {
  try {
    const config = await readChatbotConfig();
    sendJson(res, 200, {
      defaultBotId: config.defaultBotId,
      chatbots: config.chatbots.map(toPublicBot)
    });
  } catch (error) {
    sendJson(res, 500, {
      error: "챗봇 설정을 불러올 수 없습니다.",
      detail: error.message
    });
  }
}

async function proxyOllamaModels(res) {
  try {
    const [models, config] = await Promise.all([
      fetchOllamaModels(),
      readChatbotConfig()
    ]);
    const defaultBot = getBot(config, config.defaultBotId);
    const configuredModel = defaultBot.model || DEFAULT_MODEL;

    sendJson(res, 200, {
      models,
      configuredModel,
      configuredModelAvailable: models.includes(configuredModel),
      host: OLLAMA_HOST
    });
  } catch (error) {
    sendJson(res, 503, {
      error: "Ollama 서버에 연결할 수 없습니다. `ollama serve`가 실행 중인지 확인하세요.",
      detail: error.message
    });
  }
}

function createNumberGameState(bot) {
  const min = Number(bot.settings?.min ?? 1);
  const max = Number(bot.settings?.max ?? 100);

  return {
    min,
    max,
    target: Math.floor(Math.random() * (max - min + 1)) + min,
    attempts: 0
  };
}

function extractNumber(text) {
  const match = String(text).match(/-?\d+/);
  return match ? Number(match[0]) : null;
}

async function buildNumberGameReply(sessionId, messages, bot) {
  const existing = await readExistingSession(sessionId);
  let gameState = existing?.gameState;

  if (
    !gameState ||
    typeof gameState.target !== "number" ||
    typeof gameState.min !== "number" ||
    typeof gameState.max !== "number"
  ) {
    gameState = createNumberGameState(bot);
  }

  const userText = messages.filter((message) => message.role === "user").at(-1)?.content || "";
  const normalized = userText.replace(/\s+/g, "").toLowerCase();

  if (/규칙|방법|설명|도움/.test(normalized)) {
    return {
      gameState,
      content: [
        "존경하는 양유상 주인님, 제가 1부터 100 사이의 숫자 하나를 정해두었습니다.",
        "",
        "규칙:",
        "- 숫자를 하나 말해 주세요.",
        "- 정답보다 작으면 '업'이라고 말합니다.",
        "- 정답보다 크면 '다운'이라고 말합니다.",
        "- 맞히면 시도 횟수를 알려드리고 다음 판을 바로 시작합니다.",
        "",
        "첫 숫자를 말해 주십시오."
      ].join("\n")
    };
  }

  if (/게임시작|시작|새게임|새판|다시|재시작|리셋|reset|start/.test(normalized)) {
    gameState = createNumberGameState(bot);
    return {
      gameState,
      content: "존경하는 양유상 주인님, 새 게임을 시작했습니다. 1부터 100 사이의 숫자를 하나 말해 주십시오."
    };
  }

  if (/포기|정답/.test(normalized)) {
    const answer = gameState.target;
    gameState = createNumberGameState(bot);
    return {
      gameState,
      content: `존경하는 양유상 주인님, 이번 판의 정답은 ${answer}였습니다. 새 게임을 바로 시작했으니 1부터 100 사이의 숫자를 다시 말해 주십시오.`
    };
  }

  const guessedNumber = extractNumber(userText);

  if (guessedNumber === null) {
    return {
      gameState,
      content: "존경하는 양유상 주인님, 숫자 하나를 입력해 주십시오. 범위는 1부터 100까지입니다."
    };
  }

  if (guessedNumber < gameState.min || guessedNumber > gameState.max) {
    return {
      gameState,
      content: `존경하는 양유상 주인님, ${gameState.min}부터 ${gameState.max} 사이의 숫자로 다시 말씀해 주십시오.`
    };
  }

  gameState.attempts += 1;

  if (guessedNumber < gameState.target) {
    return {
      gameState,
      content: `업입니다, 존경하는 양유상 주인님. ${guessedNumber}보다 큰 숫자입니다. 현재 ${gameState.attempts}번째 시도입니다.`
    };
  }

  if (guessedNumber > gameState.target) {
    return {
      gameState,
      content: `다운입니다, 존경하는 양유상 주인님. ${guessedNumber}보다 작은 숫자입니다. 현재 ${gameState.attempts}번째 시도입니다.`
    };
  }

  const attempts = gameState.attempts;
  gameState = createNumberGameState(bot);

  return {
    gameState,
    content: `정답입니다, 존경하는 양유상 주인님. ${attempts}번 만에 맞히셨습니다. 다음 판을 바로 시작했으니 새 숫자를 하나 말해 주십시오.`
  };
}

async function streamStaticReply(res, sessionId, content, onBeforeDone) {
  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive"
  });

  res.write(`data: ${JSON.stringify({ sessionId })}\n\n`);
  res.write(`data: ${JSON.stringify({ content })}\n\n`);

  if (onBeforeDone) await onBeforeDone();

  res.write("event: done\ndata: {}\n\n");
  res.end();
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
    const config = await readChatbotConfig();
    const bot = getBot(config, body.botId || config.defaultBotId);
    const sessionId = getSessionId(body.sessionId);

    if (bot.kind === "number-updown") {
      const reply = await buildNumberGameReply(sessionId, messages, bot);
      const nextMessages = [...messages, { role: "assistant", content: reply.content }];

      await streamStaticReply(res, sessionId, reply.content, () =>
        saveSessionMemory(sessionId, nextMessages, {
          model: "local-game",
          botId: bot.id,
          botName: bot.name,
          gameState: reply.gameState
        })
      );
      return;
    }

    const prompt = buildOllamaPrompt(bot);
    const model = body.model || prompt.model;
    const availableModels = await fetchOllamaModels();

    if (!availableModels.includes(model)) {
      sendJson(res, 400, {
        error: `Ollama 모델 '${model}'이(가) 설치되어 있지 않습니다.`,
        detail: `터미널에서 'ollama pull ${model}' 실행 후 다시 시도하세요.`,
        installedModels: availableModels
      });
      return;
    }

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
    let rawAssistantContent = "";
    let assistantContent = "";

    for await (const chunk of ollamaResponse.body) {
      buffer += decoder.decode(chunk, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        if (!line.trim()) continue;
        const event = JSON.parse(line);
        if (event.message?.content) {
          rawAssistantContent += event.message.content;
          const nextAssistantContent = sanitizeAssistantText(rawAssistantContent);
          const contentDelta = nextAssistantContent.slice(assistantContent.length);
          assistantContent = nextAssistantContent;
          if (contentDelta) {
            res.write(`data: ${JSON.stringify({ content: contentDelta })}\n\n`);
          }
        }
        if (event.done) {
          await saveSessionMemory(sessionId, [
            ...messages,
            { role: "assistant", content: assistantContent }
          ], {
            model,
            botId: bot.id,
            botName: bot.name
          });
          res.write("event: done\ndata: {}\n\n");
          res.end();
          return;
        }
      }
    }

    await saveSessionMemory(sessionId, [
      ...messages,
      { role: "assistant", content: assistantContent }
    ], {
      model,
      botId: bot.id,
      botName: bot.name
    });
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

  if (req.method === "GET" && req.url?.startsWith("/api/chatbots")) {
    await proxyChatbots(res);
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
  console.log(`Chatbot UI: http://localhost:${PORT}`);
  console.log(`Ollama host: ${OLLAMA_HOST}`);
});
