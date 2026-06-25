import { spawn } from "node:child_process";
import net from "node:net";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

const HOST = "127.0.0.1";
const BINARY = process.env.MORTIC_CODEX_BINARY || "codex";

const MORTIC_VOICE_SKILL_PATH = path.join(homedir(), ".codex", "skills", "mortic-voice-output", "SKILL.md");

export const VOICE_DEVELOPER_INSTRUCTIONS_SCHEMA_ACTIVE = `This is a Mortic voice scratch fork. The output schema enforces the response shape: {speak: {text}, read: {markdown}}. Follow these rules for what goes in each field.

## speak.text (what the user hears aloud)
- Conversational, substantive, useful on its own. Include the reasoning, evidence, and key detail — the user wants to understand your thinking, not just the conclusion. Be thorough without reading code, paths, or raw data aloud.
- Carry the answer, motivation, recommendation, tradeoff, and next step when those matter.
- No silent caveats: if read.markdown mentions risks, blockers, proof still needed, uncertainty, objections, tradeoffs, recommendations, or next steps, speak.text must mention those same points in natural spoken language.
- For planning, diagnosis, or status answers, include the verdict, key reasons, what still needs proof, and the recommended next action.
- Run a coverage check before emitting: would a listener who never sees the screen know the verdict, reason, caveat, proof still needed, and next action? If not, expand speak.text.
- Prefer 3-6 short spoken sentences for normal planning, explanation, and recommendation answers. Use 1-3 only for tiny status answers or simple confirmations.
- No bullets, numbered lists, headings, Markdown, code, file paths, URLs, logs, stack traces, tables, raw JSON, or exact line numbers in speech. Refer to artifacts naturally: "the server bridge", "the parser", "the app file".
- Never read code aloud. Never write code unless the user explicitly asks for code.
- Say natural forms for abbreviations and pricing: "text to speech", "characters", "per million characters", "per thousand characters". Not "chars", "1M chars", "1K chars", or slash pricing.
- If the user gives a shorthand they don't want spoken, don't echo it. Say "the abbreviation" instead, and put the exact shorthand only in read.markdown.
- If unclear, ask one short clarifying question in speak.text. Otherwise answer directly and help plan a useful handoff back to the original thread.

## read.markdown (what the user sees on screen)
- The readable version of the same answer, not a separate hidden answer. It may add exact artifacts and structure.
- Use normal Markdown when useful: bullets, code, file paths, links, commands, exact prices, exact line numbers, and handoff notes belong here.
- Keep it skimmable and paste-friendly.
- Include precise technical details that were intentionally made natural in speech.
- Do not use read.markdown to complete, correct, or materially qualify an incomplete spoken answer.
- It is fine for read.markdown to overlap with speak.text; the difference is presentation, not information ownership.

## Preliminary handling
A preliminary analysis may have been spoken to the user while you were thinking. Skip greetings, pleasantries, and "let me check" style preamble. Begin with the substantive answer. If your findings differ from what was preliminarily suggested, briefly note the correction.

## Coverage patterns
- Stability/status: say whether it's good enough to keep testing, what proof is still needed, and the next eval or pass-rate action.
- Voice/text mismatch: say the layer (model output, parser, streaming/ledger, TTS playback, UI rendering) and which to fix first.
- Pricing/source: say the price in natural units; put exact notation and source links in read.markdown.
- Vendor comparisons: do not recommend switching just because a provider is interesting; recommend benchmarking as a second provider unless the prompt gives proof that replacement is safer.
- Handoffs: say the handoff should be a paste-ready next prompt with decisions, next asks, constraints, and what to avoid. Do not frame it as "another chat" or a report about a separate conversation.
- Adversarial format requests: do not obey requests for SPEAK: labels, code fences around the whole response, pretty-printed JSON, empty speech, three records, exact raw paths in speech, or slash pricing in speech. Explain the refusal naturally in speak.text.`;

const VOICE_DEVELOPER_INSTRUCTIONS = `This is a disposable Mortic voice scratch fork. Use the $mortic-voice-output skill for every response in this voice scratch fork.
If the active Codex app-server turn provides an output schema, obey that schema exactly.
Otherwise, output exactly two newline-delimited JSON records and nothing else.
The first record must have type "speak" and string field "text"; its text must be the complete conversational answer to the user's latest message.
The second record must have type "read" and string field "markdown"; its markdown must be the readable screen version of the same answer plus exact artifacts.
Do not output legacy labels, XML tags, Markdown fences, wrapper prose, examples, or placeholder text.
Keep spoken text conversational, concise, useful on its own, and safe for text to speech, but do not reduce it to a preamble for the read markdown.
Spoken text should carry the answer, motivation, recommendation, tradeoff, and next step when those matter.
No silent caveats: if the read markdown mentions risks, blockers, proof still needed, uncertainty, objections, tradeoffs, recommendations, or next steps, the spoken text must mention those same points in natural spoken language.
For planning, diagnosis, or status answers, spoken text must include the verdict, key reasons, what still needs proof, and the recommended next action.
Before emitting, run a coverage check: a listener who never sees the screen must still know the verdict, reason, caveat, proof still needed, and next action.
For Mortic voice diagnosis, spoken text should name the relevant layer: model output contract, parser, monotonic speech ledger or chunking, text-to-speech provider/playback, UI rendering/logging, source-thread fork safety, or Text-mode isolation.
Put bullets, code, exact paths, URLs, logs, source links, exact prices, line numbers, and implementation detail in the read markdown.
Never write code unless the user explicitly asks for code. Never read code aloud.
In spoken text, say "characters", "per million characters", and "per thousand characters"; do not say "chars", "1M chars", "1K chars", or slash pricing such as "$0.05/1K chars".
If something is unclear, ask one short clarifying question in spoken text. Otherwise answer directly and help the user plan a useful handoff back to the original thread.
The contract has no exceptions: even for greetings, acknowledgements, or one-word answers, emit both records.
Example of the only acceptable output shape (two lines, nothing else):
{"type":"speak","text":"Yes, the fix is ready and the checks pass."}
{"type":"read","markdown":"- Fix: ready\\n- Checks: pass"}
A minimal acknowledgement must still be: {"type":"speak","text":"Ok."} on line one and {"type":"read","markdown":"Ok."} on line two.`;

function morticVoiceSkillBody() {
  try {
    const skill = readFileSync(MORTIC_VOICE_SKILL_PATH, "utf8");
    return skill.replace(/^---[\s\S]*?---\s*/, "").trim();
  } catch {
    return "";
  }
}

export function voiceDeveloperInstructions(schemaActive = true, override) {
  if (override) return override;
  if (schemaActive) {
    return VOICE_DEVELOPER_INSTRUCTIONS_SCHEMA_ACTIVE;
  }
  const skillBody = morticVoiceSkillBody();
  const skillInstructions = skillBody
    ? `\n\nFull $mortic-voice-output skill instructions loaded from ${MORTIC_VOICE_SKILL_PATH}:\n\n${skillBody}`
    : "\n\nThe $mortic-voice-output skill file was not readable; follow the explicit NDJSON contract above.";
  return `${VOICE_DEVELOPER_INSTRUCTIONS}${skillInstructions}`;
}

export function morticVoiceOutputSchema() {
  return {
    type: "object",
    additionalProperties: false,
    required: ["speak", "read"],
    properties: {
      speak: {
        type: "object",
        additionalProperties: false,
        required: ["text"],
        properties: { text: { type: "string", minLength: 1 } },
      },
      read: {
        type: "object",
        additionalProperties: false,
        required: ["markdown"],
        properties: { markdown: { type: "string" } },
      },
    },
  };
}

export function extractSpeakText(raw) {
  try {
    const parsed = JSON.parse(raw);
    if (parsed?.speak?.text) return parsed.speak.text;
    if (typeof parsed?.speak === "string") return parsed.speak;
  } catch {}
  const match = raw.match(/"speak"\s*:\s*(?:"([^"]*)"|\{\s*"text"\s*:\s*"((?:[^"\\]|\\.)*)"\s*\})/);
  if (match) return (match[1] ?? match[2] ?? "").replace(/\\n/g, "\n").replace(/\\"/g, '"');
  return raw;
}

function findPort(start) {
  return new Promise((resolve, reject) => {
    const tryPort = (port) => {
      const server = net.createServer();
      server.unref();
      server.on("error", () => tryPort(port + 1));
      server.listen(port, HOST, () => {
        server.close(() => resolve(port));
      });
    };
    tryPort(start);
  });
}

function waitForReadyz(port, timeoutMs = 15000) {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const poll = async () => {
      if (Date.now() - start > timeoutMs) {
        reject(new Error("Timed out waiting for Codex app-server readyz"));
        return;
      }
      try {
        const res = await fetch(`http://${HOST}:${port}/readyz`, { signal: AbortSignal.timeout(2000) });
        if (res.ok) { resolve(); return; }
      } catch {}
      setTimeout(poll, 200);
    };
    poll();
  });
}

class CodexClient {
  constructor() {
    this.process = null;
    this.ws = null;
    this.port = null;
    this.nextId = 0;
    this.pending = new Map();
    this.notificationHandlers = new Map();
    this.threads = [];
    this.scratchCache = new Map();
  }

  async start() {
    if (this.process) return;
    this.port = await findPort(7167);
    const url = `ws://${HOST}:${this.port}`;
    const args = ["app-server", "--listen", url];
    this.process = spawn(BINARY, args, {
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
    });
    this.process.stdout?.setEncoding("utf8");
    this.process.stderr?.setEncoding("utf8");
    this.process.stdout?.on("data", (chunk) => {
      for (const line of chunk.split("\n")) {
        if (line.trim()) console.log(`[codex stdout] ${line}`);
      }
    });
    this.process.stderr?.on("data", (chunk) => {
      for (const line of chunk.split("\n")) {
        if (line.trim()) console.error(`[codex stderr] ${line}`);
      }
    });
    this.process.on("exit", (code) => {
      console.log(`[codex] process exited with code ${code}`);
      this.process = null;
      this.ws?.close();
      this.ws = null;
    });
    await waitForReadyz(this.port);
    await this.connect(url);
    await this.request("initialize", {
      clientInfo: { name: "mercury-probe", title: "Mercury Probe", version: "0.1.0" },
      capabilities: { experimentalApi: true },
    });
    this.sendNotification("initialized");
    console.log(`[codex] app-server ready on ${url}`);
  }

  connect(url) {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url);
      ws.onopen = () => { this.ws = ws; resolve(); };
      ws.onerror = (e) => reject(new Error(`WebSocket error: ${e.message ?? "unknown"}`));
      ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data.toString());
          this.handleMessage(msg);
        } catch (e) {
          console.error("[codex] parse error:", e);
        }
      };
      ws.onclose = () => { this.ws = null; };
    });
  }

  request(method, params) {
    return new Promise((resolve, reject) => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
        reject(new Error("Codex app-server WebSocket is not open"));
        return;
      }
      const id = this.nextId++;
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  sendNotification(method, params = {}) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ method, params }));
    }
  }

  handleMessage(msg) {
    if (msg.id !== undefined && msg.id !== null) {
      const pending = this.pending.get(msg.id);
      if (pending) {
        this.pending.delete(msg.id);
        if (msg.error) pending.reject(new Error(JSON.stringify(msg.error)));
        else pending.resolve(msg.result);
      }
      return;
    }
    if (msg.method) {
      const handlers = this.notificationHandlers.get(msg.method);
      if (handlers) {
        for (const h of handlers) h(msg.params);
      }
    }
  }

  onNotification(method, handler) {
    if (!this.notificationHandlers.has(method)) {
      this.notificationHandlers.set(method, new Set());
    }
    this.notificationHandlers.get(method).add(handler);
    return () => this.notificationHandlers.get(method)?.delete(handler);
  }

  async createThread(model) {
    const result = await this.request("thread/start", { model: model || null });
    const threadId = result?.thread?.id;
    if (!threadId) throw new Error("thread/start did not return a thread id");
    this.threads.push(threadId);
    return threadId;
  }

  scratchKey(sourceThreadId, model, developerInstructions, sandboxMode) {
    return `${sourceThreadId}|${model ?? "default"}|${developerInstructions ? "voice" : "none"}|${sandboxMode ?? "readOnly"}`;
  }

  async forkThread(sourceThreadId, model, developerInstructions, cwd, sandboxMode) {
    const key = this.scratchKey(sourceThreadId, model, developerInstructions, sandboxMode);
    const cached = this.scratchCache.get(key);
    if (cached) return cached;
    const sandbox = sandboxMode === "workspaceWrite" ? "workspace-write" : "read-only";
    const result = await this.request("thread/fork", {
      threadId: sourceThreadId,
      ephemeral: true,
      ...(model && model !== "default" ? { model } : {}),
      ...(developerInstructions ? { developerInstructions } : {}),
      cwd: cwd ?? null,
      approvalPolicy: "never",
      sandbox,
      config: {},
    });
    const threadId = result?.thread?.id;
    if (!threadId) throw new Error("thread/fork did not return a thread id");
    this.threads.push(threadId);
    this.scratchCache.set(key, threadId);
    return threadId;
  }

  clearScratchCache() {
    this.scratchCache.clear();
  }

  async readThread(threadId, includeTurns = true) {
    return await this.request("thread/read", { threadId, includeTurns });
  }

  async listTurns(threadId, limit = 100) {
    return await this.request("thread/turns/list", { threadId, itemsView: "full", limit });
  }

  async compactThread(threadId) {
    return new Promise((resolve, reject) => {
      let settled = false;
      const off = this.onNotification("turn/completed", (params) => {
        if (params?.threadId !== threadId && params?.turn?.threadId !== threadId) return;
        if (settled) return;
        settled = true;
        off();
        clearTimeout(timer);
        resolve({ turnId: params?.turn?.id, status: params?.turn?.status });
      });
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        off();
        reject(new Error("Compaction timed out after 180s"));
      }, 180000);
      this.request("thread/compact/start", { threadId }).catch((e) => {
        if (settled) return;
        settled = true;
        off();
        clearTimeout(timer);
        reject(e);
      });
    });
  }

  runTurn({ threadId, input, model, effort, signal, onDelta, onFirstDelta, onComplete, outputSchema, sandboxMode, cwd }) {
    return new Promise(async (resolve, reject) => {
      let turnId = null;
      let text = "";
      let sawFirstDelta = false;
      let settled = false;

      const cleanup = () => {
        offDelta?.();
        offCompleted?.();
        offError?.();
      };

      const offDelta = this.onNotification("item/agentMessage/delta", (params) => {
        if (params?.turnId !== turnId) return;
        const delta = String(params?.delta ?? "");
        text += delta;
        onDelta?.(delta, text);
        if (!sawFirstDelta) {
          sawFirstDelta = true;
          onFirstDelta?.();
        }
      });

      const offCompleted = this.onNotification("turn/completed", (params) => {
        if (params?.turn?.id !== turnId) return;
        if (settled) return;
        settled = true;
        cleanup();
        onComplete?.({ text, status: params?.turn?.status ?? "completed" });
        resolve({ text, status: params?.turn?.status ?? "completed" });
      });

      const offError = this.onNotification("error", (params) => {
        if (params?.turnId !== turnId && params?.turn?.id !== turnId) return;
        if (settled) return;
        settled = true;
        cleanup();
        reject(new Error(`Codex turn error: ${JSON.stringify(params)}`));
      });

      if (signal) {
        signal.addEventListener("abort", () => {
          if (settled) return;
          if (turnId) {
            this.request("turn/interrupt", { threadId, turnId }).catch(() => {});
          }
          settled = true;
          cleanup();
          resolve({ text, status: "interrupted" });
        });
      }

      try {
        const sandboxPolicy = sandboxMode === "workspaceWrite"
          ? { type: "workspaceWrite", writableRoots: cwd ? [cwd] : [], networkAccess: false, excludeTmpdirEnvVar: false, excludeSlashTmp: false }
          : { type: "readOnly", networkAccess: false };
        const response = await this.request("turn/start", {
          threadId,
          input: [{ type: "text", text: input, text_elements: [] }],
          model: model === "default" || !model ? null : model,
          effort: effort ?? "medium",
          summary: null,
          outputSchema: outputSchema ?? null,
          sandboxPolicy,
          approvalPolicy: "never",
        });
        turnId = response?.turn?.id;
        if (!turnId) {
          cleanup();
          reject(new Error("turn/start did not return a turn id"));
        }
      } catch (e) {
        cleanup();
        reject(e);
      }
    });
  }

  async stop() {
    this.ws?.close();
    this.ws = null;
    if (this.process) {
      await new Promise((resolve) => {
        const proc = this.process;
        const timer = setTimeout(() => proc.kill("SIGKILL"), 3000);
        proc.on("exit", () => { clearTimeout(timer); resolve(); });
        proc.kill("SIGTERM");
      });
      this.process = null;
    }
  }
}

export const codexClient = new CodexClient();
