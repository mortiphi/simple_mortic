const $ = (id) => document.getElementById(id);
const runBtn = $("run");
const questionEl = $("question");
const modeEl = $("mode");
const providerEl = $("provider");
const modelEl = $("model");
const effortEl = $("effort");
const sourceThreadEl = $("sourceThread");
const voiceModeEl = $("voiceMode");
const sandboxModeEl = $("sandboxMode");
const cwdEl = $("cwd");
const mercuryMaxTokensEl = $("mercuryMaxTokens");
const mercuryCtxKEl = $("mercuryCtxK");
const mercuryPromptEl = $("mercuryPrompt");
const codexPromptEl = $("codexPrompt");
const togglePromptsBtn = $("togglePrompts");
const promptEditorsEl = $("promptEditors");
const resetPromptsBtn = $("resetPrompts");
const mercuryText = $("mercury-text");
const mainText = $("main-text");
const mercuryTiming = $("mercury-timing");
const mainTiming = $("main-timing");
const mainTag = $("main-tag");
const summary = $("summary");
const historyBody = $("history-body");
const statusEl = $("status");

let running = false;

async function checkStatus() {
  try {
    const r = await fetch("/api/status");
    const s = await r.json();
    const parts = [];
    parts.push(`<span class="${s.openaiConfigured ? "ok" : "missing"}">OpenAI: ${s.openaiConfigured ? "configured" : "MISSING"}</span>`);
    parts.push(`<span class="${s.openrouterConfigured ? "ok" : "missing"}">OpenRouter: ${s.openrouterConfigured ? "configured" : "MISSING"}</span>`);
    parts.push(`<span style="color:#888">Mercury: ${s.mercuryModel}</span>`);
    statusEl.innerHTML = parts.join(" · ");
  } catch {
    statusEl.innerHTML = '<span class="missing">Server not running</span>';
  }
}
checkStatus();

async function run() {
  if (running) return;
  const question = questionEl.value.trim();
  if (!question) { questionEl.focus(); return; }
  running = true;
  runBtn.disabled = true;
  runBtn.textContent = "Running…";

  mercuryText.innerHTML = "";
  mainText.innerHTML = "";
  mercuryTiming.innerHTML = "";
  mainTiming.innerHTML = "";
  mainTag.textContent = "definitive";
  summary.innerHTML = "";

  const startMs = performance.now();
  const timings = { mercury: null, main: null, mainResend: null, winner: null, totalMs: null };
  let mainTextAccum = "";
  let mainResendStarted = false;

  try {
    const res = await fetch("/api/probe", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        question,
        mode: modeEl.value,
        mainModel: modelEl.value,
        mainProvider: providerEl.value,
        effort: effortEl.value,
        sourceThreadId: sourceThreadEl.value.trim() || null,
        voiceMode: voiceModeEl.checked,
        sandboxMode: sandboxModeEl.value,
        cwd: cwdEl.value.trim() || null,
        mercuryMaxTokens: parseInt(mercuryMaxTokensEl.value, 10),
        mercuryCtxK: parseInt(mercuryCtxKEl.value, 10),
        mercuryPromptOverride: mercuryPromptEl.value.trim() || null,
        codexPromptOverride: codexPromptEl.value.trim() || null,
      }),
    });
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let nl;
      while ((nl = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line.startsWith("data: ")) continue;
        const data = line.slice(6).trim();
        if (!data) continue;
        try { handleEvent(JSON.parse(data), timings, startMs); } catch {}
      }
    }
  } catch (e) {
    summary.innerHTML = `<div class="error">Error: ${e.message}</div>`;
  } finally {
    running = false;
    runBtn.disabled = false;
    runBtn.textContent = "Run";
    addToHistory(question, modeEl.value, modelEl.value, timings, startMs);
  }

  function handleEvent(ev, timings, startMs) {
    switch (ev.type) {
      case "delta":
        if (ev.phase === "mercury") mercuryText.textContent = ev.full;
        else if (ev.phase === "main") { mainTextAccum = ev.full; mainText.textContent = ev.full; }
        else if (ev.phase === "main-resend") {
          if (!mainResendStarted) {
            mainResendStarted = true;
            mainText.innerHTML = '<div class="resend-label">[first turn aborted · resending with Mercury context]</div>';
            mainTag.textContent = "resend";
          }
          mainText.innerHTML = '<div class="resend-label">[first turn aborted · resending with Mercury context]</div>' + ev.full;
        }
        break;
      case "first-byte":
        if (ev.phase === "mercury") {
          mercuryTiming.innerHTML += `<span class="metric">1st byte <strong>${ev.sinceRequestMs.toFixed(0)}</strong>ms</span>`;
        } else if (ev.phase === "main") {
          mainTiming.innerHTML += `<span class="metric">1st byte <strong>${ev.sinceRequestMs.toFixed(0)}</strong>ms</span>`;
        } else if (ev.phase === "main-resend") {
          mainTiming.innerHTML += `<span class="metric">resend 1st byte <strong>${ev.sinceRequestMs.toFixed(0)}</strong>ms</span>`;
        }
        break;
      case "complete":
        if (ev.phase === "mercury") {
          timings.mercury = ev;
          mercuryTiming.innerHTML += `<span class="metric">total <strong>${ev.totalMs.toFixed(0)}</strong>ms</span><span class="metric">~${ev.tokenCount}tok</span>`;
        } else if (ev.phase === "main") {
          timings.main = ev;
          mainTiming.innerHTML += `<span class="metric">total <strong>${ev.totalMs.toFixed(0)}</strong>ms</span><span class="metric">~${ev.tokenCount}tok</span>`;
        } else if (ev.phase === "main-resend") {
          timings.mainResend = ev;
          mainTiming.innerHTML += `<span class="metric">resend total <strong>${ev.totalMs.toFixed(0)}</strong>ms</span><span class="metric">~${ev.tokenCount}tok</span>`;
        }
        updateSummary();
        break;
      case "race-winner":
        timings.winner = ev;
        updateSummary();
        break;
      case "context-built":
        mercuryTiming.innerHTML += `<span class="metric">ctx ${ev.messageCount}msg ~${ev.tokenEstimate}tok</span>`;
        break;
      case "status":
        const statusTarget = ev.phase === "mercury" ? mercuryTiming : mainTiming;
        statusTarget.innerHTML += `<span class="metric" style="color:#f59e0b">${ev.label}${ev.detail ? ` (${ev.detail})` : ""}</span>`;
        break;
      case "aborted":
        if (ev.phase === "main") {
          mainText.innerHTML += '<div class="aborted">[aborted — Mercury won the race]</div>';
        } else if (ev.phase === "mercury") {
          mercuryText.innerHTML += '<div class="aborted">[aborted — Main won the race]</div>';
        }
        break;
      case "error":
        const target = ev.phase === "mercury" ? mercuryText : ev.phase === "main" ? mainText : mainText;
        target.innerHTML += `<div class="error">${ev.message}</div>`;
        break;
      case "done":
        timings.totalMs = ev.totalMs;
        updateSummary();
        break;
    }
  }

  function updateSummary() {
    if (!timings.totalMs && !timings.mercury && !timings.main && !timings.mainResend) return;
    const perceived = timings.mercury?.firstByteMs ?? timings.main?.firstByteMs;
    const parts = [];
    if (timings.winner) {
      const w = timings.winner;
      parts.push(`<div><span class="winner-badge ${w.winner}">${w.winner} won</span>` +
        ` <span style="color:#888;font-size:12px">(Mercury ${w.mercuryFirstByte?.toFixed(0) ?? "—"}ms vs Main ${w.mainFirstByte?.toFixed(0) ?? "—"}ms at ${w.sinceRequestMs?.toFixed(0)}ms)</span></div>`);
    }
    parts.push('<div class="metric-row">');
    parts.push(metricItem("Perceived 1st content", perceived, "ms"));
    parts.push(metricItem("Mercury total", timings.mercury?.totalMs, "ms"));
    parts.push(metricItem("Main total", timings.main?.totalMs ?? timings.mainResend?.totalMs, "ms"));
    parts.push(metricItem("Total wall clock", timings.totalMs, "ms"));
    parts.push('</div>');
    summary.innerHTML = parts.join("");
  }
}

function metricItem(label, value, unit) {
  if (value == null) return `<div class="metric-item"><div class="label">${label}</div><div class="value">—</div></div>`;
  return `<div class="metric-item"><div class="label">${label}</div><div class="value">${value.toFixed(0)}<span class="unit"> ${unit}</span></div></div>`;
}

function addToHistory(question, mode, model, timings, startMs) {
  const total = timings.totalMs ?? (performance.now() - startMs);
  const perceived = timings.mercury?.firstByteMs ?? timings.main?.firstByteMs;
  const row = document.createElement("tr");
  row.innerHTML = `
    <td>${new Date().toLocaleTimeString()}</td>
    <td>${escapeHtml(question.slice(0, 50))}${question.length > 50 ? "…" : ""}</td>
    <td>${mode}</td>
    <td>${escapeHtml(model)}</td>
    <td>${timings.mercury ? `<span class="m">${timings.mercury.firstByteMs?.toFixed(0)}</span>` : "—"}</td>
    <td>${timings.main ? `<span class="c">${timings.main.firstByteMs?.toFixed(0)}</span>` : timings.mainResend ? `<span class="c">${timings.mainResend.firstByteMs?.toFixed(0)}*</span>` : "—"}</td>
    <td>${perceived != null ? perceived.toFixed(0) : "—"}</td>
    <td>${total.toFixed(0)}</td>
  `;
  historyBody.prepend(row);
}

function escapeHtml(s) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

runBtn.addEventListener("click", run);
$("clearCache").addEventListener("click", async () => {
  try {
    await fetch("/api/clear-cache", { method: "POST" });
    statusEl.innerHTML += '<span style="color:#f59e0b"> · fork cache cleared</span>';
    setTimeout(checkStatus, 2000);
  } catch (e) {
    alert("Failed to clear cache: " + e.message);
  }
});

togglePromptsBtn.addEventListener("click", () => {
  const open = promptEditorsEl.style.display !== "none";
  if (open) {
    promptEditorsEl.style.display = "none";
    togglePromptsBtn.textContent = "Edit prompts";
  } else {
    loadPrompts();
    promptEditorsEl.style.display = "block";
    togglePromptsBtn.textContent = "Hide prompts";
  }
});

resetPromptsBtn.addEventListener("click", () => {
  localStorage.removeItem("mercuryPrompt");
  localStorage.removeItem("codexPrompt");
  loadPrompts();
});

[mercuryPromptEl, codexPromptEl].forEach((el, i) => {
  el.addEventListener("input", () => {
    el.classList.add("changed");
    localStorage.setItem(i === 0 ? "mercuryPrompt" : "codexPrompt", el.value);
  });
});

async function loadPrompts() {
  const defaults = await fetch("/api/default-prompts").then((r) => r.json());
  const mercuryOverride = localStorage.getItem("mercuryPrompt");
  const codexOverride = localStorage.getItem("codexPrompt");
  mercuryPromptEl.value = mercuryOverride ?? defaults.mercury;
  codexPromptEl.value = codexOverride ?? defaults.codex;
  mercuryPromptEl.classList.remove("changed");
  codexPromptEl.classList.remove("changed");
}

questionEl.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); run(); }
});
