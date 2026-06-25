import http from "node:http";
import { readFileSync, existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join, extname } from "node:path";
import { codexClient, voiceDeveloperInstructions, morticVoiceOutputSchema, extractSpeakText, VOICE_DEVELOPER_INSTRUCTIONS_SCHEMA_ACTIVE } from "./codexClient.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));

const envPath = join(__dirname, ".env");
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, "utf8").split("\n")) {
    if (!line.trim() || line.startsWith("#")) continue;
    const i = line.indexOf("=");
    if (i < 0) continue;
    const k = line.slice(0, i).trim();
    const v = line.slice(i + 1).trim().replace(/^["']|["']$/g, "");
    if (k && !process.env[k]) process.env[k] = v;
  }
}

const PORT = Number(process.env.PROBE_PORT) || 3456;
const OPENAI_KEY = process.env.OPENAI_API_KEY;
const OPENROUTER_KEY = process.env.OPENROUTER_API_KEY;

const MERCURY_MODEL = "inception/mercury-2";
const MERCURY_SYSTEM = `You are a copy of another agent with exactly the same context and you only generate buffer thought right before the main app speaks. While the main assistant is thinking, the user hears your output spoken aloud. Generate 1-3 spoken sentences (~20-60 words) of a tentative prelude that commits nothing but also doesn't sound generic and describes that you do have context still.  You should seem like you are taking a moment to think.

Rules:
- Plain spoken text only. No markdown, no bullets, no headers, no code, no lists, no symbols, no asterisks, no backticks.
- Name what you'd examine and offer a tentative theory, hedged ("I'd look at...", "my initial theory is...", "but I need to verify").
- Do not give a definitive answer — that comes next.
- Be conversational and natural to speak aloud. Write as you'd talk, not as you'd write. You can add (some dashes and uhms if you need to fill the tokens with some space and don't want to be committal.
- If the question is simple, use 1-2 sentences.

Output only these sentences, nothing else.`;

const MIME = { ".html": "text/html", ".js": "application/javascript", ".mjs": "application/javascript", ".css": "text/css", ".json": "application/json" };

function estimateTokens(text) {
  return Math.max(1, Math.round(text.length / 4));
}

function stripMarkdownForTts(text) {
  let s = text;
  s = s.replace(/```[\s\S]*?```/g, " ");
  s = s.replace(/`[^`]*`/g, " ");
  s = s.replace(/^#{1,6}\s+/gm, " ");
  s = s.replace(/^\s*[-*•]\s+/gm, " ");
  s = s.replace(/^\s*\d+\.\s+/gm, " ");
  s = s.replace(/^\s*---+\s*$/gm, " ");
  s = s.replace(/\*\*([^*]+)\*\*/g, "$1");
  s = s.replace(/\*([^*]+)\*/g, "$1");
  s = s.replace(/__([^_]+)__/g, "$1");
  s = s.replace(/_([^_]+)_/g, "$1");
  s = s.replace(/\\[\(\[]([\s\S]*?)\\[\)\]]/g, (_, m) => ` ${m} `);
  s = s.replace(/\$\$([^$]+)\$\$/g, "$1");
  s = s.replace(/\$([^$]+)\$/g, "$1");
  s = s.replace(/\[([^\]]+)\]\([^)]+\)/g, "$1");
  s = s.replace(/^\s*>\s?/gm, " ");
  s = s.replace(/\s+/g, " ");
  return s.trim();
}

async function streamChat({ url, apiKey, model, messages, maxTokens, signal, onDelta, onFirstByte, onComplete, onRequest }) {
  const startMs = performance.now();
  onRequest?.(messages);
  const isReasoning = model.startsWith("o1") || model.startsWith("o3") || model.startsWith("openai/o1") || model.startsWith("openai/o3") || /gpt-5/i.test(model);
  const body = {
    model,
    messages,
    stream: true,
    ...(isReasoning ? { max_completion_tokens: maxTokens ?? 4096 } : { max_tokens: maxTokens ?? 4096, temperature: 0.7 }),
  };
  const res = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    throw new Error(`${model} HTTP ${res.status}: ${errText.slice(0, 300)}`);
  }
  let firstByteMs = null;
  let text = "";
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    if (firstByteMs === null) {
      firstByteMs = performance.now() - startMs;
      onFirstByte?.(firstByteMs);
    }
    let nl;
    while ((nl = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line.startsWith("data: ")) continue;
      const data = line.slice(6).trim();
      if (data === "[DONE]") continue;
      try {
        const json = JSON.parse(data);
        const delta = json.choices?.[0]?.delta?.content;
        if (delta) {
          text += delta;
          onDelta?.(delta, text);
        }
      } catch {}
    }
  }
  const totalMs = performance.now() - startMs;
  onComplete?.({ firstByteMs, totalMs, text, tokenCount: estimateTokens(text) });
  return text;
}

function sendSSE(res, event) {
  if (res.writableEnded) return;
  try { res.write(`data: ${JSON.stringify(event)}\n\n`); } catch {}
}

const DEFAULT_MERCURY_CTX_K = 25;

function buildMercuryContext(turns, currentQuestion, ctxK, systemPrompt) {
  const maxChars = ctxK * 4000;
  const pairs = [];
  for (const turn of turns) {
    for (const item of turn.items || []) {
      if (item.type === "userMessage" && Array.isArray(item.content)) {
        const text = item.content.map((c) => c?.text || "").join("").trim();
        if (text) pairs.push({ role: "user", text });
      } else if (item.type === "agentMessage" && item.phase === "final_answer" && item.text) {
        pairs.push({ role: "assistant", text: item.text });
      }
    }
  }
  let totalChars = pairs.reduce((sum, p) => sum + p.text.length, 0);
  while (totalChars > maxChars && pairs.length > 1) {
    const removed = pairs.shift();
    totalChars -= removed.text.length;
  }
  const messages = [{ role: "system", content: systemPrompt }];
  for (const p of pairs) messages.push({ role: p.role, content: p.text });
  messages.push({ role: "user", content: currentQuestion });
  return messages;
}

async function buildMercuryMessages(sourceThreadId, currentQuestion, ctxK, systemPrompt) {
  const sys = systemPrompt || MERCURY_SYSTEM;
  if (!sourceThreadId) {
    return [{ role: "system", content: sys }, { role: "user", content: currentQuestion }];
  }
  try {
    await codexClient.start();
    const result = await codexClient.listTurns(sourceThreadId, 100);
    const turns = (result.data || []).slice().reverse();
    const messages = buildMercuryContext(turns, currentQuestion, ctxK, sys);
    const ctxChars = messages.reduce((s, m) => s + (m.content?.length || 0), 0);
    console.log(`[mercury] context: ${messages.length} messages, ~${Math.round(ctxChars / 4)} tokens (cap ${ctxK}K), ${turns.length} turns scanned`);
    return messages;
  } catch (e) {
    console.error("[mercury] context build failed:", e.message);
    return [{ role: "system", content: sys }, { role: "user", content: currentQuestion }];
  }
}

async function streamCodex({ input, model, effort, signal, onDelta, onFirstByte, onComplete, requestStartMs, sourceThreadId, voiceMode, sandboxMode, cwd, res, codexPromptOverride }) {
  await codexClient.start();
  let threadId;
  if (sourceThreadId) {
    const devInstructions = voiceMode ? voiceDeveloperInstructions(true, codexPromptOverride) : undefined;
    const cacheKey = codexClient.scratchKey(sourceThreadId, model, devInstructions, sandboxMode);
    const cached = codexClient.scratchCache.get(cacheKey);
    if (cached) {
      threadId = cached;
      sendSSE(res, { type: "status", label: "Reusing cached scratch fork", detail: threadId.slice(0, 8) });
    } else {
      sendSSE(res, { type: "status", label: "Forking from source thread (one-time cold fork, loading ~157K tokens of context, may take 60-80s)...", detail: sourceThreadId.slice(0, 8) });
      threadId = await codexClient.forkThread(sourceThreadId, model, devInstructions, cwd, sandboxMode);
      codexClient.scratchCache.set(cacheKey, threadId);
      sendSSE(res, { type: "status", label: "Fork ready, starting turn", detail: threadId.slice(0, 8) });
    }
  } else {
    threadId = await codexClient.createThread(model);
  }
  const schema = voiceMode ? morticVoiceOutputSchema() : null;
  let firstByteMs = null;
  let rawText = "";
  const result = await codexClient.runTurn({
    threadId,
    input,
    model,
    effort,
    signal,
    outputSchema: schema,
    sandboxMode,
    cwd,
    onDelta: (delta, full) => { rawText = full; onDelta?.(delta, full); },
    onFirstDelta: () => {
      if (firstByteMs === null) {
        firstByteMs = performance.now() - requestStartMs;
        onFirstByte?.(firstByteMs);
      }
    },
    onComplete: ({ text, status }) => {
      const spoken = voiceMode ? extractSpeakText(text) : text;
      const totalMs = performance.now() - requestStartMs;
      onComplete?.({ firstByteMs, totalMs, text: spoken, rawText: voiceMode ? text : undefined, tokenCount: estimateTokens(spoken), status });
    },
  });
  return voiceMode ? extractSpeakText(result.text) : result.text;
}

async function runMainModel({ provider, model, messages, input, effort, signal, onDelta, onFirstByte, onComplete, requestStartMs, res, sourceThreadId, voiceMode, sandboxMode, cwd, codexPromptOverride }) {
  if (provider === "codex") {
      return await streamCodex({
      input: input ?? messages?.[0]?.content ?? "",
      model, effort, signal, onDelta, onFirstByte, onComplete, requestStartMs, sourceThreadId, voiceMode, sandboxMode, cwd, res, codexPromptOverride,
    });
  }
  const url = provider === "openrouter"
    ? "https://openrouter.ai/api/v1/chat/completions"
    : "https://api.openai.com/v1/chat/completions";
  const key = provider === "openrouter" ? OPENROUTER_KEY : OPENAI_KEY;
  return await streamChat({
    url, apiKey: key, model, messages,
    signal, onDelta, onFirstByte, onComplete,
  });
}

async function handleProbe(req, res, body) {
  const { question, mode, mainModel, mainProvider, effort, sourceThreadId, voiceMode, sandboxMode, cwd, mercuryMaxTokens, mercuryCtxK, mercuryPromptOverride, codexPromptOverride } = body;
  const ctxK = mercuryCtxK || DEFAULT_MERCURY_CTX_K;
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "Access-Control-Allow-Origin": "*",
  });

  const disconnectController = new AbortController();
  let disconnected = false;
  const handleDisconnect = () => {
    if (!disconnected) {
      disconnected = true;
      disconnectController.abort();
      console.log("[probe] client disconnected — aborting in-flight turn");
    }
  };
  req.on("close", handleDisconnect);
  req.on("aborted", handleDisconnect);
  res.on("close", handleDisconnect);

  function combinedSignal(...signals) {
    const controller = new AbortController();
    const abort = () => controller.abort();
    for (const s of signals) {
      if (s?.aborted) { abort(); break; }
      s?.addEventListener("abort", abort);
    }
    return controller.signal;
  }
  const disconnectSignal = disconnectController.signal;

  const mainMessages = [{ role: "user", content: question }];

  const requestStartMs = performance.now();
  const mainInput = question;
  const mainEffort = effort || "medium";

  if (mode === "main-only") {
    sendSSE(res, { type: "phase-start", phase: "main" });
    try {
      await runMainModel({
        provider: mainProvider, model: mainModel, messages: mainMessages, input: mainInput, effort: mainEffort,
        signal: combinedSignal(AbortSignal.timeout(120000), disconnectSignal),
        onDelta: (delta, full) => sendSSE(res, { type: "delta", phase: "main", delta, full }),
        onFirstByte: (ms) => sendSSE(res, { type: "first-byte", phase: "main", ms, sinceRequestMs: performance.now() - requestStartMs }),
        onComplete: (t) => sendSSE(res, { type: "complete", phase: "main", ...t }),
        requestStartMs, res, sourceThreadId, voiceMode, sandboxMode, cwd, codexPromptOverride,
      });
    } catch (e) {
      sendSSE(res, { type: "error", phase: "main", message: e.message });
    }
  } else if (mode === "mercury-first") {
    sendSSE(res, { type: "phase-start", phase: "mercury" });
    let mercuryText = "";
    try {
      const mercuryMessages = await buildMercuryMessages(sourceThreadId, question, ctxK, mercuryPromptOverride);
      sendSSE(res, { type: "context-built", phase: "mercury", messageCount: mercuryMessages.length, tokenEstimate: Math.round(mercuryMessages.reduce((s, m) => s + (m.content?.length || 0), 0) / 4) });
      mercuryText = await streamChat({
        url: "https://openrouter.ai/api/v1/chat/completions",
        apiKey: OPENROUTER_KEY, model: MERCURY_MODEL, messages: mercuryMessages, maxTokens: mercuryMaxTokens,
        signal: combinedSignal(AbortSignal.timeout(30000), disconnectSignal),
        onRequest: (msgs) => console.log(`[mercury] sending ${msgs.length} messages, first role: ${msgs[0]?.role}, system prompt: ${msgs[0]?.content?.slice(0, 40)}...`),
        onDelta: (delta, full) => sendSSE(res, { type: "delta", phase: "mercury", delta, full: stripMarkdownForTts(full) }),
        onFirstByte: (ms) => sendSSE(res, { type: "first-byte", phase: "mercury", ms, sinceRequestMs: performance.now() - requestStartMs }),
        onComplete: (t) => sendSSE(res, { type: "complete", phase: "mercury", ...t, text: stripMarkdownForTts(t.text) }),
      });
    } catch (e) {
      sendSSE(res, { type: "error", phase: "mercury", message: e.message });
    }
    const augmented = `${question}\n\n---\nA preliminary analysis was already given to the user:\n"${mercuryText}"\n\nNow provide the definitive answer. Build on the preliminary analysis, correct any inaccuracies, and go deeper. Do not repeat what was already said.`;
    sendSSE(res, { type: "phase-start", phase: "main", note: "with Mercury context" });
    try {
      await runMainModel({
        provider: mainProvider, model: mainModel,
        messages: [{ role: "user", content: augmented }], input: augmented, effort: mainEffort,
        signal: combinedSignal(AbortSignal.timeout(120000), disconnectSignal),
        onDelta: (delta, full) => sendSSE(res, { type: "delta", phase: "main", delta, full }),
        onFirstByte: (ms) => sendSSE(res, { type: "first-byte", phase: "main", ms, sinceRequestMs: performance.now() - requestStartMs }),
        onComplete: (t) => sendSSE(res, { type: "complete", phase: "main", ...t }),
        requestStartMs, res, sourceThreadId, voiceMode, sandboxMode, cwd, codexPromptOverride,
      });
    } catch (e) {
      sendSSE(res, { type: "error", phase: "main", message: e.message });
    }
  } else if (mode === "race" || mode === "race-resend") {
    const abortLosers = mode === "race-resend";
    const mercuryController = new AbortController();
    const mainController = new AbortController();
    let mercuryFirstByte = null, mainFirstByte = null;
    let winner = null;
    let mercuryText = "", mainText = "";

    let mercuryMessages;
    try {
      mercuryMessages = await buildMercuryMessages(sourceThreadId, question, ctxK, mercuryPromptOverride);
      sendSSE(res, { type: "context-built", phase: "mercury", messageCount: mercuryMessages.length, tokenEstimate: Math.round(mercuryMessages.reduce((s, m) => s + (m.content?.length || 0), 0) / 4) });
    } catch (e) {
      sendSSE(res, { type: "error", phase: "mercury", message: `context build failed: ${e.message}` });
      mercuryMessages = [{ role: "system", content: MERCURY_SYSTEM }, { role: "user", content: question }];
    }

    const declareWinner = (w) => {
      if (winner) return;
      winner = w;
      sendSSE(res, { type: "race-winner", winner, mercuryFirstByte, mainFirstByte, sinceRequestMs: performance.now() - requestStartMs });
      if (abortLosers) {
        if (w === "mercury") mainController.abort();
        else mercuryController.abort();
      }
    };

    const mercuryPromise = streamChat({
      url: "https://openrouter.ai/api/v1/chat/completions",
      apiKey: OPENROUTER_KEY, model: MERCURY_MODEL, messages: mercuryMessages, maxTokens: mercuryMaxTokens,
      signal: combinedSignal(mercuryController.signal, disconnectSignal),
      onRequest: (msgs) => console.log(`[mercury] sending ${msgs.length} messages, first role: ${msgs[0]?.role}, system prompt: ${msgs[0]?.content?.slice(0, 40)}...`),
      onDelta: (delta, full) => { mercuryText = full; sendSSE(res, { type: "delta", phase: "mercury", delta, full: stripMarkdownForTts(full) }); },
      onFirstByte: (ms) => {
        mercuryFirstByte = ms;
        sendSSE(res, { type: "first-byte", phase: "mercury", ms, sinceRequestMs: performance.now() - requestStartMs });
        if (mainFirstByte === null || mercuryFirstByte < mainFirstByte) declareWinner("mercury");
      },
      onComplete: (t) => sendSSE(res, { type: "complete", phase: "mercury", ...t, text: stripMarkdownForTts(t.text) }),
    }).then(t => { sendSSE(res, { type: "phase-done", phase: "mercury", text: t }); return t; })
      .catch(e => { if (e.name === "AbortError") sendSSE(res, { type: "aborted", phase: "mercury" }); else sendSSE(res, { type: "error", phase: "mercury", message: e.message }); return ""; });

    const mainPromise = runMainModel({
      provider: mainProvider, model: mainModel, messages: mainMessages, input: mainInput, effort: mainEffort,
      signal: combinedSignal(mainController.signal, disconnectSignal),
      onDelta: (delta, full) => { mainText = full; sendSSE(res, { type: "delta", phase: "main", delta, full }); },
      onFirstByte: (ms) => {
        mainFirstByte = ms;
        sendSSE(res, { type: "first-byte", phase: "main", ms, sinceRequestMs: performance.now() - requestStartMs });
        if (mercuryFirstByte === null || mainFirstByte < mercuryFirstByte) declareWinner("main");
      },
      onComplete: (t) => sendSSE(res, { type: "complete", phase: "main", ...t }),
      requestStartMs, res, sourceThreadId, voiceMode, sandboxMode, cwd, codexPromptOverride,
    }).then(t => { sendSSE(res, { type: "phase-done", phase: "main", text: t }); return t; })
      .catch(e => { if (e.name === "AbortError" || e.message?.includes("interrupted")) sendSSE(res, { type: "aborted", phase: "main" }); else sendSSE(res, { type: "error", phase: "main", message: e.message }); return ""; });

    const [mText] = await Promise.all([mercuryPromise, mainPromise]);

    if (abortLosers && winner === "mercury" && mText) {
      sendSSE(res, { type: "phase-start", phase: "main-resend", note: "aborted first turn, resending with Mercury context" });
      const augmented = `${question}\n\n---\nA preliminary analysis was already given to the user:\n"${mText}"\n\nNow provide the definitive answer. Build on the preliminary analysis, correct any inaccuracies, and go deeper. Do not repeat what was already said.`;
      try {
        await runMainModel({
          provider: mainProvider, model: mainModel,
          messages: [{ role: "user", content: augmented }], input: augmented, effort: mainEffort,
          signal: combinedSignal(AbortSignal.timeout(120000), disconnectSignal),
          onDelta: (delta, full) => sendSSE(res, { type: "delta", phase: "main-resend", delta, full }),
          onFirstByte: (ms) => sendSSE(res, { type: "first-byte", phase: "main-resend", ms, sinceRequestMs: performance.now() - requestStartMs }),
          onComplete: (t) => sendSSE(res, { type: "complete", phase: "main-resend", ...t }),
          requestStartMs, res, sourceThreadId, voiceMode, sandboxMode, cwd, codexPromptOverride,
        });
      } catch (e) {
        sendSSE(res, { type: "error", phase: "main-resend", message: e.message });
      }
    }
  }
  sendSSE(res, { type: "done", totalMs: performance.now() - requestStartMs });
  res.end();
}

const server = http.createServer(async (req, res) => {
  if (req.method === "POST" && req.url === "/api/probe") {
    let body = "";
    for await (const chunk of req) body += chunk;
    try {
      await handleProbe(req, res, JSON.parse(body));
    } catch (e) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }
  if (req.url === "/api/default-prompts") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ mercury: MERCURY_SYSTEM, codex: VOICE_DEVELOPER_INSTRUCTIONS_SCHEMA_ACTIVE }));
    return;
  }
  if (req.url === "/api/status") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      openaiConfigured: Boolean(OPENAI_KEY),
      openrouterConfigured: Boolean(OPENROUTER_KEY),
      mercuryModel: MERCURY_MODEL,
      codexBinary: process.env.MORTIC_CODEX_BINARY || "codex",
    }));
    return;
  }
  if (req.method === "POST" && req.url === "/api/clear-cache") {
    codexClient.clearScratchCache();
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ cleared: true }));
    return;
  }
  let filePath = join(__dirname, "public", req.url === "/" ? "index.html" : req.url);
  const ext = extname(filePath);
  try {
    const data = await readFile(filePath);
    res.writeHead(200, { "Content-Type": MIME[ext] || "application/octet-stream" });
    res.end(data);
  } catch {
    res.writeHead(404);
    res.end("Not found");
  }
});

server.listen(PORT, () => {
  console.log(`\n  Mercury Probe running at http://localhost:${PORT}\n`);
  console.log(`  OpenAI key:     ${OPENAI_KEY ? "configured" : "MISSING (set OPENAI_API_KEY in .env)"}`);
  console.log(`  OpenRouter key: ${OPENROUTER_KEY ? "configured" : "MISSING (set OPENROUTER_API_KEY in .env)"}`);
  console.log(`  Mercury model:  ${MERCURY_MODEL}\n`);
});
