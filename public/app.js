const messagesEl = document.querySelector("#messages");
const formEl = document.querySelector("#chatForm");
const inputEl = document.querySelector("#promptInput");
const sendButton = document.querySelector("#sendButton");
const newChatButton = document.querySelector("#newChatButton");
const sessionListEl = document.querySelector("#sessionList");
const modelSelect = document.querySelector("#modelSelect");
const temperatureRange = document.querySelector("#temperatureRange");
const temperatureValue = document.querySelector("#temperatureValue");
const statusEl = document.querySelector("#status");
const chatTitleEl = document.querySelector("#chatTitle");
const chatSubtitleEl = document.querySelector("#chatSubtitle");
const botButtons = Array.from(document.querySelectorAll("[data-bot-id]"));

let chatbots = [];
let currentBotId = "maid";
let messages = [];
let isStreaming = false;
let currentSessionId = null;
let ollamaReady = false;

const fallbackBots = [
  {
    id: "maid",
    name: "나는 너의 메이드",
    shortName: "메이드",
    avatar: "M",
    kind: "ollama",
    model: "gemma3:1b",
    description: "기분을 풀어주는 공손한 메이드 챗봇",
    suggestions: [
      "오늘 너무 지쳤어. 기분 좀 풀어줘",
      "나 지금 의욕이 없어. 부드럽게 다독여줘",
      "내가 잘하고 있는지 모르겠어. 짧게 위로해줘"
    ]
  },
  {
    id: "number-updown",
    name: "숫자 업다운",
    shortName: "업다운",
    avatar: "UP",
    kind: "number-updown",
    description: "1부터 100 사이 숫자를 맞히는 업다운 게임 챗봇",
    suggestions: ["게임 시작", "50", "규칙 알려줘"]
  }
];

function getCurrentBot() {
  return chatbots.find((bot) => bot.id === currentBotId) || fallbackBots[0];
}

function setStatus(text, type = "") {
  statusEl.textContent = text;
  statusEl.className = `status ${type}`.trim();
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function removeEmptyState() {
  const empty = messagesEl.querySelector(".empty-state");
  if (empty) empty.remove();
}

function getEmptyStateHtml() {
  const bot = getCurrentBot();
  const suggestions = bot.suggestions?.length ? bot.suggestions : fallbackBots[0].suggestions;

  return `
    <div class="empty-state">
      <h2>${escapeHtml(bot.name)}</h2>
      <p>${escapeHtml(bot.description || "")}</p>
      <div class="suggestions">
        ${suggestions
          .map((prompt) => `
            <button type="button" data-prompt="${escapeHtml(prompt)}">
              ${escapeHtml(prompt)}
            </button>
          `)
          .join("")}
      </div>
    </div>
  `;
}

function renderEmptyState() {
  messagesEl.innerHTML = getEmptyStateHtml();
}

function addMessage(role, content = "", options = {}) {
  removeEmptyState();

  const bot = getCurrentBot();
  const messageEl = document.createElement("article");
  messageEl.className = `message ${role}${options.loading ? " loading" : ""}`;

  const avatarEl = document.createElement("div");
  avatarEl.className = "avatar";
  avatarEl.textContent = role === "assistant" ? bot.avatar || "AI" : "나";

  const bubbleEl = document.createElement("div");
  bubbleEl.className = "bubble";
  bubbleEl.innerHTML = escapeHtml(content);

  messageEl.append(avatarEl, bubbleEl);
  messagesEl.append(messageEl);
  messagesEl.scrollTop = messagesEl.scrollHeight;
  return { messageEl, bubbleEl };
}

function renderMessages(nextMessages) {
  messagesEl.innerHTML = "";

  if (!nextMessages.length) {
    renderEmptyState();
    return;
  }

  nextMessages.forEach((message) => {
    addMessage(message.role, message.content);
  });
}

function updateBotUi({ reset = false } = {}) {
  const bot = getCurrentBot();

  botButtons.forEach((button) => {
    const active = button.dataset.botId === currentBotId;
    button.classList.toggle("active", active);
    button.setAttribute("aria-selected", String(active));
  });

  chatTitleEl.textContent = bot.name;
  chatSubtitleEl.textContent = bot.description || "";

  const isGameBot = bot.kind === "number-updown";
  modelSelect.disabled = isGameBot;
  temperatureRange.disabled = isGameBot;

  if (isGameBot) {
    setStatus("게임 준비 완료", "ready");
  } else {
    setStatus(ollamaReady ? "Ollama 연결됨" : "Ollama 확인 중", ollamaReady ? "ready" : "");
  }

  if (reset) {
    messages = [];
    currentSessionId = null;
  }

  if (!messages.length) renderEmptyState();
  setActiveSession();
}

function setActiveSession() {
  sessionListEl.querySelectorAll(".session-item").forEach((item) => {
    item.classList.toggle("active", item.dataset.sessionId === currentSessionId);
  });
}

function formatSessionDate(value) {
  if (!value) return "";
  return new Intl.DateTimeFormat("ko-KR", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit"
  }).format(new Date(value));
}

async function loadChatbots() {
  try {
    const response = await fetch("/api/chatbots");
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "챗봇 설정을 불러오지 못했습니다.");

    chatbots = Array.isArray(data.chatbots) && data.chatbots.length ? data.chatbots : fallbackBots;
    currentBotId = data.defaultBotId || chatbots[0].id;

    botButtons.forEach((button) => {
      const bot = chatbots.find((item) => item.id === button.dataset.botId);
      if (!bot) return;
      button.querySelector("strong").textContent = bot.name;
      button.querySelector("span").textContent = bot.shortName || bot.description || bot.name;
    });
  } catch (error) {
    chatbots = fallbackBots;
    setStatus("챗봇 설정 오류", "error");
    console.warn(error);
  }
}

async function loadSessions() {
  try {
    const response = await fetch("/api/sessions");
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "세션 목록을 불러오지 못했습니다.");

    if (!data.sessions.length) {
      sessionListEl.innerHTML = '<div class="session-empty">저장된 대화가 없습니다.</div>';
      return;
    }

    sessionListEl.innerHTML = data.sessions
      .map((session) => `
        <button class="session-item" type="button" data-session-id="${escapeHtml(session.id)}">
          <span>${escapeHtml(session.title || "새 대화")}</span>
          <small>${escapeHtml(session.botName || session.model || "")} · ${escapeHtml(formatSessionDate(session.updatedAt))}</small>
        </button>
      `)
      .join("");
    setActiveSession();
  } catch (error) {
    sessionListEl.innerHTML = '<div class="session-empty">대화 목록 오류</div>';
    console.warn(error);
  }
}

async function openSession(sessionId) {
  if (isStreaming) return;

  try {
    const response = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}`);
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "세션을 불러오지 못했습니다.");

    currentSessionId = data.session.id;
    currentBotId = data.session.botId || currentBotId;
    messages = Array.isArray(data.session.messages) ? data.session.messages : [];
    updateBotUi();
    renderMessages(messages);
    setActiveSession();
    setStatus("대화 불러옴", "ready");
  } catch (error) {
    setStatus("대화 불러오기 실패", "error");
    console.warn(error);
  }
}

function setInputHeight() {
  inputEl.style.height = "auto";
  inputEl.style.height = `${Math.min(inputEl.scrollHeight, 180)}px`;
}

async function loadModels() {
  try {
    const response = await fetch("/api/models");
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "모델 목록을 불러오지 못했습니다.");

    modelSelect.innerHTML = "";

    const defaultOption = document.createElement("option");
    defaultOption.value = "";
    defaultOption.textContent = data.configuredModel
      ? `챗봇 기본 모델 (${data.configuredModel})`
      : "챗봇 기본 모델 사용";
    modelSelect.append(defaultOption);

    data.models.forEach((model) => {
      const option = document.createElement("option");
      option.value = model;
      option.textContent = model;
      modelSelect.append(option);
    });

    if (!data.models.length) {
      ollamaReady = false;
      setStatus("설치된 모델 없음", "error");
      return;
    }

    if (data.configuredModel && !data.configuredModelAvailable) {
      ollamaReady = false;
      setStatus(`${data.configuredModel} 설치 필요`, "error");
      return;
    }

    ollamaReady = true;
    updateBotUi();
  } catch (error) {
    ollamaReady = false;
    setStatus("Ollama 연결 실패", "error");
    console.warn(error);
  }
}

async function sendMessage(text) {
  if (!text.trim() || isStreaming) return;

  const bot = getCurrentBot();
  const userContent = text.trim();
  messages.push({ role: "user", content: userContent });
  addMessage("user", userContent);

  inputEl.value = "";
  setInputHeight();
  isStreaming = true;
  sendButton.disabled = true;
  setStatus(bot.kind === "number-updown" ? "판정 중" : "답변 생성 중", "ready");

  const { messageEl: assistantMessage, bubbleEl: assistantBubble } = addMessage("assistant", "", {
    loading: true
  });
  let assistantContent = "";

  try {
    const response = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sessionId: currentSessionId,
        botId: currentBotId,
        messages,
        model: bot.kind === "number-updown" ? undefined : modelSelect.value || undefined,
        temperature: Number(temperatureRange.value)
      })
    });

    if (!response.ok || !response.body) {
      const error = await response.json().catch(() => ({}));
      const message = [error.error, error.detail]
        .filter(Boolean)
        .join("\n");
      throw new Error(message || "응답을 받을 수 없습니다.");
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const events = buffer.split("\n\n");
      buffer = events.pop() || "";

      for (const eventText of events) {
        const dataLine = eventText
          .split("\n")
          .find((line) => line.startsWith("data: "));
        if (!dataLine) continue;

        const data = JSON.parse(dataLine.slice(6));
        if (data.sessionId) {
          currentSessionId = data.sessionId;
        }
        if (data.error) {
          throw new Error(data.error);
        }
        if (data.content) {
          assistantMessage.classList.remove("loading");
          assistantContent += data.content;
          assistantBubble.innerHTML = escapeHtml(assistantContent);
          messagesEl.scrollTop = messagesEl.scrollHeight;
        }
      }
    }

    messages.push({ role: "assistant", content: assistantContent });
    await loadSessions();
    setStatus(bot.kind === "number-updown" ? "게임 준비 완료" : "Ollama 연결됨", "ready");
  } catch (error) {
    assistantMessage.classList.remove("loading");
    assistantBubble.innerHTML = escapeHtml(`오류: ${error.message}`);
    setStatus("오류 발생", "error");
  } finally {
    assistantMessage.classList.remove("loading");
    isStreaming = false;
    sendButton.disabled = false;
    inputEl.focus();
  }
}

formEl.addEventListener("submit", (event) => {
  event.preventDefault();
  sendMessage(inputEl.value);
});

inputEl.addEventListener("input", setInputHeight);
inputEl.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    formEl.requestSubmit();
  }
});

newChatButton.addEventListener("click", () => {
  messages = [];
  currentSessionId = null;
  renderEmptyState();
  setActiveSession();
  inputEl.focus();
});

botButtons.forEach((button) => {
  button.addEventListener("click", () => {
    if (isStreaming) return;
    const nextBotId = button.dataset.botId;
    if (!nextBotId || nextBotId === currentBotId) return;
    currentBotId = nextBotId;
    updateBotUi({ reset: true });
    inputEl.focus();
  });
});

sessionListEl.addEventListener("click", (event) => {
  const item = event.target.closest("[data-session-id]");
  if (item) openSession(item.dataset.sessionId);
});

messagesEl.addEventListener("click", (event) => {
  const button = event.target.closest("[data-prompt]");
  if (button) sendMessage(button.dataset.prompt);
});

temperatureRange.addEventListener("input", () => {
  temperatureValue.textContent = temperatureRange.value;
});

async function boot() {
  await loadChatbots();
  renderEmptyState();
  await Promise.all([loadModels(), loadSessions()]);
  updateBotUi();
  setInputHeight();
}

boot();
