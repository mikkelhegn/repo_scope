(() => {
  "use strict";

  const SUGGESTIONS = [
    {
      tag: "Architecture",
      repo: "spinframework/spin",
      title: "Map how Spin itself is put together",
      prompt:
        "Explain the architecture of spinframework/spin. What are the main crates and how do they fit together?",
    },
    {
      tag: "Tooling",
      repo: "facebook/react",
      title: "Trace the build and release setup",
      prompt:
        "What do facebook/react's package.json, scripts, and build configuration tell us about its tooling and release process?",
    },
    {
      tag: "Comparison",
      repo: "vitejs/vite vs webpack/webpack",
      title: "Compare two bundlers' testing setups",
      prompt:
        "Compare the testing and build setups of vitejs/vite and webpack/webpack. What are the main differences?",
    },
    {
      tag: "Activity",
      repo: "microsoft/vscode",
      title: "See what changed recently",
      prompt:
        "Summarize the last 20 commits on microsoft/vscode's default branch. Which areas are active, and are there any notable changes?",
    },
    {
      tag: "Design",
      repo: "honojs/hono",
      title: "Follow error handling and middleware",
      prompt:
        "How does honojs/hono handle errors and middleware? Point to the relevant files and summarize the design.",
    },
    {
      tag: "Onboarding",
      repo: "rust-lang/rust",
      title: "Find the best place to start reading",
      prompt:
        "I'm new to rust-lang/rust. Summarize the repository layout, the main entry points, and where I should start reading.",
    },
  ];

  const state = {
    history: [],
    loading: false,
    abort: null,
    authRequired: false,
    model: "",
    started: false,
    shouldStick: true,
  };

  const $ = (selector) => document.querySelector(selector);

  const el = {
    boot: $("#boot"),
    gate: $("#gate"),
    gateForm: $("#gateForm"),
    gateToken: $("#gateToken"),
    gateBtn: $("#gateBtn"),
    gateError: $("#gateError"),
    app: $("#app"),
    modelText: $("#modelText"),
    helpBtn: $("#helpBtn"),
    helpModal: $("#helpModal"),
    helpClose: $("#helpClose"),
    newChatBtn: $("#newChatBtn"),
    thread: $("#thread"),
    welcome: $("#welcome"),
    suggestions: $("#suggestions"),
    messages: $("#messages"),
    input: $("#input"),
    sendBtn: $("#sendBtn"),
    stopBtn: $("#stopBtn"),
    toast: $("#toast"),
  };

  let toastTimer = 0;

  // --------------------------------------------------------------- startup

  async function init() {
    renderSuggestions();
    bindEvents();

    try {
      const response = await fetch("/api/health", {
        headers: { accept: "application/json" },
      });
      if (!response.ok) throw new Error(`health check failed (${response.status})`);
      const health = await response.json();

      state.model = typeof health.model === "string" ? health.model : "";
      state.authRequired = Boolean(health.authRequired);
      el.modelText.textContent = state.model
        ? `openai · ${state.model}`
        : "openai";

      if (health.authRequired && !health.authed) {
        showGate();
        return;
      }
      showApp();
    } catch (error) {
      showApp();
      toast(
        "Could not reach the API. Check that the Spin app is running and the API built.",
      );
    }
  }

  function showApp() {
    el.boot.classList.add("hidden");
    el.gate.classList.add("hidden");
    el.app.classList.remove("hidden");
    if (!state.started) {
      state.started = true;
    }
    autoResize();
    el.input.focus();
  }

  function showGate() {
    el.boot.classList.add("hidden");
    el.app.classList.add("hidden");
    el.gate.classList.remove("hidden");
    el.gateToken.focus();
  }

  function renderSuggestions() {
    el.suggestions.innerHTML = SUGGESTIONS.map(
      (suggestion, index) => `
        <button class="suggestion" type="button" data-suggestion="${index}">
          <span class="s-tag">${escapeHtml(suggestion.tag)} · ${escapeHtml(suggestion.repo)}</span>
          <span class="s-title">${escapeHtml(suggestion.title)}</span>
        </button>`,
    ).join("");
  }

  // --------------------------------------------------------------- events

  function bindEvents() {
    el.gateForm.addEventListener("submit", async (event) => {
      event.preventDefault();
      const token = el.gateToken.value.trim();
      if (!token) return;

      el.gateBtn.disabled = true;
      el.gateError.textContent = "";
      try {
        const response = await fetch("/api/auth", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ token }),
        });
        if (!response.ok) {
          el.gateError.textContent = "That token was not accepted.";
          return;
        }
        showApp();
      } catch {
        el.gateError.textContent = "Could not reach the server.";
      } finally {
        el.gateBtn.disabled = false;
      }
    });

    el.suggestions.addEventListener("click", (event) => {
      const button = event.target.closest("[data-suggestion]");
      if (!button) return;
      const suggestion = SUGGESTIONS[Number(button.dataset.suggestion)];
      if (suggestion) send(suggestion.prompt);
    });

    el.sendBtn.addEventListener("click", () => send());
    el.stopBtn.addEventListener("click", () => {
      if (state.abort) state.abort.abort();
    });

    el.input.addEventListener("keydown", (event) => {
      if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
        event.preventDefault();
        send();
      }
    });
    el.input.addEventListener("input", () => {
      autoResize();
      updateComposer();
    });

    el.newChatBtn.addEventListener("click", resetChat);

    el.helpBtn.addEventListener("click", () => {
      el.helpModal.classList.remove("hidden");
      el.helpClose.focus();
    });
    el.helpClose.addEventListener("click", closeHelp);
    el.helpModal.addEventListener("click", (event) => {
      if (event.target === el.helpModal) closeHelp();
    });
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape") closeHelp();
    });

    el.thread.addEventListener("scroll", () => {
      state.shouldStick = nearBottom();
    });

    document.addEventListener("click", async (event) => {
      const button = event.target.closest(".copy-btn");
      if (!button) return;
      const block = button.closest(".codeblock, .tool-code");
      const code = block ? block.querySelector("code") : null;
      if (!code) return;
      try {
        await copyText(code.textContent);
        const previous = button.textContent;
        button.textContent = "Copied";
        setTimeout(() => {
          button.textContent = previous;
        }, 1200);
      } catch {
        toast("Could not copy to the clipboard.");
      }
    });
  }

  function closeHelp() {
    el.helpModal.classList.add("hidden");
  }

  function resetChat() {
    if (state.loading && state.abort) state.abort.abort();
    state.history = [];
    state.loading = false;
    state.abort = null;
    state.shouldStick = true;
    el.messages.innerHTML = "";
    el.welcome.classList.remove("hidden");
    el.input.value = "";
    autoResize();
    updateComposer();
    el.thread.scrollTop = 0;
    el.input.focus();
  }

  // --------------------------------------------------------------- chat

  async function send(suggestedPrompt) {
    if (state.loading) return;

    const prompt = (
      typeof suggestedPrompt === "string" ? suggestedPrompt : el.input.value
    ).trim();
    if (!prompt) return;

    el.welcome.classList.add("hidden");
    appendUser(prompt);
    el.input.value = "";
    autoResize();

    const assistant = createAssistant();
    state.loading = true;
    state.shouldStick = true;
    updateComposer();

    const controller = new AbortController();
    state.abort = controller;
    let sawDone = false;
    let sawError = false;

    try {
      const response = await fetch("/api/chat", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/x-ndjson",
        },
        body: JSON.stringify({ prompt, history: state.history }),
        signal: controller.signal,
      });

      if (!response.ok) {
        let message = `Request failed (${response.status})`;
        try {
          const data = await response.json();
          if (data && typeof data.error === "string") message = data.error;
        } catch {
          // keep the status-based message
        }
        throw new Error(message);
      }

      if (!response.body) throw new Error("The server returned no response body.");

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { value, done } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        let newline = buffer.indexOf("\n");
        while (newline !== -1) {
          const line = buffer.slice(0, newline).trim();
          buffer = buffer.slice(newline + 1);
          if (line) {
            let event;
            try {
              event = JSON.parse(line);
            } catch {
              event = null;
            }
            if (event) {
              if (event.t === "done") sawDone = true;
              if (event.t === "error") sawError = true;
              handleEvent(assistant, event);
            }
          }
          newline = buffer.indexOf("\n");
        }
      }

      if (buffer.trim()) {
        try {
          handleEvent(assistant, JSON.parse(buffer));
          if (JSON.parse(buffer).t === "done") sawDone = true;
        } catch {
          // ignore an incomplete trailing line
        }
      }

      if (!sawDone && !sawError) {
        assistant.error(
          "The stream ended before the agent finished. Please try again.",
        );
      }
    } catch (error) {
      if (error && error.name === "AbortError") {
        assistant.stopped();
      } else {
        assistant.error(error instanceof Error ? error.message : String(error));
      }
    } finally {
      state.loading = false;
      state.abort = null;
      assistant.finish();
      updateComposer();
    }
  }

  function handleEvent(assistant, event) {
    switch (event.t) {
      case "text_delta":
        assistant.text(String(event.block ?? "0"), event.text);
        break;
      case "tool_start":
        assistant.toolStart(event);
        break;
      case "tool_end":
        assistant.toolEnd(event);
        break;
      case "done":
        if (Array.isArray(event.history)) state.history = event.history;
        assistant.done();
        break;
      case "error":
        assistant.error(
          typeof event.error === "string" ? event.error : "Unknown error.",
        );
        break;
      default:
        break;
    }
  }

  function appendUser(text) {
    const wrapper = document.createElement("div");
    wrapper.className = "msg user";
    const bubble = document.createElement("div");
    bubble.className = "bubble";
    bubble.textContent = text;
    wrapper.append(bubble);
    el.messages.append(wrapper);
    state.shouldStick = true;
    scrollSoon();
  }

  function createAssistant() {
    const wrapper = document.createElement("div");
    wrapper.className = "msg assistant";

    const avatar = document.createElement("div");
    avatar.className = "avatar";
    avatar.textContent = "R";

    const body = document.createElement("div");
    body.className = "assistant-body";

    const thinking = document.createElement("div");
    thinking.className = "thinking";
    thinking.innerHTML =
      'Writing code and checking evidence<span class="thinking-dots"><i></i><i></i><i></i></span>';
    body.append(thinking);

    wrapper.append(avatar, body);
    el.messages.append(wrapper);
    scrollSoon();

    const textBlocks = new Map();
    const tools = new Map();
    let hasContent = false;
    let finished = false;

    function removeThinking() {
      if (thinking.isConnected) thinking.remove();
    }

    function text(block, delta) {
      if (typeof delta !== "string" || !delta) return;
      removeThinking();
      hasContent = true;

      let entry = textBlocks.get(block);
      if (!entry) {
        const div = document.createElement("div");
        div.className = "markdown streaming-cursor";
        body.append(div);
        entry = { el: div, text: "" };
        textBlocks.set(block, entry);
      }
      entry.text += delta;
      entry.el.innerHTML = renderMarkdown(entry.text);
      scrollSoon();
    }

    function outBlock(label, value, kind) {
      const div = document.createElement("div");
      div.className = "out-block" + (kind ? ` ${kind}` : "");
      const head = document.createElement("div");
      head.className = "out-label";
      head.textContent = label;
      const pre = document.createElement("pre");
      pre.textContent = value;
      div.append(head, pre);
      return div;
    }

    function toolStart(event) {
      removeThinking();
      hasContent = true;

      const card = document.createElement("article");
      card.className = "tool-card running";
      card.dataset.toolId = String(event.id);

      const hosts =
        Array.isArray(event.allowedHosts) && event.allowedHosts.length > 0
          ? `<div class="tool-hosts"><span class="host-label">network</span>${event.allowedHosts
              .map(
                (host) =>
                  `<span class="host-chip">${escapeHtml(stripScheme(String(host)))}</span>`,
              )
              .join("")}</div>`
          : "";

      card.innerHTML = `
        <div class="tool-head">
          <div class="tool-icon">&lt;/&gt;</div>
          <div class="tool-titles">
            <strong>JavaScript</strong>
            <span class="tool-sub">private Wasm sandbox</span>
          </div>
          <span class="tool-status running"><span class="spinner"></span>running</span>
          <span class="tool-time">${formatMs(event.genMs)} to write</span>
        </div>
        ${hosts}
        <details class="tool-code" open>
          <summary><span><span class="chev">›</span>Code</span><button class="copy-btn" type="button">Copy</button></summary>
          <pre><code></code></pre>
        </details>
        <div class="tool-output"><div class="no-output">Waiting for the sandbox…</div></div>`;

      const code = card.querySelector("pre code");
      if (code) code.textContent = typeof event.code === "string" ? event.code : "";
      body.append(card);
      tools.set(String(event.id), card);
      scrollSoon();
    }

    function toolEnd(event) {
      const card = tools.get(String(event.id));
      if (!card) return;

      card.classList.remove("running");
      const status = card.querySelector(".tool-status");
      if (status) {
        status.className = "tool-status " + (event.error ? "failed" : "done");
        status.innerHTML = event.error
          ? "<span>!</span>error"
          : "<span>✓</span>done";
      }
      const time = card.querySelector(".tool-time");
      if (time) time.textContent = `${formatMs(event.execMs)} run`;

      const output = card.querySelector(".tool-output");
      if (output) {
        output.innerHTML = "";
        if (event.stdout) output.append(outBlock("stdout", event.stdout));
        if (event.stderr) output.append(outBlock("stderr", event.stderr, "stderr"));
        if (event.error) {
          output.append(outBlock("sandbox error", event.error, "failure"));
        }
        if (!event.stdout && !event.stderr && !event.error) {
          const empty = document.createElement("div");
          empty.className = "no-output";
          empty.textContent = "Ran successfully with no output.";
          output.append(empty);
        }
      }
      scrollSoon();
    }

    function done() {
      removeThinking();
      removeCursors();
      if (!hasContent) {
        const div = document.createElement("div");
        div.className = "markdown";
        div.textContent = "I didn't get a response. Please try again.";
        body.append(div);
        hasContent = true;
      }
      finished = true;
      scrollSoon();
    }

    function error(message) {
      removeThinking();
      removeCursors();
      const div = document.createElement("div");
      div.className = "msg-error";
      div.textContent = `⚠ ${message}`;
      body.append(div);
      hasContent = true;
      scrollSoon();
    }

    function stopped() {
      removeThinking();
      removeCursors();
      const div = document.createElement("div");
      div.className = "msg-stopped";
      div.textContent = "Stopped.";
      body.append(div);
      hasContent = true;
      scrollSoon();
    }

    function finish() {
      removeThinking();
      removeCursors();
      if (!hasContent && !finished) {
        const div = document.createElement("div");
        div.className = "markdown";
        div.textContent = "No response.";
        body.append(div);
        hasContent = true;
      }
      scrollSoon();
    }

    function removeCursors() {
      for (const entry of textBlocks.values()) {
        entry.el.classList.remove("streaming-cursor");
      }
    }

    return { text, toolStart, toolEnd, done, error, stopped, finish };
  }

  function updateComposer() {
    el.input.disabled = state.loading;
    el.sendBtn.classList.toggle("hidden", state.loading);
    el.stopBtn.classList.toggle("hidden", !state.loading);
    el.sendBtn.disabled = state.loading || !el.input.value.trim();
  }

  function autoResize() {
    el.input.style.height = "auto";
    el.input.style.height = `${Math.min(el.input.scrollHeight, 180)}px`;
  }

  function nearBottom() {
    return (
      el.thread.scrollHeight - el.thread.scrollTop - el.thread.clientHeight < 140
    );
  }

  function scrollSoon() {
    if (!state.shouldStick) return;
    requestAnimationFrame(() => {
      el.thread.scrollTop = el.thread.scrollHeight;
    });
  }

  function toast(message) {
    el.toast.textContent = message;
    el.toast.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.toast.classList.remove("show"), 4500);
  }

  async function copyText(text) {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return;
    }
    const textarea = document.createElement("textarea");
    textarea.value = text;
    textarea.style.position = "fixed";
    textarea.style.opacity = "0";
    document.body.append(textarea);
    textarea.select();
    const copied = document.execCommand("copy");
    textarea.remove();
    if (!copied) throw new Error("copy failed");
  }

  // --------------------------------------------------------------- markdown

  function escapeHtml(value) {
    return String(value).replace(/[&<>"']/g, (character) => {
      switch (character) {
        case "&":
          return "&amp;";
        case "<":
          return "&lt;";
        case ">":
          return "&gt;";
        case '"':
          return "&quot;";
        default:
          return "&#39;";
      }
    });
  }

  function safeUrl(raw) {
    try {
      const url = new URL(raw);
      if (url.protocol === "http:" || url.protocol === "https:") return raw;
    } catch {
      return null;
    }
    return null;
  }

  function inline(value) {
    let text = value;
    const codes = [];
    const links = [];

    text = text.replace(/`([^`]+)`/g, (_match, code) => {
      const index = codes.length;
      codes.push(`<code>${code}</code>`);
      return `\u0001K${index}\u0001`;
    });

    text = text.replace(
      /\[([^\]]+)\]\(([^)\s]+)\)/g,
      (_match, label, url) => {
        const safe = safeUrl(url);
        if (!safe) return label;
        const index = links.length;
        links.push(
          `<a href="${safe}" target="_blank" rel="noopener noreferrer">${label}</a>`,
        );
        return `\u0001L${index}\u0001`;
      },
    );

    text = text.replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>");
    text = text.replace(/~~([^~\n]+)~~/g, "<del>$1</del>");
    text = text.replace(
      /(^|[\s(])\*([^*\n]+)\*(?=$|[\s).,!?:;])/g,
      "$1<em>$2</em>",
    );
    text = text.replace(
      /(^|[\s(])_([^_\n]+)_(?=$|[\s).,!?:;])/g,
      "$1<em>$2</em>",
    );

    text = text.replace(/\u0001K(\d+)\u0001/g, (_match, index) => codes[Number(index)]);
    text = text.replace(
      /\u0001L(\d+)\u0001/g,
      (_match, index) => links[Number(index)],
    );
    return text;
  }

  function extractCodeBlocks(markdown) {
    const blocks = [];
    let output = "";
    let cursor = 0;

    while (cursor < markdown.length) {
      const start = markdown.indexOf("```", cursor);
      if (start === -1) {
        output += markdown.slice(cursor);
        break;
      }

      output += markdown.slice(cursor, start);
      const newline = markdown.indexOf("\n", start + 3);
      if (newline === -1) {
        output += markdown.slice(start);
        break;
      }

      const language = markdown.slice(start + 3, newline).trim();
      const end = markdown.indexOf("```", newline + 1);
      const code =
        end === -1
          ? markdown.slice(newline + 1)
          : markdown.slice(newline + 1, end);

      blocks.push({ language, code });
      output += `\n\u0000C${blocks.length - 1}\u0000\n`;

      if (end === -1) break;
      cursor = end + 3;
    }

    return { text: output, blocks };
  }

  function renderCodeBlock(block) {
    const language = block.language ? escapeHtml(block.language) : "code";
    return `<div class="codeblock"><div class="codeblock-head"><span>${language}</span><button class="copy-btn" type="button">Copy</button></div><pre><code>${escapeHtml(
      block.code.replace(/\n$/, ""),
    )}</code></pre></div>`;
  }

  function isTableSeparator(line) {
    const trimmed = line.trim();
    return (
      trimmed.includes("|") &&
      trimmed.includes("-") &&
      /^[\s|:-]+$/.test(trimmed)
    );
  }

  function splitTableRow(line) {
    return line
      .trim()
      .replace(/^\|/, "")
      .replace(/\|$/, "")
      .split("|")
      .map((cell) => cell.trim());
  }

  function renderTable(header, rows) {
    const head = header
      .map((cell) => `<th>${inline(escapeHtml(cell))}</th>`)
      .join("");
    const body = rows
      .map(
        (row) =>
          `<tr>${row
            .map((cell) => `<td>${inline(escapeHtml(cell))}</td>`)
            .join("")}</tr>`,
      )
      .join("");
    return `<div class="table-wrap"><table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>`;
  }

  function renderMarkdown(markdown) {
    if (!markdown) return "";

    const extracted = extractCodeBlocks(String(markdown).replace(/\r\n?/g, "\n"));
    const lines = extracted.text.split("\n");
    const output = [];
    let paragraph = [];
    let index = 0;

    const flushParagraph = () => {
      if (paragraph.length > 0) {
        output.push(`<p>${paragraph.map(inline).join("<br>")}</p>`);
        paragraph = [];
      }
    };

    while (index < lines.length) {
      const line = lines[index];
      const trimmed = line.trim();

      const codeMatch = trimmed.match(/^\u0000C(\d+)\u0000$/);
      if (codeMatch) {
        flushParagraph();
        output.push(renderCodeBlock(extracted.blocks[Number(codeMatch[1])]));
        index += 1;
        continue;
      }

      if (!trimmed) {
        flushParagraph();
        index += 1;
        continue;
      }

      const heading = trimmed.match(/^(#{1,6})\s+(.*)$/);
      if (heading) {
        flushParagraph();
        const level = heading[1].length;
        output.push(
          `<h${level}>${inline(heading[2].trim())}</h${level}>`,
        );
        index += 1;
        continue;
      }

      if (/^([-*_])\s*(?:\1\s*){2,}$/.test(trimmed)) {
        flushParagraph();
        output.push("<hr>");
        index += 1;
        continue;
      }

      if (/^>\s?/.test(trimmed)) {
        flushParagraph();
        const quote = [];
        while (index < lines.length && /^>\s?/.test(lines[index].trim())) {
          quote.push(lines[index].trim().replace(/^>\s?/, ""));
          index += 1;
        }
        output.push(`<blockquote>${quote.map(inline).join("<br>")}</blockquote>`);
        continue;
      }

      if (
        trimmed.includes("|") &&
        index + 1 < lines.length &&
        isTableSeparator(lines[index + 1])
      ) {
        flushParagraph();
        const header = splitTableRow(trimmed);
        const rows = [];
        index += 2;
        while (
          index < lines.length &&
          lines[index].includes("|") &&
          lines[index].trim()
        ) {
          rows.push(splitTableRow(lines[index].trim()));
          index += 1;
        }
        output.push(renderTable(header, rows));
        continue;
      }

      if (/^([-*+]|\d+\.)\s+/.test(trimmed)) {
        flushParagraph();
        const ordered = /^\d+\./.test(trimmed);
        const items = [];

        while (index < lines.length) {
          const itemLine = lines[index].trim();
          const match = itemLine.match(/^([-*+]|\d+\.)\s+(.*)$/);
          if (match) {
            items.push(match[2]);
            index += 1;
            continue;
          }
          if (
            items.length > 0 &&
            /^\s{2,}\S/.test(lines[index]) &&
            !/^([-*+]|\d+\.)\s+/.test(itemLine)
          ) {
            items[items.length - 1] += ` ${itemLine}`;
            index += 1;
            continue;
          }
          break;
        }

        const tag = ordered ? "ol" : "ul";
        output.push(
          `<${tag}>${items.map((item) => `<li>${inline(item)}</li>`).join("")}</${tag}>`,
        );
        continue;
      }

      paragraph.push(trimmed);
      index += 1;
    }

    flushParagraph();
    return output.join("\n");
  }

  // --------------------------------------------------------------- helpers

  function formatMs(value) {
    const milliseconds = Number(value);
    if (!Number.isFinite(milliseconds) || milliseconds < 0) return "—";
    if (milliseconds < 1000) return `${Math.round(milliseconds)}ms`;
    return `${(milliseconds / 1000).toFixed(1)}s`;
  }

  function stripScheme(host) {
    return host.replace(/^https?:\/\//, "");
  }

  init();
})();
