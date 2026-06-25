# Ensemble Adversarial Review — Mortic UX/UI

**Review label:** Kimi 2.7 Review  
**Date:** 2026-06-19  
**Repo:** `/Users/aeroknight/Downloads/as/simple_mortic`  
**Working-tree state:** uncommitted changes present (`git status --short` showed modified `package.json`, `src/client/App.tsx`, `src/client/components/ThreadPicker.tsx`, `src/client/desktopBridge.ts`, `src/client/styles.css`, `src/client/voice/useVoiceEngine.ts`, `src/desktop/main.ts`, `src/desktop/preload.cjs`, `src/server/app.ts`, `src/server/codex.ts`, plus an untracked `scripts/eval_desktop_ux.mjs`).  
**Approach:** reverse-engineer the Electron shell, map the full web UI, run a static desktop-UX eval harness, and spawn four focused subagents to attack the experience from the user’s point of view. No code was changed for this review.

---

## 0. Important caveat — the first pass was slightly out of date

The initial code walk-through was based on the `AGENT_HANDOFF.md` snapshot and the files as they existed before the most recent edits. A `git diff` revealed active work in the working tree that materially changes the UX:

- **ThreadPicker now has search, workspace scoping, and a preview panel** (`src/client/components/ThreadPicker.tsx`).
- **Overlay now cancels audio when hidden** and **restores the overlay when the full app closes** (`src/desktop/main.ts`, `src/client/App.tsx`).
- **Placeholder/no-thread gating was promoted across both overlay and full app** (`threadRequired` checks in `App.tsx`).
- **PTT labels were normalized** to “Hold M / Hold M to queue / Release to send.”
- **A new `scripts/eval_desktop_ux.mjs` harness was added** (36 checks, 7 warnings, 0 failures at the time of running).

The findings below are grounded in the **current working tree**, not the snapshot. Line numbers are approximate because the tree is still moving.

---

## 1. What the app actually is today

Mortic is a local voice/text sidecar for OpenAI Codex CLI threads. The core promise is:

> Speak to an existing Codex thread without polluting it, then carry a clean handoff back to Codex.

Two UI surfaces share the same React app:

1. **Electron overlay** (`src/desktop/main.ts` + `surface=overlay`) — a frameless, always-on-top floating window.
2. **Full browser app** (`surface` omitted) — a normal Electron window or the browser tab opened by `npm run dev`.

The overlay is intentionally minimal; the full app exposes configuration, project memory, and review flows. In practice the two surfaces feel like different products, and several backend features have no UI at all.

---

## 2. Methodology

1. **Reverse-engineered the Electron shell** — read `src/desktop/main.ts`, `preload.cjs`, `src/client/desktopBridge.ts`, and the overlay branch of `App.tsx`.
2. **Ran the in-repo desktop UX eval** — `node scripts/eval_desktop_ux.mjs` (7 warnings, 0 failures).
3. **Mapped the full web UI** — traced `App.tsx`, components, modals, and server routes.
4. **Compared server routes to client callers** — identified orphaned endpoints.
5. **Spawned four adversarial subagents**:
   - Electron overlay & shell UX audit.
   - Full web app UX audit.
   - Remnant / dead-feature audit.
   - Accessibility, visual design, error-handling, and privacy audit.
6. **Synthesized** the overlapping findings into this document, deduplicated, and ranked by user impact.

The review is adversarial: every finding is phrased as a real user problem, not a code critique.

---

## 3. Executive verdict

Mortic has a working, genuinely impressive voice-to-Codex loop buried inside a confusing cockpit. The biggest UX risks are not the voice pipeline — they are **conceptual overload**, **inconsistent surfaces**, and **disabled/exposed features that do not exist**.

The app currently ships three products at once:

1. A **voice scratchpad** (the overlay).
2. A **configuration cockpit** (the full app).
3. A **canonical project-memory system** (chart, canonical state, extractions) that is exposed but never explained.

The third product is the source of most user confusion. Many of its UI pieces are reachable only in the full app, while others are dead code, and the overlay pretends none of it exists.

### Top risks in one sentence each

1. **No thread selected** is a dead-end in the overlay — the user must expand the panel, discover “Finder,” and understand Codex threads before any action is possible.
2. **Config is hidden in the overlay** — the user cannot change model, access, or voice providers without opening a different window.
3. **Jargon everywhere** — “Compile,” “Canonical,” “Delta,” “Caveman,” “Spark context,” “Fork,” and “Scaffold” are shown without plain-language explanation.
4. **Live mode is a tease** — a visible On/Off toggle that is always disabled.
5. **Destructive actions have no confirmation** — Clear scratch, Approve all, and thread switching can wipe state instantly.
6. **Copy handoff gives zero feedback** — users click multiple times because nothing visibly happens.
7. **Accessibility gaps** — disabled text is nearly invisible, the PTT button is mouse-only, and modals do not trap focus.
8. **Surface-switching can leak audio** — hiding the overlay or switching windows does not always stop speech.
9. **Orphaned backend routes** — several endpoints exist but have no UI, leaving dead weight and future security surface.
10. **The overlay and full app disagree on what the product is** — one is a minimal HUD, the other is a dense project-management dashboard.

---

## 4. Built surface vs. remnants

| Feature / concept | Overlay? | Full app? | Orphaned backend? | User value today | Disposition |
|---|---|---|---|---|---|
| Push-to-talk voice turn | Yes | Yes | No | High | Keep |
| Text composer turn | Yes | Yes | No | High | Keep |
| Thread picker (search + preview) | Yes | Yes | No | High | Keep, fix interaction |
| Handoff generate / copy | Yes | Yes | No | High | Keep, fix feedback |
| Live transcript card | Yes (last turn) | Yes (last turn) | No | High | Keep, show more turns |
| Config panel | Read-only summary only | Yes | No | High | Make editable in overlay or clearer entry point |
| Onboarding | No | Yes | No | High | Also surface in overlay |
| Project updates / extraction review | Handoff only | Yes | No | Medium-High | Keep, rename “Compile” |
| Canonical Chart | No | Yes | No | Medium for power users | Redesign / gate |
| Canonical State modal | No | Yes | No | Low / confusing | Hide or redesign |
| Live mode toggle | Visible, always disabled | Visible, always disabled | No | Negative | Hide |
| Caveman speech toggle | No | Yes | No | Negative | Rename or hide |
| Spark context / model-transition preflight | No | Hardcoded off | Yes (`/api/session/spark-context`, `/api/session/spark-context/compact`) | None | Remove UI, decide backend fate |
| Fork action sheet | No | Rendered but never triggered | Yes (`/api/project/fork/access`) | Negative | Remove |
| `SideRail` component | No | Exported, never imported | N/A | N/A | Remove |
| `TelemetryPanel` component | No | Exported, never imported | N/A | N/A | Remove or wire under debug |
| Checkpoint confirm/dismiss/manual endpoints | No | No | Yes (`/api/project/checkpoint/*`) | N/A | Remove |
| Draft-compilation import endpoint | No | No | Yes (`/api/project/draft-compilations/import`) | N/A | Remove |
| Compilation approve endpoint | No | No | Yes (`/api/project/compilations/:id/approve`) | N/A | Remove or wire |
| Coverage latest endpoint | No | No | Yes (`/api/project/coverage/latest`) | N/A | Remove |
| Session archive endpoint | No | No | Yes (`/api/project/session/archive`) | N/A | Remove or add UI |
| Turn interrupt endpoint | No | No | Yes (`/api/turn/:turnId/interrupt`) | N/A | Remove or wire |
| Standalone STT/TTS/LiveKit status endpoints | No | No | Yes | N/A | Remove or keep diagnostics-only |
| Design-mocks (`design-mocks/*.html`) | No | No | N/A | N/A | Archive / remove |

---

## 5. Section-by-section adversarial findings

### 5.1 Onboarding & first run

#### 5.1.1 The overlay has no onboarding at all
- **User problem:** I installed Mortic, opened the desktop app, and I’m staring at a tiny floating bar with no instructions. I don’t know the shortcut, the push-to-talk key, or that I need a Codex thread.
- **Severity:** high
- **Evidence:** `OnboardingScreen` is only rendered in the full app (`src/client/App.tsx` ~2587). The overlay branch (~1923–2154) contains no onboarding component.
- **Fix:** Render a compact, dismissible first-run hint inside the overlay: “1) Pick a Codex thread, 2) Hold M to talk, 3) Press Esc to collapse/hide.” Store a flag so it only appears once.

#### 5.1.2 Onboarding finishes without explaining the core workflow
- **User problem:** I complete the three setup steps, click “Check again,” and then I’m dropped into a dense screen full of “scratch,” “canonical,” and “Fork” labels with no idea what to do first.
- **Severity:** high
- **Evidence:** `src/client/components/OnboardingScreen.tsx` ends at the skill step; `src/client/App.tsx` main shell starts immediately after.
- **Fix:** Add a final onboarding step or first-run overlay showing the loop: pick thread → talk/type → generate handoff → paste into Codex.

#### 5.1.3 Onboarding uses unexplained jargon
- **User problem:** The first screen says Mortic does “voice turns and Compile.” I don’t know what “Compile” means.
- **Severity:** medium
- **Evidence:** `src/client/components/OnboardingScreen.tsx:24-27`.
- **Fix:** Replace “Compile” with “turn your scratch notes into saved project updates,” and link to a one-sentence explanation.

#### 5.1.4 Onboarding errors are hard to read
- **User problem:** Red error text is desaturated and italic on a dark card; I can barely parse it, and screen-reader users get no announcement.
- **Severity:** medium
- **Evidence:** `src/client/components/OnboardingScreen.tsx:69-72`, `src/client/styles.css:3913-3918`.
- **Fix:** Use `font-style: normal`, a clearer red (`#ff9e96`), and wrap errors in an `aria-live="polite"` region.

---

### 5.2 Thread / project selection

#### 5.2.1 The collapsed overlay has no picker
- **User problem:** The overlay says “Select thread,” but the only way to do that is to expand the panel first. The collapsed HUD gives me no path forward.
- **Severity:** high
- **Evidence:** `threadRequired` blocks controls (`src/client/App.tsx` ~1869–1872); `ThreadPicker` is only inside the expanded panel (~1991).
- **Fix:** When no thread is selected, replace the disabled mic in the collapsed HUD with a prominent “Pick a conversation” button that expands the panel and opens the picker.

#### 5.2.2 The picker button is called “Finder”
- **User problem:** I need to select a Codex conversation, but the only button near the source field is labeled “Finder.” I don’t know that means “select a recent Codex thread.”
- **Severity:** high
- **Evidence:** `src/client/components/ThreadPicker.tsx:70-72`, `src/client/App.tsx:2168-2179`.
- **Fix:** Rename to “Select thread” or “Recent threads.”

#### 5.2.3 Selecting a thread requires discovering the preview step
- **User problem:** I click a thread in the list and it only highlights; nothing happens. I have to notice the preview pane at the bottom and click “Open this thread.”
- **Severity:** medium
- **Evidence:** `src/client/components/ThreadPicker.tsx:113-136` uses `onClick` to preview and `onDoubleClick` to commit.
- **Fix:** Make a single click commit (with optional confirmation), or add a primary “Open this thread” action directly on each row.

#### 5.2.4 No way to enter a thread URI manually
- **User problem:** The picker says “No local Codex conversations found.” I know my thread URI (`codex://threads/...`), but the topbar only has a read-only label and a picker button — no input field.
- **Severity:** critical
- **Evidence:** `src/client/App.tsx:2164-2179`.
- **Fix:** Add an editable source URI input to the topbar (in both overlay and full app) so users can paste a thread URI when the recent list is empty.

#### 5.2.5 Thread picker lacks keyboard navigation
- **User problem:** I’m a keyboard user. I can’t use ↑/↓/Enter to pick a thread or Escape to close the picker.
- **Severity:** medium
- **Evidence:** `src/client/components/ThreadPicker.tsx:68-141`.
- **Fix:** Add `onKeyDown` handlers to the search input and list items.

#### 5.2.6 Empty canvas doesn’t guide the user to pick a thread
- **User problem:** When I open the full app I see a big orb and the text “Select a Codex thread to start,” but there is no obvious button to do that in the main canvas area.
- **Severity:** high
- **Evidence:** `src/client/App.tsx:2341-2348`.
- **Fix:** Replace the empty message with a centered CTA button “Choose a Codex thread” that opens the picker.

#### 5.2.7 Switching source threads wipes state without warning
- **User problem:** I clicked a different thread in the topbar and lost my current transcript and handoff. No one warned me.
- **Severity:** medium
- **Evidence:** `src/client/App.tsx:1513-1562`, `src/client/App.tsx:2168-2179`.
- **Fix:** If the current transcript is non-empty, prompt: “Switching threads clears the current scratch. Copy handoff first?” with actions to copy, switch anyway, or cancel.

---

### 5.3 Desktop overlay shell

#### 5.3.1 Global shortcut is invisible
- **User problem:** I see a tiny floating bar. I have no idea how to summon it later, hide it, or why it appeared. The shortcut `Cmd+Shift+M` / `Ctrl+Shift+M` is never shown in the collapsed HUD.
- **Severity:** high
- **Evidence:** Shortcut registered at `src/desktop/main.ts:28`; label only used on the Hide button tooltip in the expanded panel (`src/client/App.tsx:2028-2029`).
- **Fix:** Print the shortcut persistently in the collapsed HUD, and show a first-run toast: “Press Cmd+Shift+M to show/hide Mortic.”

#### 5.3.2 Collapsed bar has no expand affordance
- **User problem:** The collapsed bar looks like a read-only status widget. I don’t realize I have to click the “Mortic” title area to expand it, and I can’t collapse it without first expanding it.
- **Severity:** medium
- **Evidence:** Expand is only on `.desktop-hud-identity` click (`src/client/App.tsx:1947`).
- **Fix:** Add an explicit expand/collapse toggle button (chevron) in both states.

#### 5.3.3 Full-app / overlay ownership is confusing
- **User problem:** I opened the full app and now my global shortcut just focuses the big window; it doesn’t bring back the overlay. I expected the shortcut to toggle between the two.
- **Severity:** medium
- **Evidence:** `fullAppOwnsScreen()` (`src/desktop/main.ts:152-154`); `toggleOverlay` bails to focusing the full window (`src/desktop/main.ts:283-288`).
- **Fix:** Make the shortcut a true toggle: full app visible → hide/minimize it and reveal overlay; overlay hidden → reveal it.

#### 5.3.4 Surface switching can leak audio
- **User problem:** I hide the overlay or switch to the full app while Mortic is still talking, and the voice keeps playing. I expected all audio to stop when the overlay is not the active surface.
- **Severity:** high
- **Evidence:** Explicit hide now sends `audio-cancel` (`src/desktop/main.ts:156-160`, `src/client/App.tsx:607-614`), but blur/visibilitychange in `useVoiceEngine.ts` only stops recognition, not TTS. Revealing the overlay after full-app close does not reset stale audio state.
- **Fix:** Route blur/visibilitychange through the same audio-cancel path, and reset audio state before `revealOverlay`.

#### 5.3.5 Micro density makes controls disappear
- **User problem:** I resized the overlay to make it tiny, and now most controls have vanished and the text is unreadable. The mic button is so small I keep missing it.
- **Severity:** high
- **Evidence:** Minimum scale is `0.4` (`src/desktop/main.ts:25-26`), yielding ~304×33 px collapsed. `.desktop-density-micro` hides status, interrupt, handoff, working buffer, config, and thread labels; the mic becomes ~62×24 px (`src/client/styles.css:4621-4828`).
- **Fix:** Raise the minimum scale to at least `0.65`. Add a “Reset size” button. At micro density, keep a one-tap expand affordance visible.

#### 5.3.6 Expanded panel has weak visual hierarchy
- **User problem:** The expanded panel is a wall of equal-weight boxes. I can’t tell that the transcript is the main thing, the composer is secondary, and the handoff/config are extras.
- **Severity:** medium
- **Evidence:** Expanded layout renders header, transcript, working buffer, controls, composer, handoff card, and config footer with similar card styling (`src/client/App.tsx:1983-2151`).
- **Fix:** Stack the conversation card and composer at the top with stronger borders; move handoff and config into a collapsible sidebar or bottom drawer.

#### 5.3.7 Status dot is falsely reassuring
- **User problem:** The overlay shows a green dot even when it says “Select thread.” Green makes me think everything is ready, but actually I can’t do anything yet.
- **Severity:** low
- **Evidence:** `src/client/App.tsx:1957-1958`.
- **Fix:** Use an amber/warning status dot when `threadRequired` is true; green only when a thread is selected and ready.

---

### 5.4 Voice interaction & agent canvas

#### 5.4.1 The orb gives no hint how to start talking
- **User problem:** I see a glowing orb, but I don’t know if I should click it, type, or hold a key. The mic is a small button below.
- **Severity:** high
- **Evidence:** `src/client/App.tsx:2333-2340`, `src/client/App.tsx:2397-2424`.
- **Fix:** Add a persistent sub-label under the orb such as “Hold M to talk, or type below,” and make the orb itself clickable to start listening.

#### 5.4.2 Orb says “READY” when the app is actually blocked
- **User problem:** No thread is selected, the mic is disabled, and the composer is disabled, yet the orb says “READY.”
- **Severity:** high
- **Evidence:** `src/client/App.tsx:2337-2348`.
- **Fix:** When `threadRequired` is true, change the orb label to “Select a thread” and use a warning color.

#### 5.4.3 Orb labels use internal jargon
- **User problem:** The orb shows “Scratch ready” or “Warm failed.” I don’t know what “scratch ready” or “warm” means.
- **Severity:** high
- **Evidence:** `src/client/App.tsx:1645-1654`, `src/client/App.tsx:2337-2338`.
- **Fix:** Use human labels: “Ready to talk,” “Preparing model…,” “Model setup failed.”

#### 5.4.4 Push-to-talk button is mouse/touch-only
- **User problem:** I try to tab to the mic and press Enter/Space, but nothing happens because it only uses pointer events.
- **Severity:** critical
- **Evidence:** `src/client/App.tsx:2397-2424`, `src/client/App.tsx:1891-1921`.
- **Fix:** Add keyboard support (Space/Enter to start, release to stop) and a visible shortcut hint.

#### 5.4.5 Voice control labels still cycle confusingly
- **User problem:** The mic button label changes constantly (“Hold M”, “Hold M to queue”, “Release to send”, “Live on”, “Transcribing”), but I never know which mode I’m in.
- **Severity:** medium
- **Evidence:** `dockTalkLabel` logic (`src/client/App.tsx:1688-1697`).
- **Fix:** Always show a persistent secondary hint next to the mic: “Hold M to talk.” When disabled, replace the hint with the reason.

#### 5.4.6 Interrupt does not let me talk immediately
- **User problem:** I hit “Interrupt” while Mortic is speaking. The audio stops, but then I have to press and hold `M` separately to say my follow-up. I expected interrupting to immediately let me talk.
- **Severity:** medium
- **Evidence:** `interruptTurn` calls `interruptSpeechOnly(..., false)` (`src/client/voice/useVoiceEngine.ts` ~1800), so `beginLocalBargeIn` only mutes.
- **Fix:** After an explicit interrupt click, auto-arm push-to-talk for ~2 seconds and show “Listening — speak now or hold M.”

#### 5.4.7 Disabled states lack explanation
- **User problem:** Buttons are often grayed out and I have no idea why. The mic is disabled when no thread is selected, when Live mode is on, when a model preflight is blocked, or during transcribing — but it all looks the same.
- **Severity:** high
- **Evidence:** Mic disabled logic (`src/client/App.tsx:1699-1703`); Live disabled with no visible reason (`src/client/App.tsx:2095`); Interrupt disabled with no tooltip (`src/client/App.tsx:1966`, `2105`); Handoff generate disabled when `transcript.length === 0` (`src/client/App.tsx:2137`).
- **Fix:** Every disabled control should expose a tooltip or adjacent micro-label explaining the blocker.

#### 5.4.8 Barge-in feedback is inconsistent
- **User problem:** Sometimes when Mortic is talking and I hold `M`, it interrupts and listens immediately. Other times it seems to start a new turn instead. I can’t tell which happened until the transcript updates.
- **Severity:** medium
- **Evidence:** `startPushToTalkCapture` (`src/client/voice/useVoiceEngine.ts:2265-2286`).
- **Fix:** Provide immediate visual feedback: “Interrupting… speak now” vs. “Listening…”. Unify behavior so push-to-talk during assistant speech always barge-ins.

---

### 5.5 Configuration panel

#### 5.5.1 Config panel is collapsed by default
- **User problem:** The settings that control every turn (model, access preset, voice pipeline) are hidden inside a collapsed `<details>` panel. As a first-time user I may not realize I should open it.
- **Severity:** high
- **Evidence:** `src/client/App.tsx:2189-2193`.
- **Fix:** Default the config panel to open on first visit, or surface the most critical controls (model + access) outside the collapsible area.

#### 5.5.2 Config is read-only in the overlay
- **User problem:** I want to change the model, voice provider, or access level from the overlay, but the bottom of the expanded panel only shows a static config summary. It looks like a footer, not a settings entry point.
- **Severity:** high
- **Evidence:** `.desktop-overlay-config-summary` (`src/client/App.tsx:2145-2150`).
- **Fix:** Convert the config footer into an inline disclosure that edits the most common settings, with a “More settings in full app →” link.

#### 5.5.3 “Caveman speech” is unexplained jargon
- **User problem:** I see a checkbox called “Caveman speech.” I have no idea what that means, and the tooltip says “Caveman-lite compression,” which doesn’t help.
- **Severity:** high
- **Evidence:** `src/client/App.tsx:2266-2268`.
- **Fix:** Rename to “Short spoken replies” with helper text: “Mortic will speak shorter, simpler answers when voice mode is on.”

#### 5.5.4 Model dropdown is a wall of acronyms
- **User problem:** The model menu shows model IDs with no guidance on which one to pick.
- **Severity:** medium
- **Evidence:** `src/client/lib/labels.ts:177-185`, `src/client/App.tsx:2204-2208`.
- **Fix:** Add short plain-language descriptions under each option and group recommended vs. advanced models.

#### 5.5.5 Reasoning effort lacks impact explanation
- **User problem:** I can choose “None / Minimal / Low / Medium / High / XHigh” but I don’t know what changes in the response or how much it costs.
- **Severity:** low
- **Evidence:** `src/client/lib/labels.ts:16-23`, `src/client/App.tsx:2211-2219`.
- **Fix:** Add one-line tooltips such as “More reasoning = slower but more thorough planning.”

#### 5.5.6 Spark-context block is dead code
- **User problem:** When I pick a smaller model, nothing happens. The docs or old screenshots mention “Compact Then Retry / Start Anyway,” but I never see it.
- **Severity:** medium
- **Evidence:** `needsModelTransitionPreflight()` is hardcoded `false` (`src/client/lib/spark.ts`); the UI panel exists but is never rendered (`src/client/App.tsx:2301-2323`).
- **Fix:** Remove the spark-context UI from the app. Decide whether to keep or delete the backend endpoints.

---

### 5.6 Transcript

#### 5.6.1 Live card only shows the last turn
- **User problem:** I’m in a back-and-forth and I can only see the very latest message; the last few turns are hidden.
- **Severity:** low
- **Evidence:** `src/client/App.tsx:2341-2383` uses `latestUserEntry`, `latestAssistantAfterUser`.
- **Fix:** Show the last 3–5 turns in the live card with a compact scrollable view.

#### 5.6.2 Assistant “notes” are collapsed by default
- **User problem:** Mortic answered with useful details hidden under a “Read”/“Notes” disclosure, but I didn’t notice it and thought the response was empty.
- **Severity:** medium
- **Evidence:** `src/client/App.tsx:2369-2374`.
- **Fix:** Auto-expand notes in the live card when there is no spoken text, or add a visual indicator that more content exists.

#### 5.6.3 Expanded transcript header exposes raw session ID
- **User problem:** I open the transcript and the header says “ID: abc-123-…” which is noise; I just want to read the conversation.
- **Severity:** low
- **Evidence:** `src/client/components/SessionModals.tsx:30-35`.
- **Fix:** Move or hide the session ID; show the thread title and turn count.

#### 5.6.4 Transcript drawer has no copy or search
- **User problem:** I want to save part of the conversation or find something I said earlier, but there are no copy/search controls.
- **Severity:** medium
- **Evidence:** `src/client/components/SessionModals.tsx:25-75`.
- **Fix:** Add a “Copy transcript” button and a search/filter input.

---

### 5.7 Handoff

#### 5.7.1 Handoff header shows turn count as a status
- **User problem:** Before I generate a handoff, the card header says “Handoff / 3 turns.” I think that means I have a 3-turn handoff, but it really means there are 3 transcript turns and no handoff yet.
- **Severity:** medium
- **Evidence:** `src/client/App.tsx:1663`, `src/client/components/ProjectPanels.tsx:273-277`.
- **Fix:** Use distinct labels: “No handoff yet · 3 turns” or “Ready to generate.”

#### 5.7.2 Copying a handoff gives no feedback
- **User problem:** I click “Copy Short” but nothing visibly happens, so I click it three times.
- **Severity:** high
- **Evidence:** `src/client/App.tsx:1473-1491`, `src/client/components/SessionModals.tsx:351-352`.
- **Fix:** Update the clicked button to “Copied” for ~2 s, announce via a live region, and handle `navigator.clipboard` failures with a fallback “Copy manually” textarea.

#### 5.7.3 Token-budget details are user-hostile
- **User problem:** I expand handoff tools and see “Token budget,” raw token counts, and “Avoided input over 5 future turns.” I just want a summary to paste into Codex.
- **Severity:** medium
- **Evidence:** `src/client/components/ProjectPanels.tsx:282-302`.
- **Fix:** Move token metrics into an advanced disclosure and surface the human benefit first, e.g. “~60% shorter than the full transcript.”

#### 5.7.4 Handoff review modal doesn’t explain short vs. full
- **User problem:** I open “Handoff Review” and see two editable boxes: “Short prompt” and “Full prompt.” I don’t know which one to copy or when to use each.
- **Severity:** medium
- **Evidence:** `src/client/components/SessionModals.tsx:323-346`.
- **Fix:** Add helper text: “Short: one-line next instruction for Codex. Full: detailed context and next steps.”

#### 5.7.5 No action to complete the handoff workflow
- **User problem:** I copied the handoff. Now I have to manually switch back to Codex and paste it. The UI doesn’t help me finish the loop.
- **Severity:** high
- **Evidence:** `src/client/components/ProjectPanels.tsx:303-307`, `src/client/components/SessionModals.tsx:349-353`.
- **Fix:** Add an “Open source thread in Codex” button when `openTarget` is available, and/or a combined “Copy and open Codex” action.

---

### 5.8 Project updates / insights / canonical features

#### 5.8.1 “Compile active scratch” is jargon
- **User problem:** The side rail has a big button labeled “Compile active scratch.” I don’t know whether that builds code, saves notes, or does something else.
- **Severity:** high
- **Evidence:** `src/client/components/ProjectPanels.tsx:180-182`.
- **Fix:** Rename to “Save approved updates to project” and disable it when there are no approved updates.

#### 5.8.2 Empty state uses the word “compile”
- **User problem:** The empty state says “No project updates compiled yet” and the review modal says “Compile a session after real decisions…” I don’t know what compile means.
- **Severity:** medium
- **Evidence:** `src/client/components/ProjectPanels.tsx:267`, `src/client/components/SessionModals.tsx:187`.
- **Fix:** Use “saved” instead of “compiled,” e.g. “Talk or type first, then save useful updates here.”

#### 5.8.3 “Approve all” approves everything without confirmation
- **User problem:** I click “Approve all” thinking I’ll review the list later, but it immediately approves every pending update and saves them to the project.
- **Severity:** high
- **Evidence:** `src/client/components/ProjectPanels.tsx:253`, `src/client/App.tsx:2460`.
- **Fix:** Change to “Approve all and save” and require a confirmation dialog listing the count and types.

#### 5.8.4 Side rail surfaces implementation concepts as primary UI
- **User problem:** The side rail shows “Fork tree,” “Canonical chart,” “Deltas,” “Scaffold trace,” etc. These are Mortic internals, not the tasks I came here to do.
- **Severity:** medium
- **Evidence:** `src/client/components/ProjectPanels.tsx:95-178`.
- **Fix:** Collapse or demote the scaffold/canonical sections; keep the primary actions (save updates, generate handoff) prominent. Note: `SideRail` is currently exported but not imported into `App.tsx`, so this is already dead code.

---

### 5.9 Chart / canonical state

#### 5.9.1 Chart modal is titled with jargon and lacks explanation
- **User problem:** I open “Chart” and see a modal titled “Canonical Chart” with panels for “Timeline,” “Deltas,” and “Provenance.” I don’t know what any of those mean.
- **Severity:** high
- **Evidence:** `src/client/components/ChartModal.tsx:78-89`, `111-188`.
- **Fix:** Add an inline subtitle: “Saved project updates over time.” Rename panels to “Versions,” “Changes,” and “Source.”

#### 5.9.2 Provenance panel exposes raw IDs and lifecycle strings
- **User problem:** I select a delta and the right panel shows “stableKey,” “canonicalItemId,” “targetCanonicalItemId,” and “create -> open.” This looks like a database row, not a user interface.
- **Severity:** high
- **Evidence:** `src/client/components/ChartModal.tsx:196-225`.
- **Fix:** Hide raw IDs behind an “Advanced” toggle and render the lifecycle as plain English, e.g. “Created: open item.”

#### 5.9.3 Canonical state modal is unexplained
- **User problem:** I open “Open State” and see “Canonical state” with “Production chart” and “Extracted items.” I don’t know what canonical state is or what to do with it.
- **Severity:** high
- **Evidence:** `src/client/components/ChartModal.tsx:307-337`.
- **Fix:** Add a one-sentence explanation at the top, e.g. “The current saved summary of your project,” and explain what each pane contains. Consider gating this behind an advanced mode.

#### 5.9.4 Chart modal has no export action
- **User problem:** I found the delta I care about, but I can’t copy or export its content; I can only read the metadata.
- **Severity:** medium
- **Evidence:** `src/client/components/ChartModal.tsx:50-289`.
- **Fix:** Add “Copy delta” and “Copy artifact” buttons to the provenance panel.

---

### 5.10 Disabled / non-existent features

#### 5.10.1 Live mode toggle is a tease
- **User problem:** I tap “Live” and it’s grayed out. There’s no explanation unless I happen to notice a tiny tooltip that says “echo-safe turn detection.”
- **Severity:** high
- **Evidence:** `LIVE_MODE_RUNTIME_ENABLED = false` (`src/client/lib/voice.ts:19`); toggle disabled at `src/client/App.tsx:2095` and `2391`.
- **Fix:** Hide the toggle entirely until live mode is implemented. If you must surface it, show a passive note: “Push-to-talk only — live listening is not available yet.”

#### 5.10.2 Spark context UI is dead code
- **User problem:** I never see the “Compact Then Retry” or “Start Anyway” buttons, but they are wired into the app and referenced in docs.
- **Severity:** medium
- **Evidence:** `src/client/lib/spark.ts` hardcodes `false`; `src/client/App.tsx:2301-2323` is unreachable.
- **Fix:** Remove the spark-context UI and the related backend endpoints if they are not part of the current product.

#### 5.10.3 Fork action sheet is unreachable and dangerous
- **User problem:** There is a hidden “resume in main thread” action that could violate the app’s safety promise, but it is never shown.
- **Severity:** high
- **Evidence:** `ForkActionSheet` is rendered (`src/client/App.tsx:2576`) but `openForkSheet` is never called; `SideRail` is exported but never imported.
- **Fix:** Remove `ForkActionSheet`, `SideRail`, and the `/api/project/fork/access` endpoint if they are not planned.

---

### 5.11 Errors, edge cases, and recovery

#### 5.11.1 Codex unavailable mid-session does not disable input
- **User problem:** Codex becomes unavailable, the topbar dot turns red, but I can still click the mic and type a turn. The app lets me try and then fails.
- **Severity:** high
- **Evidence:** `pushToTalkDisabled` does not include `!session?.codex.available` (`src/client/App.tsx:1699-1703`); composer submit not disabled for that reason (`src/client/App.tsx:2449`).
- **Fix:** Disable voice and text input when `session?.codex.available` is false, and show a persistent notice: “Codex is unavailable. Check installation/login. You can still review transcript and handoff.”

#### 5.11.2 STT/TTS provider notices are computed but not rendered
- **User problem:** Voice provider status messages exist in the code but I never see them, so when STT or TTS fails I have no idea what happened.
- **Severity:** high
- **Evidence:** `sttProviderNotice` and `ttsProviderNotice` are returned from `useVoiceEngine` and destructured in `App.tsx` (~536–601) but not rendered in the JSX.
- **Fix:** Render the notices in a dedicated, dismissible status bar near the voice controls, with `aria-live="polite"`.

#### 5.11.3 Silent fallback from remote STT to browser STT
- **User problem:** My Deepgram credits ran out and the app switched to Browser STT without asking me. I thought I was still using Deepgram.
- **Severity:** medium
- **Evidence:** `src/client/voice/useVoiceEngine.ts:1921-1936`.
- **Fix:** Show a confirmation banner: “Deepgram credits exhausted. Switched to Browser STT. [Switch back] [Keep Browser].”

#### 5.11.4 Mic permission denial has no recovery guidance
- **User problem:** I denied the mic and a transient notice appeared, but I don’t know how to re-enable it or switch to typing.
- **Severity:** medium
- **Evidence:** `src/client/voice/useVoiceEngine.ts:2068-2079`, `src/client/lib/voice.ts:101-104`.
- **Fix:** Add a persistent inline banner with a “Use text input” shortcut and platform-specific instructions.

#### 5.11.5 Clear scratch wipes everything without confirmation
- **User problem:** I clicked the button labeled “Reset” thinking it would clear my current draft, but it cleared the entire scratch session, transcript, and handoff.
- **Severity:** critical
- **Evidence:** `src/client/App.tsx:2429-2432`, `src/client/App.tsx:1493-1511`.
- **Fix:** Rename to “Clear scratch,” show a confirmation modal, and offer an undo toast for 5–10 s.

#### 5.11.6 Approval/dismissal of extraction cards is immediate
- **User problem:** I clicked “Approve” or “Dismiss” on a project update and it took effect instantly. A misclick can permanently alter canonical project state.
- **Severity:** high
- **Evidence:** `src/client/App.tsx:1340-1366`, `src/client/components/SessionModals.tsx:241-258`.
- **Fix:** Add confirmation for bulk approval/dismissal, or at minimum a one-click undo toast.

#### 5.11.7 Server errors can leak raw messages
- **User problem:** A server error shows me an internal path or provider detail that I shouldn’t see.
- **Severity:** medium
- **Evidence:** `src/server/app.ts:1104-1108` returns `error.message` from project store creation failure.
- **Fix:** Sanitize or classify server errors before sending to the client; send a stable error code plus a safe user-facing message.

#### 5.11.8 Error notices can’t be dismissed
- **User problem:** A transient error appears at the top and stacks on top of previous errors with no way to clear them.
- **Severity:** low
- **Evidence:** `src/client/App.tsx:2327-2331`.
- **Fix:** Add a dismiss button to each `.notice.error` and auto-dismiss transient messages after a few seconds.

---

### 5.12 Accessibility & visual design

#### 5.12.1 Disabled text contrast is below WCAG AA
- **User problem:** I can’t read disabled buttons. The text is `rgba(229, 226, 225, 0.34)` on a near-black background — effectively invisible.
- **Severity:** critical
- **Evidence:** `src/client/styles.css:88-92`, `src/client/styles.css:2207-2213`, `src/client/styles.css:4235-4251`.
- **Fix:** Use a solid color with ≥4.5:1 contrast (e.g. `#8a9191`) and add a non-color cue such as a dashed border.

#### 5.12.2 Secondary metadata contrast is too low
- **User problem:** Thread-picker helper text and system-note headers are translucent/dim and hard to read.
- **Severity:** high
- **Evidence:** `src/client/styles.css:1220-1234`, `src/client/styles.css:3765-3776`.
- **Fix:** Raise small meta text to at least `#a8b0b8` and avoid opacity below 0.8 for text smaller than 12 px.

#### 5.12.3 The entire UI is monospace
- **User problem:** Reading longform transcript, handoff, and notes in JetBrains Mono is harder than a proportional font, especially for users with reading disabilities or low vision.
- **Severity:** high
- **Evidence:** `src/client/styles.css:6`, `src/client/styles.css:33-35`.
- **Fix:** Introduce a proportional sans-serif stack for body, headings, and longform areas. Reserve monospace for code, labels, timestamps, and status badges.

#### 5.12.4 Longform text is too small and cramped
- **User problem:** Transcript and handoff text is 13–14 px with 1.45–1.55 line height in monospace, which feels cramped.
- **Severity:** medium
- **Evidence:** `src/client/styles.css:54-55`, `src/client/styles.css:1508-1515`.
- **Fix:** For longform prose, use a minimum 16 px font size and 1.6 line height, and switch to a proportional font.

#### 5.12.5 Modals do not trap focus or return focus
- **User problem:** I’m a keyboard user. When a modal opens, focus stays behind the backdrop, and when I close it I don’t return to the button that opened it.
- **Severity:** high
- **Evidence:** `src/client/components/SessionModals.tsx:25-74`, `src/client/components/OnboardingScreen.tsx:21-91`.
- **Fix:** On open, move focus to the modal heading or first focusable control; trap focus inside; on close, restore focus to the trigger.

#### 5.12.6 Runtime errors are not announced
- **User problem:** A screen-reader user hears nothing when an error notice appears.
- **Severity:** high
- **Evidence:** `src/client/App.tsx:2327-2330`.
- **Fix:** Wrap `.notice-row` in an `aria-live="polite" aria-atomic="true"` container.

#### 5.12.7 Access preset radio group has mixed roles
- **User problem:** The Codex access preset uses `role="radio"` on `<button>` elements, but arrow-key navigation expected for a radio group is not implemented.
- **Severity:** medium
- **Evidence:** `src/client/App.tsx:2227-2248`.
- **Fix:** Use native `<input type="radio">` or implement full ARIA radio keyboard handling.

#### 5.12.8 Status colors are not available to color-blind users
- **User problem:** I can’t tell approved vs. risk vs. retired cards apart because the only difference is a colored left border.
- **Severity:** medium
- **Evidence:** `src/client/styles.css:292-307`, `src/client/styles.css:1963-1981`.
- **Fix:** Add text labels or icons alongside color, and `aria-label` on status-only dots.

#### 5.12.9 Orb motion cannot be fully disabled
- **User problem:** The orb pulse and ambient drift make me uncomfortable, and the `prefers-reduced-motion` override only shortens durations rather than stopping motion.
- **Severity:** medium
- **Evidence:** `src/client/styles.css:1387-1430`, `src/client/styles.css:3589-3597`.
- **Fix:** Under `prefers-reduced-motion`, completely disable the orb halo blur, scale transforms, and pulse. Add a settings toggle to disable animated feedback.

#### 5.12.10 Source code snippets are capped at 42 px height
- **User problem:** Code snippets inside project cards are a tiny scrollable box that is hard to use.
- **Severity:** medium
- **Evidence:** `src/client/styles.css:758-773`.
- **Fix:** Increase `max-height` to at least `160px`, or use an expandable `<details>` panel.

---

### 5.13 Privacy

#### 5.13.1 Browser STT privacy caveat is hidden
- **User problem:** I selected “Browser” STT without realizing Chrome/Safari/Edge send my voice audio to the browser vendor’s cloud.
- **Severity:** high
- **Evidence:** `src/client/App.tsx:2280-2288`, `src/client/voice/useVoiceEngine.ts:484`.
- **Fix:** Show a persistent, dismissible privacy notice when browser STT is active: “Browser STT sends audio to your browser vendor. Use a server-side STT provider or type to keep audio local.”

---

## 6. Top 10 user-facing problems (ranked)

1. **No manual thread URI input and poor picker discoverability** — users can be stuck before they start.
2. **Push-to-talk button is not keyboard accessible** — violates basic accessibility.
3. **Clear scratch is destructive without confirmation** — users can lose work in one click.
4. **Copy handoff gives no feedback** — users don’t know if anything happened.
5. **Disabled text contrast is nearly invisible** — WCAG failure.
6. **Config is hidden / read-only in the overlay** — users cannot change settings in the primary surface.
7. **Orb says “READY” while controls are blocked** — false reassurance.
8. **Live mode toggle is a visible tease** — promises a feature that does not exist.
9. **Canonical/chart UI is jargon-heavy and unexplained** — confusion for anyone who opens it.
10. **Surface switching can leak audio** — polish/expectation mismatch.

---

## 7. Prioritized fix backlog

### Immediate (ship-blocking for a polished release)

1. Make the push-to-talk button keyboard-operable.
2. Fix disabled-state contrast across the app.
3. Add confirmation/undo for Clear scratch and bulk approval.
4. Provide visible feedback on handoff copy.
5. Disable voice/text input and explain why when Codex is unavailable.
6. Render the existing `sttProviderNotice` / `ttsProviderNotice` values.
7. Add a manual source URI input to the topbar.
8. Hide or explain the Live mode toggle.

### Short term (large UX win)

9. Rename or hide “Caveman speech.”
10. Rewrite orb and status labels in plain language.
11. Add first-run guidance inside the overlay.
12. Improve thread-picker single-click selection and keyboard navigation.
13. Move token metrics behind an advanced disclosure; surface human-readable handoff benefit.
14. Add confirmation before switching source threads with non-empty transcript.
15. Gate or redesign the Chart / Canonical State modals with plain-language copy.

### Medium term (structural)

16. Remove dead UI components and orphaned backend endpoints (`ForkActionSheet`, `SideRail`, `TelemetryPanel`, spark-context UI, checkpoint endpoints, etc.).
17. Unify the overlay and full-app experience so the overlay feels like a focused subset, not a different product.
18. Add `aria-live` regions, focus traps, and skip links.
19. Introduce a proportional font for body/longform text.
20. Add a persistent browser-STT privacy notice.

---

## 8. Appendix: subagent contributions and eval harness

- **Subagent 1 — Electron overlay & shell UX audit:** produced 17 findings covering shortcut discoverability, collapsed/expanded state, placeholder gating, config hiding, voice labels, interrupt behavior, audio leaks, window ownership, resize extremes, and visual hierarchy.
- **Subagent 2 — Full web app UX audit:** produced 35 findings covering onboarding, thread selection, config panel, agent canvas, transcript, voice dock, handoff, project updates, chart/canonical modals, and app-level errors.
- **Subagent 3 — Remnant / dead-feature audit:** produced the decision table and top-5 confusing remnants (Live mode, Caveman speech, Canonical state, Canonical chart, Provider References).
- **Subagent 4 — Accessibility, visual design, error handling, privacy audit:** produced findings on contrast, all-monospace UI, focus management, motion sensitivity, STT/TTS errors, Codex unavailability, empty/loading states, copy feedback, destructive-action confirmations, and privacy disclosures.
- **`scripts/eval_desktop_ux.mjs` harness:** 36 checks, 29 pass, 7 warn, 0 fail. Warnings focused on barge-in state ownership, full-app/overlay ownership, all-workspaces pinning, minimum resize scale, fixed typography, full-app/overlay feature parity, and scattered gate logic.

---

## 9. Final note

Mortic’s core loop — pick a thread, talk to a scratch fork, generate a handoff — is real and works. The adversarial review shows that the product’s biggest enemy right now is not the voice pipeline, but the **surface area of unexplained concepts and dead UI**. The fastest path to a shippable, lovable experience is to:

1. Decide whether the canonical project-memory layer is part of this release.
2. If yes, explain it in plain language and make it optional/advanced.
3. If no, remove its UI and the orphaned backend routes.
4. Harden the overlay so a user can complete the core loop without ever opening the full app.

That is the shape of the next iteration.

---

## 10. GLM 5.2 Review — Interaction UX & Eval-Harness Blindspots

**Review label:** GLM 5.2 Review
**Date:** 2026-06-19
**Lens:** product manager trying to move the *interaction* from 80 → 95, plus a real user who talks, interrupts, queues, and switches surfaces mid-turn.
**Scope:** the entire voice/chat interaction loop — STT capture, VAD, barge-in/interrupt, turn queuing, TTS queuing/fallback, latency budgets, and the eval harnesses that claim to cover them. No code was changed.
**Method:** read the full voice engine (`useVoiceEngine.ts`, 2334 lines), the shared interaction modules (`bargeInControl`, `inputControl`, `sttFailure`, `voiceResponse`, `speechProjection`), the client TTS providers (`tts.ts`), the server turn/stream/interrupt endpoints (`app.ts`), and every eval harness in `scripts/eval_*.mjs`. Then wrote and ran a 15-check probe (`glm52_interaction_probe.mjs`) that exercises the pure interaction-logic layer no harness covers. Probe result: **15/15 blindspots reproduced**.

### 10.1 What the interaction loop actually is

```text
user holds M
  → mic capture (Web Audio ScriptProcessor, rms-based VAD)
  → segment rollover (soft 10s / hard 18s / 5MB)
  → /api/stt/transcribe (provider + fallback)
  → sendTurn(text) ── if pending: queue locally (queuedTurnRef) ── else POST /api/turn
  → SSE /api/turn/:id/stream (delta / status / voiceActivity / snapshot)
  → partialSpokenText → projectSpeech → chooseSpeakableEnd (chunk)
  → speech queue + ledger → TTS provider.speak (Deepgram/ElevenLabs WS / Browser)
  → audio play → on end, flush next chunk
barge-in (hold M while speaking, or Interrupt button):
  → beginLocalBargeIn → cancelSpeechAudio (mute) → optionally capture next turn
```

The user's mental model is simpler: *I talk, it answers, I can cut it off, it remembers what I queued.* Every box in that diagram is a place the experience can silently break.

### 10.2 Existing eval harnesses — what they cover and what they miss

| Harness | What it tests | Interaction layer covered | Key gap |
|---|---|---|---|
| `eval_desktop_ux.mjs` | 36 static source-pattern checks | None at runtime | Source grep only; flags barge-in complexity as a *warning* but never runs the state machine |
| `eval_stt_latency.mjs` | `/api/stt/transcribe` round-trip + word recall on clean synthesized audio | STT provider call only | No VAD, no segmentation, no browser STT, no first-token split, recall metric unvalidated |
| `eval_deepgram_tts_latency.mjs` | Deepgram WS/REST first-audio + projected gaps | Deepgram TTS only | Projects (models) gaps instead of playing audio; never tests fallback/Browser/ElevenLabs; chunking policy ≠ production |
| `eval_progress_speech.mjs` | Server progress-speech trace (status before first delta) | Server trace only | Doesn't test client caps/throttle/dedup or progress-vs-assistant collision |
| `eval_mortic_runnability.mjs` | Health, session, UI boot, prewarm, cold/warm turns, failure recovery | End-to-end text turns | Fakes `sttMetrics`; `waitForNoRunningTurn` before every turn, so **queue/interrupt/409 are never hit**; no voice I/O |
| `check_voice_pipeline.mjs` | Unit tests: parsing, STT status, fallback attribution, handoff | Pure logic | Doesn't touch the renderer state machine, VAD, or TTS runtime |

**Thesis:** the harnesses prove the *plumbing* works in isolation. The 80→95 gap is the **interaction state machine that joins them** — capture → barge-in → queue → send → stream → TTS → cancel — and no harness exercises that join. Worse, two harnesses (`eval_mortic_runnability`, `eval_stt_latency`) actively *avoid* the hard paths by waiting for idle and feeding clean audio.

### 10.3 Fifteen blindspots found and tested

A runnable probe (`glm52_interaction_probe.mjs`, in the session temp dir) imports the compiled `dist/node/shared/*` modules and reads the source to demonstrate each gap. Every check reproduced.

**Interrupt & barge-in (the biggest 80→95 gap)**

1. **The Interrupt button does not interrupt the model — it only mutes the speaker.** `interruptTurn()` → `interruptSpeechOnly("interrupt-button", false)` → `cancelSpeechAudio()` (`useVoiceEngine.ts:1800`, `:1224`, `:1073`). No client code ever calls `/api/turn/:id/interrupt` (grep of `useVoiceEngine.ts` + `App.tsx` = 0 hits). The server interrupt endpoint exists (`app.ts:1955`) and calls `interruptCodexScratch()`, but it is orphaned from the UI. **User impact:** I hit Interrupt, the voice stops, but the Codex turn keeps running, burning tokens and time. My queued follow-up can't send until the hidden turn finishes. The product *feels* broken.
2. **`interruptionLatencyMs` is hardcoded `0`.** `beginLocalBargeIn` sets `interruptionLatencyMs: 0` at the barge-in instant (`useVoiceEngine.ts:1216`) instead of measuring audio-stop-to-capture-start. The metric that *would* quantify interrupt responsiveness is fake, so no dashboard will ever surface a regression here.
3. **Barge-in via push-to-talk also never calls the server.** `startPushToTalkCapture` → `beginLocalBargeIn("push-to-talk")` mutes + captures, then `sendTurn` queues because `pending` is still true (`useVoiceEngine.ts:2265`, `:1564`). So "talk over the assistant" actually means "mute, record, and wait in a queue."

**Queuing**

4. **Turn queueing is renderer-local and fragile.** The server returns **409** when a turn is running (`app.ts:1465`) and has no queue API. The client stashes the queued turn in a `useRef` (`queuedTurnRef`, `useVoiceEngine.ts:1564`). A page reload, an Electron surface switch, or an SSE drop that triggers `reattachActiveTurn` **silently drops the queued turn**. `eval_mortic_runnability.mjs` calls `waitForNoRunningTurn` before every turn, so the queue/409 path is never exercised by any eval.
5. **`hasAssistantOutputForBargeIn` over-triggers on stale live text.** It returns `true` when `liveAssistantText` is non-empty even if the turn ended and audio is idle (`bargeInControl.ts:12`, probe `result=true`). Holding M after a finished turn (the live card still shows text) routes through barge-in (mute + capture + queue) instead of starting a fresh turn. The user gets "Audio muted. Listening for next turn." when they expected a normal new turn.

**STT**

6. **The remote-STT submit gate is dead.** `stopRemoteSttCapture` calls `shouldSubmitCapturedTurn({ transcriptText: "remote audio" })` (`useVoiceEngine.ts:2104`), so the `transcriptText.trim()` check is always truthy and the gate collapses to `speechDetected` only (`inputControl.ts:50`). The transcript guard protects browser STT but is a no-op for remote STT. No eval covers remote-STT submit gating.
7. **VAD thresholds are hardcoded magic numbers, untested.** `rms > 0.018`, `now - lastSpeechAt > 1300`, `now - sessionStartedAt > 1700` (`useVoiceEngine.ts:2007`, `:2035`–`:2036`) gate end-of-turn for barge-in capture and (disabled) live mode. The STT eval feeds clean full-volume synthesized audio, so VAD sensitivity, silence timing, and false-triggers are never exercised.
8. **Browser STT — the default free path — has zero latency/accuracy coverage.** `eval_stt_latency.mjs` defaults to `deepgram-stt` and only hits `/api/stt/transcribe`. When no provider keys are set, every user gets Browser SpeechRecognition, and no harness measures it.
9. **STT latency eval reports only total round-trip `elapsedMs`.** It cannot split connect/first-byte from transcribe-final (`eval_stt_latency.mjs:62`). The client tracks `firstSpeechDetectedMs`/`firstFinalTranscriptMs`/`finalSttReadyMs` but no eval asserts relationships between them, so a slow-connect provider is indistinguishable from a slow-transcribe one.

**TTS**

10. **TTS latency eval chunks at 40 chars; production Deepgram chunks at 16.** `eval_deepgram_tts_latency.mjs` hardcodes `FIRST_CHUNK_CHARS=40` (`:14`) while `src/client/lib/voice.ts` uses `DEEPGRAM_FIRST_CHUNK_CHARS=16` (`:12`). Probe: for `"Here is the plan. Then…period."`, the eval's first chunk is **98 chars** but production sends a **17-char** first chunk. The eval's first-audio latency numbers do not reflect what the user hears, and the eval never tests Browser/ElevenLabs/Inworld chunking.
11. **Mid-turn TTS fallback is unmeasured.** The eval only hits `/api/tts/deepgram/*`. The client speech queue silently falls back per-chunk (cooldown + `disableFallbackAfterAudioStarted` in `tts.ts`), but no eval simulates a provider failing mid-utterance, so fallback gaps and "spokenBy" attribution are untested.
12. **The 60s per-chunk TTS watchdog is untested.** `TTS_CHUNK_WATCHDOG_MS=60000` (`useVoiceEngine.ts:55`, `:925`) catches a stalled WS and marks the chunk failed, but no harness injects latency to verify the watchdog, the `ttsError` metric, or recovery to the next chunk.

**State-machine & surface switching**

13. **`cancelSpeechAudio` nukes every `<audio>/<video>` on the page.** It does `document.querySelectorAll("audio,video")` and pauses + unsrcs all of them (`useVoiceEngine.ts:1088`). A barge-in or hide-event kills the progress keyboard-loop audio (and any future media), not just TTS. No eval asserts collateral damage.
14. **Window blur stops recognition but not TTS — audio leaks.** The blur/visibilitychange effect calls `invalidateRecognition` only (`useVoiceEngine.ts:1546`); it does not call `cancelSpeechAudio` (probe confirms). `eval_desktop_ux.mjs` flagged this as a static *warning*; no runtime eval verifies TTS stops when the overlay loses focus.
15. **A code/notes-only assistant delta produces empty spokenText — dead air with no signal.** `partialSpokenText('{"type":"read",…}')` returns `""` (probe), so during streaming a delta that only contains code/notes queues no speech. The user gets silence with no "still working" cue until a `speak` record arrives. No eval measures time-to-silence or treats "zero spoken audio for N seconds" as a failure.

### 10.4 Product-manager verdict — what moves the dial 80 → 95

The voice *plumbing* is already strong: provider fallback attribution, monotonic speech ledger, session-ID guarding against stale STT callbacks, and a real audio-health timing budget. The 80→95 gap is **control semantics**: the things the user believes they control (interrupt, queue, barge-in) are partly illusory, and the harnesses certify the plumbing while leaving the illusions intact.

The single highest-leverage fix is **#1: make Interrupt and barge-in actually stop the Codex turn**, not just mute the speaker. Until that is true, every "interrupt" the user performs is a lie the UI tells them, and the queued-turn UX (#4) compounds it. This is also the cheapest gap to add an eval for, because the server already has the endpoint — the client just isn't calling it.

### 10.5 Ranked interaction fixes

1. **Wire `interruptTurn` and barge-in to `/api/turn/:id/interrupt`.** Stop the model, don't just mute. Show "Stopping…" until the turn reaches `interrupted`.
2. **Measure `interruptionLatencyMs` for real** (barge-in audio-stop → server interrupt ack → capture-start) and surface it in audio-health.
3. **Persist the queued turn.** Either let the server accept a queued turn (202 + queue position) or persist `queuedTurnRef` to `sessionStorage` so reload/SSE-drop doesn't lose it.
4. **Reset `liveAssistantText` on turn end** so `hasAssistantOutputForBargeIn` stops over-triggering, or narrow it to `pending || speaking || queueLength>0`.
5. **Cancel TTS on blur/visibilitychange**, not just recognition. Route both through the same `audio-cancel` path the desktop hide uses.
6. **Scope `cancelSpeechAudio` to TTS-owned media** instead of every `<audio>/<video>` on the page.
7. **Add a "dead air" watchdog**: if `scratchMode==="voice"` and no speech has queued within N seconds of the first delta, speak a fallback ("Still working…") or show a visible cue.
8. **Fix the remote-STT submit gate** to pass the real (possibly empty) transcript text so the guard is meaningful, and treat `speechDetected && empty transcript` as a soft retry, not a silent drop.
9. **Parameterize VAD thresholds** and add a unit eval with noisy/silent fixtures so `rms>0.018` and the 1300/1700ms timers are grounded.
10. **Align the TTS eval's chunking policy with `src/client/lib/voice.ts`** (import the shared `chooseSpeakableEnd`) and extend the eval to ElevenLabs/Inworld/Browser.

### 10.6 Recommended new evals to close the gap

- **`eval_interrupt_latency.mjs`** — start a voice turn, POST `/api/turn/:id/interrupt` at first audio, assert turn reaches `interrupted` within X ms and that a follow-up turn is accepted immediately. This would have caught blindspot #1 on day one.
- **`eval_turn_queue.mjs`** — POST `/api/turn` while running (expect 409 or 202-queued), reload the client, assert the queued turn either survives or is surfaced as a conflict.
- **`eval_barge_in_state.mjs`** — drive `hasAssistantOutputForBargeIn` + `inputControl` through the phase matrix (idle/stale-text/speaking/queueing) and assert the intended routing.
- **`eval_tts_fallback_midturn.mjs`** — stream a multi-chunk utterance, force the primary WS to close mid-chunk, assert fallback `spokenBy` attribution and no gap > threshold.
- **`eval_dead_air.mjs`** — feed a read/code-only delta stream, assert a voice-mode fallback cue fires within N seconds.
- **`eval_browser_stt.mjs`** — latency + recall for Browser SpeechRecognition (the default free path) using `say`-synthesized audio through the real capture path.

### 10.7 Probe evidence

```
$ node glm52_interaction_probe.mjs
[BLINDSPOT] 1. Client never calls /api/turn/:id/interrupt ...
[BLINDSPOT] 2. audioHealth.interruptionLatencyMs is hardcoded 0 ...
... (15 total)
=== GLM 5.2 interaction probe: 15 checks, 15 blindspots, 0 confirmed-baseline ===
```

Baseline harnesses run in the same environment: `eval_desktop_ux` 7 warn / 0 fail; `check_voice_pipeline` passed; `check_input_control` passed; `check_first_turn_warm` passed. The live evals (`eval_stt_latency`, `eval_deepgram_tts_latency`, `eval_progress_speech`, `eval_mortic_runnability`) require a running server + provider API keys + a configured Codex thread, none of which were present — which is itself a CI blindspot: the most important interaction evals cannot run without heavy, keyed fixtures.

---

## 11. GLM 5.2 Review — Ultra-Deep Adversarial Pass (Subagent Ensemble)

**Review label:** GLM 5.2 Review (Ensemble)
**Date:** 2026-06-19
**Lens:** product manager moving the product 80 → 95, plus a real user. Six ultra-deep adversarial subagents each owned one major interaction surface and applied the cross-cutting lenses you named: **scale** (what breaks at 10×), **bloat / minimalist-simpler**, **latency** (especially conversational streaming before the final answer), and **cognitive load reduced without losing function**, all while thinking as the user.
**Method:** six `general` subagents ran in parallel, each read its surface deeply (with `file:line` evidence) and returned a structured report. This section synthesizes, deduplicates, and ranks them. No code was changed. (One subagent wrote a scratch file `TURN_LIFECYCLE_ADVERSARIAL_PASS.md`; it was removed and its content folded here.)

The six surfaces:
- **A — Conversational streaming & latency** (the make-or-break feature).
- **B — Turn lifecycle, interrupt, queue, prewarm** (control honesty).
- **C — STT capture, VAD, mic, provider fallback.**
- **D — TTS runtime, provider chain, fallback, audio lifecycle.**
- **E — Cognitive load, surface coherence, mental model.**
- **F — Scale, architecture & bloat** (minimalist/simpler).

### 11.1 Headline per surface

| Surface | Headline finding | Worst user-visible symptom |
|---|---|---|
| A · Streaming | First audio waits for a **sentence terminator**, not 16 chars; the Deepgram "stream" endpoint is **buffered, not streamed**; AudioContext is **recreated every turn** | ~500–1300 ms of avoidable silence before the first word, every turn |
| A · Streaming | On model repair, the client **silently keeps the first (wrong) spoken partial and drops the correction** | The user hears an answer the screen no longer shows — silent misinformation |
| B · Lifecycle | Interrupt **and** barge-in **never call the server**; the model keeps running; a queued turn can't send until the hidden turn self-completes | "I stopped it, but it kept going" |
| B · Lifecycle | `pollTurn` has `try/finally` with **no catch** — one network error during SSE fallback **permanently wedges `pending` true** and traps the queue | Only a reload recovers; the desktop refresh guard is blocked |
| B · Lifecycle | `reattachActiveTurn` **re-speaks the entire answer from char 0** on reload/SSE-drop | Phantom audio after a reconnect |
| C · STT/VAD | VAD is a fixed `rms > 0.018` with **no noise-floor adaptation**; the 1300 ms silence cutoff **also applies to push-to-talk** | A quiet talker is never heard; a slow speaker is cut off mid-thought while still holding M |
| C · STT/VAD | A single segment failure (`Promise.all`) **discards the whole turn and wastes the provider credits** of the segments that succeeded | A 45 s monologue vanishes on one transient 502 |
| D · TTS | `beginTurn`/`finishTurn` **never propagate to nested fallbacks** → one Deepgram-REST blip **permanently downgrades the chain for the session** | The REST voice never comes back, even hours later |
| D · TTS | Mid-sentence fallback **switches voice identity** (Inworld → ElevenLabs → Browser) with **no audio cue** and a cold-connect gap | One reply in three voices |
| E · Cognitive | The UI forces ~**26 concepts** and **17+ state labels**; only **6 concepts / 5 states** are load-bearing | The user must decode the UI before every utterance |
| E · Cognitive | The orb says **"READY" while blocked** (no thread / Codex offline); the HUD is honest, the orb is not | False reassurance at the exact moment the user is stuck |
| F · Scale/Bloat | `src/server/codexAppServerProtocol/` is **557 files / 5,810 LOC with zero references** — 19% of all source LOC is dead generated cargo | Pure weight; the published `dist` may carry it |
| F · Scale | A stale `activeTurn` (crash mid-turn) **locks the whole app with 409s forever** — no reaper | The app bricks until manual session clearing |

### 11.2 Cross-cutting themes (recur across surfaces)

These six themes appear in 3+ subagent reports — they are the real 80→95 levers, not the surface-level bugs.

1. **The user's controls are partly illusory.** Interrupt mutes but doesn't stop (B, §10.3). "Hold M to queue" makes the user predict a state they can't see (E). The Live toggle is a visible dead feature (E, C). The "queue" is a verb the user must learn instead of a system behavior (E, B). *Fix direction: one honest verb per intent; the system sequences, the user acts.*

2. **State is over-booked and under-truthful.** Five speech refs describe the same progress (A, D); 17+ UI labels map to 5 real states (E); the orb and HUD compute the *same* truth with *different* logic (E); `speechPhase` lies "idle" while Browser TTS is still speaking (D). *Fix: one ledger, one truth function, one status vocabulary across both surfaces.*

3. **First-audio latency has ~500–1300 ms of avoidable serial delay.** Wait-for-sentence-end (A), buffered (not streamed) Deepgram fetch (A), per-turn AudioContext teardown (A, D), cold-connect on fallback (D), post-stop full-segment transcription (C). *Fix: first-chunk at first clause, stream the first chunk, warm AudioContext, prewarm fallback tier.*

4. **Failure modes silently mislead rather than merely delay.** Model repair keeps the wrong spoken partial (A); mid-sentence voice switch with no cue (D); silent credit-exhaustion switch that also drops the current recording (C, §10.3); pollTurn wedge (B); phantom re-speak on reattach (B). *Fix: on divergence/failure, reset + cue + recover visibly.*

5. **Scale failure modes are "lock the whole app" not "degrade."** Single stale `activeTurn` → 409 forever (F); global bridge op lock — one compaction stalls all turns (F); `turnReplay` Map leak (A, F); `emitTurnEvent` no try/catch — one dead socket breaks fan-out (A, F). *Fix: reaper, split queues, fold replay into persisted turn, guard the emit loop.*

6. **The default shipped surface is ~2× larger than the core loop needs.** 557-file protocol dir (F), ~5,681 LOC canonical subsystem backing 5 orphaned routes (F), dormant spark preflight (F), 892-LOC CLI fallback (F), duplicate TTS WS handlers (D), dual browser/remote STT state machines (C). *Fix: minimal core + flagged advanced; ~54% server-LOC reduction with the voice loop intact.*

### 11.3 Surface A — Conversational streaming & latency (the make-or-break feature)

**Streaming latency budget (model-first-token → first audio play), from `appServerBridge.ts` → SSE → client → TTS:**

| Hop | Typical ms | Avoidable? | Evidence |
|---|---|---|---|
| Model TTFT | 300–1200 | No | `appServerBridge.ts:1611` |
| Bridge → SSE emit | 1–5 | No | `app.ts:1655` |
| SSE network hop | 20–80 | No | `app.ts:1992`, `useVoiceEngine.ts:1650` |
| `partialSpokenText` re-parses **full cumulative JSON** each delta | 0.5–3, **O(n²)** | **Yes** | `useVoiceEngine.ts:1468`, `voiceResponse.ts:183` |
| Wait for a **sentence terminator `[.!?]`/`\n\n`** at ≥16 chars (else wait to 220 chars) | **150–750** | **Yes — dominant** | `voice.ts:86-91` |
| `beginTurn` tears down AudioContext → recreate | **80–250** | **Yes** | `tts.ts:478`, `:306` |
| `fetch /api/tts/deepgram/stream` → `await arrayBuffer()` (**full chunk, not streamed**) | **250–800** | **Yes** | `tts.ts:356` |
| Decode + schedule + 80 ms lead | 85 | Minor | `tts.ts:362`, `:396` |

**Total first-audio ≈ 900–2700 ms, of which ~500–1300 ms is avoidable.** The 16-char "first chunk" constant is misleading: `chooseSpeakableEnd` requires a sentence boundary, so the first chunk actually fires at the first period (40–80 chars).

**Ranked findings (A):**

| # | Finding | Severity | Evidence | Lens |
|---|---|---|---|---|
| A1 | First-chunk waits for a sentence terminator, not 16 chars | High | `voice.ts:86-91` | latency |
| A2 | Deepgram client buffers the whole chunk; `/stream` is not streamed | High | `tts.ts:356` | latency |
| A3 | AudioContext destroyed + recreated every turn | Medium | `tts.ts:478`, `:306` | latency |
| A4 | **On model repair, the spoken partial is kept and the correction is silently dropped** | **Critical** | `app.ts:1793-1804`; `useVoiceEngine.ts:1375-1381`, `:1415` | correctness/cognitive |
| A5 | Per-chunk watchdog is 60 s → up to 60 s dead air on a hung TTS | High | `useVoiceEngine.ts:55` | latency |
| A6 | "Still thinking" cue stops at first *delta*, not first *audio* → dead-air window | Medium | `useVoiceEngine.ts:558` | cognitive |
| A7 | SSE `onerror` permanently downgrades to 500 ms polling; loses spoken status events | High | `useVoiceEngine.ts:1751` | latency/cognitive |
| A8 | `emitTurnEvent` has no try/catch; one dead socket breaks fan-out | High | `app.ts:713-717` | scale |
| A9 | `turnReplay` is an unbounded in-memory Map, no TTL | Medium | `app.ts:678` | scale |
| A10 | `partialSpokenText` re-parses cumulative JSON every delta → O(n²) | Medium | `useVoiceEngine.ts:1468` | latency/bloat |
| A11 | Three redundant "apply turn state" paths (snapshot/delta/poll) | Medium | `useVoiceEngine.ts:1656,1726,1774` | bloat |
| A12 | Quadruple speech bookkeeping (`queue`+`ledger`+`lastQueuedChar`+`spokenChars`) | Low-Med | `useVoiceEngine.ts:215-219` | bloat |
| A13 | `ScriptProcessorNode` (deprecated) for mic capture | Low | `useVoiceEngine.ts:1990` | bloat |
| A14 | Poll re-feeds identical `replayText` every 500 ms → pointless re-renders | Low | `useVoiceEngine.ts:1775` | bloat |
| A15 | "finalizing" draft phase armed on a 1400 ms timer while still streaming | Low | `useVoiceEngine.ts:56`, `:297` | cognitive |

**A4 is the only critical-severity item across all six passes:** the server re-runs the prompt on parser repair and emits fresh deltas, but the client's divergence gate (`speechText.startsWith(previousSpeechText)`) blocks re-queueing, so the user hears the *first* (malformed) attempt and never hears the correction. **Fix:** on divergence, reset the speech ledger, cancel in-flight TTS, re-queue from 0, and optionally speak a short "Actually—" cue.

**Minimalist streaming redesign (A):** server emits the *speak-text delta* (parsed server-side) so the client stops parsing JSON (kills A10 and A4 at the source); first-chunk breaks at first clause ≥8 chars (A1); stream the first Deepgram chunk via `response.body` reader or use the WS provider for chunk #1 (A2); keep one warm AudioContext per provider (A3); collapse the three apply-paths into one `applyTurnEvent` reducer (A11); keep only `speechLedger` and derive the rest (A12). **First-audio budget drops from ~900–2700 ms to ~450–1100 ms.**

### 11.4 Surface B — Turn lifecycle, interrupt, queue, prewarm (control honesty)

**Control honesty audit:**

| Control | Label promise | Actual behavior | Honest? | Evidence |
|---|---|---|---|---|
| Hold M | "Hold to talk" | Captures; but inherits barge-in's 1300 ms silence cutoff → can cut off mid-hold | Partial | `useVoiceEngine.ts:2271`, `:2035` |
| Release to send | Sends on release | Sends, unless `pending` → queues (label mutates) | Partial | `useVoiceEngine.ts:1564` |
| Hold M to queue | "Your hold will queue" | Queues locally; **lost on reload** | No | `useVoiceEngine.ts:1564` |
| Interrupt button | "Stop the assistant" | **Only mutes local audio; model keeps running server-side** | **No** | `useVoiceEngine.ts:1800`; no `/interrupt` call |
| Live toggle | "Live listening" | **Always disabled** (`LIVE_MODE_RUNTIME_ENABLED=false`) | No | `voice.ts:19` |
| Clear/Reset | "Reset draft" | **Wipes entire scratch session with no confirm** | No | `App.tsx:2429` |
| Prewarm | "Prepare model" | **A full billed Codex turn + spoken "I am ready…" TTS** on every model/mode/access toggle | Costly | `app.ts:1314-1423` |

**Ranked findings (B) — beyond §10.3:**

| # | Finding | Severity | Evidence | Lens |
|---|---|---|---|---|
| B1 | Neither Interrupt nor barge-in calls `/api/turn/:id/interrupt` (compounds §10.3 #1) | Critical | `useVoiceEngine.ts:1800`, `:2271` | control |
| B2 | `pollTurn` `try/finally` with **no catch** — one network error wedges `pending` true forever | High | `useVoiceEngine.ts:1758-1798` | correctness/scale |
| B3 | `reattachActiveTurn` re-speaks the entire answer from char 0 on reload/SSE-drop (phantom audio) | High | `useVoiceEngine.ts:787`, snapshot `replayText` + zeroed `lastQueuedCharRef` | cognitive |
| B4 | Queue lives only in a renderer `useRef` — dropped on reload; one global `activeTurn` gives other tabs opaque 409s | High | `useVoiceEngine.ts:1564`; `app.ts:1465` | scale |
| B5 | Prewarm is a full billed turn + spoken announcement on every config toggle — net-negative unless the user talks next with identical config | Medium | `app.ts:1314-1423` | bloat/cognitive |
| B6 | `interruptResumeAction` exists to auto-arm listening after interrupt — **never imported anywhere** (scaffolding built and abandoned) | Medium | `inputControl.ts:58-64` | bloat |
| B7 | A server restart orphans a running bridge turn because `storage.ts:72` hides `running` activeTurns on load | Medium | `storage.ts:72` | scale |
| B8 | Single global `activeTurn` + 409 — no queue API; multi-window unsafe | Medium | `app.ts:1465` | scale |

**Minimalist lifecycle redesign (B):** one honest "Stop" verb wired to `/interrupt` (B1); auto-arm listening for ~2 s after stop (use the abandoned `interruptResumeAction`, B6); persist the queued turn to `sessionStorage` or add a server queue (B4); add a `catch` to `pollTurn` that surfaces the error and resets `pending` (B2); on reattach, cancel in-flight audio and only *display* the replay text, never re-speak it (B3); gate prewarm behind "user has talked before with this config" or make it silent (B5).

### 11.5 Surface C — STT capture, VAD, mic, fallback

**VAD & capture edge matrix:**

| Scenario | Expected | Actual | Evidence |
|---|---|---|---|
| Quiet talker, headset | Detects speech | RMS never crosses 0.018 → 8 s timeout → "empty turn discarded" | `useVoiceEngine.ts:2007` |
| Noisy room, keypresses | Ignores noise | Each keypress spikes RMS → `lastSpeechAt` stays fresh → **1300 ms cutoff never fires**; 8 s timer disarmed → capture hangs | `:2007-2017`, `:963` |
| Slow speaker, 1.3 s pauses (PTT hold) | Records until key release | **1300 ms barge-in cutoff applies to PTT too** → auto-stops mid-hold | `:2032-2039`, `:2271` |
| 60 s monologue | Bounded memory, streamed partials | 17 segments × ~768 KB base64 held in memory; **no partial streaming**; post-release latency = slowest segment | `:1955`, `:1853` |
| One of 3 segments fails (transient 5xx) | Retry that segment, keep the rest | **`Promise.all` rejects → entire turn discarded; 2 succeeded segments' credits wasted** | `:1853`, `:1916` |
| Bluetooth headphones, barge-in | No echo bleed | `cancelSpeechAudio` sync but `getUserMedia` async; **no dwell**; BT AEC fails on 200–400 ms loopback → assistant hears its own voice | `:1219`, `:1973` |
| Remote STT interim feedback | Live words | **Only `Listening… 47.3 s`** — no interim text for remote STT (browser STT shows words) | `:2030` |

**Ranked findings (C):**

| # | Finding | Severity | Evidence | Lens |
|---|---|---|---|---|
| C1 | VAD is a fixed `rms > 0.018` with no noise-floor adaptation | High | `useVoiceEngine.ts:2007` | correctness |
| C2 | 1300 ms silence cutoff applies to push-to-talk, not just barge-in | High | `:2035`, `:2271` | correctness/cognitive |
| C3 | 8 s no-speech timeout defeated by any ambient noise | Medium | `:963` | correctness |
| C4 | Single segment failure discards the whole turn + wastes credits | High | `:1853` (`Promise.all`) | correctness/scale |
| C5 | Credit-exhaustion auto-switch is silent, sticky, and **drops the current recording** | Medium | `:1922` | cognitive |
| C6 | No interim transcripts for remote STT — only a timer | High | `:2030` | latency/cognitive |
| C7 | `ScriptProcessorNode` runs VAD + encode + base64 on the main thread → UI stutters every rollover | Medium | `:1990` | latency/bloat |
| C8 | Hand-rolled WAV/PCM16 + base64 instead of opus/webm (~8× larger on the wire) | Medium | `voice.ts:158-198` | latency/bloat |
| C9 | 5 MB segment cap is dead code (18 s hard cap always fires first) | Low | `voice.ts:18`, `:2021` | bloat |
| C10 | `segmentIndex`/`segmentCount`/`recordingSessionId` sent but never used server-side | Low | `useVoiceEngine.ts:1836`; `stt.ts:382` | bloat |
| C11 | Whisper `prompt` is hardcoded jargon ("Codex, Mortic, Deepgram, Nova…") that biases transcription | Low-Med | `useVoiceEngine.ts:1835` | correctness |
| C12 | AudioContext leak on capture-setup error (never closed in catch) → bricks audio after ~6 failures | Medium | `:1988`, `:2068` | scale |
| C13 | Browser STT restart-on-end has a 100 ms capture gap + no error-state guard | Medium | `:2183` | correctness |
| C14 | Browser + remote STT are two parallel state machines (duplication, asymmetric UX) | Low-Med | `:2128` vs `:1948` | bloat |
| C15 | No echo guard for barge-in bleed window (mitigated only because live mode is disabled) | Medium | `:1219`, `:1974` | correctness |
| C16 | All VAD/segment constants are inline magic numbers | Low | `:2007,2035,2036,2023,967,2187` | bloat |

**Minimalist capture redesign (C):** `AudioWorkletNode` for VAD + downsample off-main-thread (C7); opus via `MediaRecorder`/WebCodecs, drop hand-rolled WAV + base64 (C8); **transcribe each segment at rollover time and stream partials back to the draft** (C6 — cuts post-release latency from ~3 s to ~1 s and gives live feedback); `Promise.allSettled` + per-segment retry (C4); rolling noise-floor or WebRTC-VAD WASM (C1); separate PTT hold from barge-in cutoff (C2); a 150–250 ms post-mute dwell before `getUserMedia` (C15); close AudioContext in a `finally` (C12). Cuts `voice.ts:158-198` and one of the two STT state machines (C14).

### 11.6 Surface D — TTS runtime, provider chain, fallback, audio lifecycle

**Fallback continuity matrix:**

| Scenario | What the user hears | Evidence |
|---|---|---|
| Deepgram WS fails **after** audio started | Abrupt stop mid-sentence; rest of reply **lost**; no voice switch | `tts.ts:824` (`disableFallbackAfterAudioStarted:true`) |
| ElevenLabs WS fails mid-turn | Voice A → **Voice B (Browser)** at next chunk; sentence continues in a different voice | `tts.ts:930` (flag **not set**) |
| Inworld WS fails mid-turn | Inworld → ElevenLabs WS (cold connect ~1 s dead air) → Browser; **up to two voice changes in one reply** | `useVoiceEngine.ts:402`; `tts.ts:939` |
| Any provider: one failure → `bypassCurrentTurn` stale | Nested provider **permanently skipped for the session** (its `beginTurn` is never called to reset the flag) | `tts.ts:836-851`, `:184`, `:468` |
| Queue grows unbounded (fast stream + slow TTS) | Audio lags arbitrarily behind displayed text; no coalesce/skip | `useVoiceEngine.ts:1351` |

**Ranked findings (D):**

| # | Finding | Severity | Evidence | Lens |
|---|---|---|---|---|
| D1 | `beginTurn`/`finishTurn` never propagate to nested fallbacks → permanent chain degradation after one failure | High | `tts.ts:836-851`, `:184`, `:468` | continuity/scale |
| D2 | Asymmetric mid-sentence voice switching (Deepgram hard-stops, EL/Inworld swap voice) | High | `tts.ts:925,930,939` | cognitive/continuity |
| D3 | Fallback into a non-prewarmed WS pays full connect latency mid-sentence (~600 ms–13 s) | High | `tts.ts:743`; `useVoiceEngine.ts:402` | latency |
| D4 | `speechPhase` lies "idle" while Browser TTS is still speaking (5 s estimate cap) → live mode could self-interrupt | Medium | `useVoiceEngine.ts:379`, `:2288` | cognitive/continuity |
| D5 | `cancelSpeechAudio` nukes all page `<audio>/<video>` incl. progress sound; leaves stale ref | Medium | `useVoiceEngine.ts:1088` | continuity |
| D6 | `onBufferUnderrun` only counts; no re-buffer/pad/gap-fill → audible clicks on long replies | Medium | `tts.ts:685`; `useVoiceEngine.ts:906` | continuity |
| D7 | HTTP ElevenLabs has audible inter-chunk gaps (fresh fetch per chunk, no overlap) | Medium | `tts.ts:161`, `:531` | latency |
| D8 | No queue backpressure; audio lags unbounded behind text | Medium | `useVoiceEngine.ts:1351` | scale |
| D9 | 30 s cooldown is coarse; no reconnect probe; no exponential backoff | Low | `tts.ts:7` | latency |
| D10 | No audio cue on voice switch; prewarm notice hardcodes "using Browser" regardless of actual fallback | Low | `useVoiceEngine.ts:372` | cognitive |
| D11 | Three near-duplicate server WS handlers (~400 LOC scaffolding) | Low | `tts.ts:258,456,693` | bloat |
| D12 | Quadruple speech bookkeeping (same as A12) | Low-Med | `useVoiceEngine.ts:215-219` | bloat |
| D13 | Browser TTS failure surfaces an empty error string | Low | `tts.ts:116` | cognitive |

**Minimalist TTS redesign (D):** one chain — Primary WS → **REST of the same provider** (same voice, no switch) → Browser (only at turn start). **Per-turn voice lock:** once a tier produces audio, pin it; later failure aborts with a visible "audio cut off" notice rather than a mid-sentence voice swap (D2). Propagate `beginTurn`/`finishTurn`/`cancel` to all tiers (D1, D3). Drive Browser phase off `onend`, not the 5 s estimate (D4). Cap queue depth at 6 and coalesce overflow (D8). Scoped cancel to TTS-owned media (D5). One `createWsSession(protocolAdapter)` on the server (D11). Net deletion ~600 server LOC + 2 client refs.

### 11.7 Surface E — Cognitive load, surface coherence, mental model

**Concept inventory (excerpt — full table in subagent report): ~26 concepts surfaced; 6 load-bearing.**

| Concept | Load-bearing? | Proposed treatment |
|---|---|---|
| thread / source / Finder | Yes (one concept, three names) | Collapse to "conversation"; rename Finder → "Recent threads" |
| scratch / fork | No (the *safety* is; the *words* aren't) | Auto: stop saying "scratch"; show the safety promise once |
| handoff / short / full | Yes | Keep; add "short = one line · full = detailed" |
| Hold M / PTT | Yes | Keep as the single input verb (stop the label cycling) |
| queue | No | Auto: system sequences; show "your message is next" as feedback |
| interrupt / barge-in | Yes (one intent, two paths) | One verb "Stop" + auto-arm listen |
| transcribing / listening | No | Fold into "Listening" |
| warming / prewarm / scratch ready / warm failed | No (optimization) | Auto: silent; never show as primary state or fatal error |
| canonical / delta / compile / fork tree / scaffold | No | Hide behind "Project archive" (advanced) |
| caveman | No | Rename "Short spoken replies" |
| live | No (dead) | Remove toggle |
| transport / STT / TTS / reasoning | No | Auto-select; surface only on failure |

**State inventory: 17+ labels → 5 + 2 off-states.**
1. **Pick a thread** · 2. **Ready** · 3. **Listening** · 4. **Thinking** · 5. **Speaking** — off: **Codex offline** · **Something went wrong** (real errors only, never prewarm).

**The single biggest cognition defect:** the mic button has **6 labels** (`dockTalkLabel`) with two sibling computations (9 + 7 strings) — the same gesture means "talk now" or "queue for later" depending on a hidden `pending` flag. **Fix:** persistent "Hold to talk" + a "Queued — sending next" badge on the transcript. Queueing still happens; the user stops predicting it.

**The single unification that unlocks most of this:** `agentState` (orb, `App.tsx:1215-1235`) and `desktopHudStatus` (HUD, `App.tsx:1872-1882`) compute the *same* truth with *different* logic. The HUD is honest (checks thread + Codex); the orb is not → it shows "READY" when blocked. **Making the orb reuse the HUD's truth function** fixes the false reassurance and establishes one status vocabulary across both surfaces — the precondition for the overlay feeling like a focused subset, not a different product.

**Ranked findings (E):**

| # | Finding | Severity | Evidence | Lens |
|---|---|---|---|---|
| E1 | Orb shows "READY" when blocked (no thread / Codex offline); HUD is honest, orb is not | Critical | `App.tsx:2337`, `:1215-1235` vs `:1872-1882` | cognitive |
| E2 | Mic button has 6+ labels + 2 sibling computations; same gesture, varying meaning | High | `App.tsx:1688-1697`, `:1635`, `:1676` | cognitive |
| E3 | ~26 concepts / 17+ states; only 6 / 5 load-bearing | High | (inventory above) | cognitive |
| E4 | "Queue" surfaced as a verb the user must predict | High | `App.tsx:1641`, `:1694` | cognitive |
| E5 | Handoff close: no copy feedback + no "open Codex" (pattern already exists in ChartModal) | High | `App.tsx:1478-1491`; `ChartModal.tsx:276` | cognitive |
| E6 | First-time overlay user gets zero onboarding | High | `App.tsx:1923-2154` (none) | cognitive |
| E7 | Prewarm shown as a primary state + a fatal error | Medium | `App.tsx:1648-1653`, `:1216` | cognitive |
| E8 | Config is 8 flat dimensions; only 2 loop-relevant; default access = "approve" not "ask" | Medium | `App.tsx:2189-2325`, `:351` | cognitive |
| E9 | Transcript shows 1 turn; full app adds 2 internal-trace widgets as primary UI | Medium | `App.tsx:2052`, `:2384` | cognitive |
| E10 | "Interrupt" + "barge-in" are two paths to one intent, and one is illusory (compounds B1) | High | `App.tsx:1968`; `useVoiceEngine.ts:1800` | cognitive |
| E11 | Thread picker is 2 actions + mislabeled "Finder" | Medium | `ThreadPicker.tsx:71,113,114` | cognitive |

**Minimal honest interaction model (E): 6 concepts / 5 states / 4 actions** to complete the core loop (down from ~26 / 17+ / ~8) — pick a conversation → hold to talk → read the answer (last 3 turns) → **Copy & open Codex** (one button; human still reviews + pastes). Nothing removed: queue/interrupt/prewarm/project-memory/full-config all still work; they're auto-handled or behind Advanced/Project archive.

### 11.8 Surface F — Scale, architecture & bloat (minimalist/simpler)

**Measured counts** (from the tree at `82a1f62`): `src/` = **30,838 LOC / 626 files**.

**Scale risk register (top):**

| # | Risk | Evidence | Breaks at | Severity |
|---|---|---|---|---|
| S1 | Single in-memory session + single `activeTurn` | `storage.ts:96`; `app.ts:99` | 2 concurrent writers | High |
| S2 | **Stale `activeTurn` locks the whole app with 409s forever — no reaper** | `app.ts:1465` | One crash mid-turn | **High** |
| S3 | `turnReplay` Map unbounded, no TTL | `app.ts:678` | Long session / crash | High |
| S4 | `turnStreams` SSE listener Set, no max, no backpressure | `app.ts:677,713` | Many reconnects / slow client | Medium |
| S7 | Filesystem project store: no cross-process lock; RMW on chart | `projectStorage.ts:498` | Desktop + CLI together | Medium |
| S8 | **`appServerBridge` global op lock — one compaction (15 min) stalls all turns** | `appServerBridge.ts:557` | A compaction | **High** |

**Bloat inventory (measured):**

| Item | LOC / files | Load-bearing? | Decision |
|---|---|---|---|
| **`codexAppServerProtocol/`** | **557 files / 5,810 LOC, zero references** (`index.ts:1` "GENERATED CODE") | No | **CUT** — 19% of src LOC, biggest zero-risk win |
| Canonical subsystem (`projectStorage.ts` + subdir + `canonicalStateSkill.ts` + skill scripts) | ~5,681 LOC | Partial — 5 of 11 routes orphaned | **GATE** `MORTIC_CANONICAL=1` |
| `sparkContext.ts` (dormant: `needsModelTransitionPreflight` always `false`) | 481 LOC | No (default) | **GATE** or delete |
| `cliPtyBridge.ts` (CLI PTY fallback, discouraged) | 892 LOC | Fallback only | **GATE** (already nearly) |
| `design-mocks/` | 6 files / 1,373 LOC | No | **MOVE** to `docs/` or delete |
| Orphaned routes | 11 of 42 (26%) | — | CUT/GATE (see §4 table) |
| `livekit-server-sdk` hard dep | 1 dep | Only if `LIVEKIT_*` env | **optionalDependencies** |
| Duplicate TTS WS handlers | ~400 LOC scaffolding | Yes | Consolidate (D11) |

**Orphaned routes (11/42):** `/api/project/coverage/latest`, `/api/project/draft-compilations/import`, `/api/project/compilations/:id/approve`, `/api/project/checkpoint/{confirm,dismiss,manual}`, **`/api/turn/:turnId/interrupt`** (client interrupts locally — compounds B1), and 3 redundant status routes (`/api/stt`, `/api/tts`, `/api/livekit/status` — all already in `/api/session`).

**Minimal core vs optional advanced (F):**
- **Minimal core server (~6,000 LOC vs current ~13,070):** health, onboarding, session, source, clear, prewarm, turn (+stream +audio-health), stt/transcribe, one TTS provider (ws/stream/health), handoff, provider threads. The voice loop, intact.
- **Flagged advanced (~7,050 LOC out of the default path):** `MORTIC_CANONICAL=1`, `MORTIC_SPARK_PREFLIGHT=1`, `MORTIC_CLI_FALLBACK=1`, `MORTIC_LIVEKIT=1` (env), `MORTIC_MULTI_TTS=1`.
- **Delete outright (~7,200 LOC / 563 files):** the 557-file protocol dir, 6 design-mocks, 4 orphaned + 3 redundant routes.
- **~54% server-LOC reduction** in the default shipped surface, voice loop unchanged.

**Three small scale fixes that remove all "lock the whole app" modes:** S2 reaper (~20 LOC: clear `activeTurn` if `updatedAt` > 5 min stale); S3 fold `replayText` into persisted `activeTurn` and delete the Map (~−30 LOC); S8 split the bridge into `compactionQueue` + `turnQueue` (~30 LOC).

### 11.9 Top 15 cross-cutting fixes (ranked across all six passes)

| # | Fix | Surfaces | Severity | Effort |
|---|---|---|---|---|
| 1 | Wire Interrupt + barge-in to `/api/turn/:id/interrupt`; show "Stopping…" until `interrupted` | B, §10 | Critical | S |
| 2 | On streaming divergence/repair, reset ledger + cancel TTS + re-queue; optionally cue "Actually—" | A | Critical | S |
| 3 | Make the orb reuse the HUD's truth function (no more "READY" when blocked) | E | Critical | S |
| 4 | First-chunk fires at first clause ≥8 chars; stream the first Deepgram chunk (or WS for chunk #1) | A | High | M |
| 5 | Propagate `beginTurn`/`finishTurn`/`cancel` to nested TTS fallbacks (one-line ×3) | D | High | S |
| 6 | Add a reaper for stale `activeTurn` + split the bridge op lock | F, B | High | S |
| 7 | `Promise.allSettled` + per-segment retry for STT; stream partials at rollover | C | High | M |
| 8 | Persistent "Hold to talk" mic label + "Queued — sending next" badge | E | High | S |
| 9 | "Copy & open Codex" + "Copied ✓" feedback on handoff | E | High | S |
| 10 | Wrap `emitTurnEvent` in try/catch; fold `turnReplay` into persisted `activeTurn` | A, F | High | S |
| 11 | Add a `catch` to `pollTurn`; on reattach, display-only (never re-speak) replay | B | High | S |
| 12 | Per-turn voice lock; unify the mid-sentence fallback policy + add a cue | D | High | M |
| 13 | Separate PTT hold from barge-in cutoff; rolling noise-floor VAD | C | High | M |
| 14 | Delete `codexAppServerProtocol/` (557 files) + gate canonical/spark/CLI-fallback | F | High (bloat) | M |
| 15 | One status vocabulary + first-run overlay hint + 3-turn transcript | E | High | S |

### 11.10 The minimalist target (synthesis)

Across all six passes, the same shape emerges. The product today is a strong voice *plumbing* layer inside a heavy, over-labeled, partly-dishonest shell. The 80→95 move is **collapse, not add**:

1. **One honest control semantics.** Stop = stop the model (server interrupt). Hold to talk = always capture; queueing is the system's problem, shown as feedback. One "Stop" verb, one "Hold to talk" verb.
2. **One truth function.** Orb = HUD logic. 5 states. No "READY" when blocked, no "Warm failed" as a fatal error.
3. **One streaming path.** Server emits speak-text deltas; client stops parsing JSON. First-chunk at first clause, streamed. Warm AudioContext. One `applyTurnEvent` reducer. One `speechLedger`.
4. **One TTS chain with per-turn voice lock.** Primary WS → same-provider REST → Browser (turn-start only). Propagate lifecycle. No mid-sentence voice swaps.
5. **One capture path.** AudioWorklet + opus + streamed partials + per-segment retry. VAD with a noise floor. PTT holds until key-up.
6. **Minimal core + flagged advanced.** ~6,000-LOC server for the voice loop; canonical/spark/CLI-fallback/LiveKit/multi-TTS behind flags; 557-file protocol dir deleted.

Net effect: first-audio ~900–2700 ms → ~450–1100 ms; ~26 concepts → 6; 17+ states → 5+2; ~54% smaller default server; and the three "lock the whole app" failure modes (stale turn, global op lock, replay leak) gone — all with **zero loss of function** (queue, interrupt, prewarm, project memory, full config, multi-provider all still exist; they're auto-handled or behind Advanced).

### 11.11 Subagent contributions

- **A — Streaming & latency:** 15 findings + latency budget table + minimalist streaming redesign. Headline: A4 (silent misinformation on repair) is the only critical item; A1+A2 are the biggest latency levers (~300–600 ms).
- **B — Turn lifecycle:** control-honesty audit + 8 findings. Headline: B1 (interrupt lie), B2 (pollTurn wedge), B3 (phantom re-speak). Also surfaced the abandoned `interruptResumeAction` scaffolding (B6).
- **C — STT/VAD:** VAD edge matrix + 16 findings + AudioWorklet/opus/streaming-partials redesign. Headline: C4 (one segment fails → whole turn lost), C2 (PTT cut off mid-hold), C6 (no interim feedback for remote STT).
- **D — TTS runtime:** fallback continuity matrix + 13 findings + per-turn-voice-lock redesign. Headline: D1 (permanent chain degradation — `beginTurn` doesn't propagate), D2 (asymmetric mid-sentence voice switch).
- **E — Cognitive load:** concept/state inventories + minimal honest model (6/5/4) + false-reassurance map. Headline: E1 (orb lies "READY"), E2 (mic label cycling), the orb=HUD unification.
- **F — Scale & bloat:** quantitative inventory (557-file/5,810-LOC dead protocol dir; ~5,681-LOC canonical subsystem; 11/42 orphaned routes) + scale risk register + minimal-core split. Headline: S2 (stale turn locks app), the 19%-of-src-LOC dead generated cargo.

All evidence is `file:line` anchored in the current working tree. The six subagent reports are synthesized here; their full detail (per-finding fixes, edge matrices, redesign code shapes) is captured in this section.

---

## 12. GLM 5.2 Review — Competitive Landscape & Persisted-Fork Design Plan

**Review label:** GLM 5.2 Review (Competitive + Architecture Plan)
**Date:** 2026-06-20
**Trigger:** user discovered OpenClaw (voice/talk mode + Codex app-server harness) and opencode (app-server) — both overlap Mortic's niche. This section records the competitive analysis, the product intent, the design options, and the probe plan. No code was changed for this section; probes are live/read-only against real Codex/opencode binaries.

### 12.1 Competitive landscape — who can replace Mortic

| Tier | Product | Replaces? | Notes |
|---|---|---|---|
| 1 | **OpenClaw** | Voice+Codex axis: yes; fork-safety axis: no | Self-hosted, MIT, bundled Codex plugin (managed `@openai/codex` 0.139.0), stdio or WebSocket transport, guardian/YOLO modes. Voice via mobile/macOS node PTT (`talk.ptt.*`) or realtime voice (Gemini Live / OpenAI Realtime). |
| 1 | Codex CLI + DIY voice front-end | Partial | Build-your-own Mortic minus the fork model. |
| 2 | Superwhisper / Whispering / Talon | Voice-input half only | STT→text into any editor/CLI; no agent, no streaming reply, no handoff. |
| 3 | Cursor (voice mode) | Different shape | Cloud editor agent; not Codex-native, not local-sidecar. |
| 3 | Windsurf / Cline / Continue / Aider / Claude Code | No native voice | Would pair with a Tier 2 tool. |
| 4 | ChatGPT/Claude voice / LiveKit Agents / Vapi / Retell | General voice agents | Not coding-agent-native. |

**OpenClaw is the one credible overlap.** The wedge Mortic owns that OpenClaw does not: **fork safety** — talk to a context-carrying *copy* of your Codex thread without polluting the source, then hand back a clean prompt. OpenClaw runs its own agent in its own scoped `CODEX_HOME`; it does not fork your personal threads.

### 12.2 How OpenClaw relates to your Codex thread (verified from docs)

- **Not a fork; not your thread.** OpenClaw sets `CODEX_HOME` to a per-agent scoped dir so *"native thread state does not read or write the operator's personal `~/.codex`."* `/codex resume <id>` only sees threads in OpenClaw's home. Your personal `codex` CLI can't see OpenClaw's threads.
- **Mirror, not fork.** One thread exists (canonical, Codex-owned); OpenClaw keeps a read-only reflection. *"Editable Codex-native transcript history"* is **not supported in v1.** OpenClaw's mirror reflects a thread it *writes to directly*; it is a connectivity primitive, not a safety primitive.
- **Escape hatch (advanced, rarely configured):** `appServer.transport: "websocket"` → your personal app-server. Then OpenClaw writes to your canonical thread directly. But: one active turn per thread (409), no parallel with your CLI, no safety. Not the quickstart path.
- **No fork operation found.** `/codex` command surface: `bind`/`resume`/`threads`/`compact`/`review`/`diagnostics`. No `/codex fork`. "Fork → work → archive → paste handoff = basically the Mortic flow" is the Mortic flow *in concept*, but OpenClaw makes you reconstruct it manually and can't give you the context-carrying fork.

### 12.3 OpenClaw voice pipeline — two modes (verified from docs)

| Mode | Architecture | Talks to Codex directly? |
|---|---|---|
| **Realtime** (Gemini Live / OpenAI Realtime) | Native full-duplex audio model; audio in → audio out; native barge-in/turn-taking. Calls `openclaw_agent_consult` tool to reach Codex for tool work. | **No** — you talk to a realtime model that consults Codex. |
| **Native STT/TTS** (Talk mode, macOS/iOS/Android) | STT → agent text → TTS. `{"spoken":"..."}` spoken-output contract (extracted post-hoc, defensive JSON parse + plain-text fallback). Voice directives `{"voice":"...","once":true}`. `interruptOnSpeech: true`. | **Yes** (bound thread). |

**Mortic's voice-output pipeline is more purpose-built** for "speak a streaming model response well": streaming JSONL `speak`+`read` parsed mid-stream (`partialSpokenText`), per-provider `chooseSpeakableEnd` chunking (16/90/220 chars), monotonic speech ledger (prevents replay/skip/overlap), per-chunk fallback, progress speech with dedup/cap, full audio-health timing budget. OpenClaw's STT/TTS mode is lighter (`spoken` field extraction, no ledger, no per-provider chunking). **OpenClaw's realtime mode sidesteps the problem entirely** by using a native audio model — at the cost of not being the Codex agent directly.

### 12.4 Product intent (this pass)

**Primary goal (non-negotiable):**
1. Scratches do **not** show up in the user's `codex` CLI thread list (invisible to CLI — strong preference).
2. Scratches are **not ephemeral** — they survive Mortic/app-server restart (persisted, resumable through Mortic).
3. Mortic logs scratch sessions per source thread; the app shows a resumable history.

**Divergence UX:**
- Show "N messages behind" (0 = fresh). At N>0, prompt: **Refresh / Retain / Skip / Auto**.
- Capture last 2 source messages at fork time (record; display TBD).
- Floor if confusing: one persisted scratch per source + Refresh-in-place, no history list.

**Approval-gated direct-send to canonical (from earlier discussion):** feasible, deferred to a later pass. Not a requirement this pass.

### 12.5 Design options

| | Design 1 (scoped + path-fork) | Design 2 (scoped + copy-then-fork) | Design 3 (shared + inject replay) |
|---|---|---|---|
| Home | `~/.mortic/codex-home/` (scoped) | `~/.mortic/codex-home/` (scoped) | `~/.codex` (shared) |
| Auth | Symlink `auth.json` (probe-gated) | Symlink `auth.json` (probe-gated) | Shared (no issue) |
| Fork mechanism | `thread/fork({ path: "~/.codex/sessions/<file>", ephemeral: false })` cross-home | Copy source file into scoped home + fork by thread_id | Ephemeral fork + `thread/inject_items` to replay |
| Invisible to CLI | Yes | Yes | Yes (ephemeral) |
| Resumable through Mortic | Yes (persisted fork) | Yes (persisted fork) | Yes (replay into fresh fork) |
| Fidelity | Full (true persisted fork) | Full | Lossy (fork carries *current* source context, not baseline) |
| Live-probe uncertainty | `path` cross-home accept | app-server accepts out-of-band file | `inject_items` replay fidelity |
| opencode portability | Needs separate-instance isolation | Needs copy equiv | Fork-at-message is *better* on opencode; replay = re-send messages |
| Storage-only fallback | N/A | N/A | Clean degrade (browsable, not resumable-as-if-continuous) |

**Preferred: Design 1** if Probes 1+2 pass. Design 3 is the fallback only if scoped-home auth fails.

### 12.6 Probe plan (read-only, no app changes)

| # | Probe | Gates | Pass criteria |
|---|---|---|---|
| 1 | Symlinked `auth.json` across scoped home | Design 1/2 (scoped home viability) | Turn completes in scoped-home app-server + token refresh writes back correctly |
| 2 | `thread/fork({ path: "<abs path in ~/.codex/sessions>", ephemeral: false })` cross-home | Design 1 | Fork returns new thread_id in scoped home with source context; `thread/read` works after app-server restart |
| 3 | Copy source session file into scoped home + fork by thread_id | Design 2 (only if Probe 2 fails) | Fork loads the copied file |
| 4 | opencode fork surface + isolation | Portability check (near-term goal) | `POST /session/:id/fork` with `{ messageID? }`; separate `opencode serve` instance = separate session store (invisible to primary TUI) |
| 5 | `thread/inject_items` replay fidelity | Design 3 (only if scoped home fails) | Model treats injected raw items as real prior history |

**If Probe 1 fails:** scoped home is dead. User's instruction: report, no fallback build this pass. Revisit auth later.

### 12.7 Protocol surfaces verified (from `src/server/codexAppServerProtocol/`)

- `thread/fork` (`ThreadForkParams`): `{ threadId, path?, model?, ..., ephemeral?, ... }`. Doc says `path` loads by absolute path; typed surface omits `path` (ts-rs codegen gap — current code passes `path: null` via `params: any` at `appServerBridge.ts:1405`). **Needs live confirmation (Probe 2).**
- `thread/resume` (`ThreadResumeParams`): `{ threadId, model?, ..., config? }`. Doc says "by history" but no `history` field in typed params — possible codegen gap. **Needs live confirmation if Design 3 replay is needed.**
- `thread/read` (`ThreadReadParams`): `{ threadId, includeTurns? }` → `Thread` with `updatedAt` (unix seconds), `status` (`notLoaded` | `idle` | `systemError` | `active`), `turns[]`. **The divergence-check primitive; works today, no app-server changes.**
- `thread/inject_items` (`ThreadInjectItemsParams`): `{ threadId, items: Array<JsonValue> }` — "append raw Responses API items to the thread's model-visible history." **Design 3 replay primitive.**
- `Thread.ephemeral`: *"should not be materialized on disk"* — today's `ephemeral: true` is why scratches are invisible to your CLI. Flipping to `ephemeral: false` in a scoped home is the Design 1/2 mechanism.

### 12.8 opencode surface (verified from docs)

opencode HTTP server (`opencode serve`, default port 4096) exposes:
- `POST /session/:id/fork` body `{ messageID? }` → `Session` — **fork at a specific message** (more capable than Codex's `thread/fork`, which has no message-point param).
- `POST /session/:id/message` body `{ parts, model?, ... }` — send a message (no silent history-injection equivalent; replay = re-send).
- `GET /session` → `Session[]` (session list per server instance).
- No `CODEX_HOME` concept — isolation = separate `opencode serve` instance (different port/config) → separate session store. Likely invisible to the user's primary opencode TUI by default (separate server).

**Portability read:** Design 1's *shape* (separate-instance isolation + persisted fork + resume) ports to opencode cleanly; the *primitives* differ (fork-at-message is better; no `inject_items` equivalent). Design 3's replay is less clean on opencode (re-send messages vs silent injection). opencode is a near-term goal but does not constrain the Codex design this pass — port after Codex path is settled.

### 12.9 Open trade-off questions (user's answers recorded)

| # | Question | User's answer |
|---|---|---|
| 1 | Approval-gated direct-send still in scope? | Yes, but later pass. Not a requirement this pass. |
| 2 | Design 3 as fallback or complement? | If Design 1 or 2 works, no need for 3. |
| 3 | Scoped home location? | `~/.mortic/codex-home/` (under Mortic namespace). |
| 4 | Re-fork archiving — keep old persisted scratches for resume? | Yes, want to resume. |
| 5 | Scoped `config.toml` — minimal or copy-and-strip? | Whatever is more elegant (lean toward minimal). |
| 6 | opencode priority? | Near-term goal (probe now, doesn't constrain Codex design this pass). |

**Remaining open (deferred to execution pass):**
- "Auto" button semantics: always-auto-refresh vs remember-last-choice.
- "Skip / do it later" semantics: per-event vs per-session vs until-manual.
- Last-2-messages-at-fork: when to display (record now, decide display later).
- Archived scratches retention cap: unbounded vs cap-and-prune.
- Simplest-fallback trigger: "more than two states = drop to fallback" vs decide-after-prototype.

### 12.10 Probe results

**Environment:** codex-cli 0.142.0-alpha.1, opencode 1.17.8, macOS. Probes ran live against real Codex/opencode binaries. No Mortic code changed. The user's real `~/.codex/auth.json` was never modified — the refresh test used a copy.

#### Probe 1 — symlinked auth across scoped home: **PASS**

Setup: `~/.mortic/codex-home/` with `auth.json` → symlink `~/.codex/auth.json`, minimal `config.toml` (model + reasoning effort, no `CODEX_HOME` line), skills copied.

- **1a (read):** `CODEX_HOME=~/.mortic/codex-home codex exec "reply with exactly: pong"` → responded "pong". Auth read via symlink works.
- **1b (refresh write-back):** Copied auth.json, corrupted `access_token` in the copy, re-symlinked to the copy, ran `codex exec`. Codex got 401, refreshed via `refresh_token`, wrote new tokens back **through the symlink** (copy mtime advanced, `access_token` became a valid JWT again), turn succeeded ("refreshed"). Real `~/.codex/auth.json` untouched.
- **Scoped session isolation:** the 1a session was written to `~/.mortic/codex-home/sessions/2026/06/20/rollout-...jsonl` — NOT to `~/.codex/sessions/`.
- **CLI invisibility:** the scoped session ID (`019ee3f1-...`) is absent from `~/.codex/session_index.jsonl`.

**Conclusion: scoped home + symlinked auth is viable.** No separate OpenAI login needed. Design 1/2 cleared.

#### Probe 2 — cross-home path-fork + persistence: **PASS**

From a scoped-home app-server (`CODEX_HOME=~/.mortic/codex-home codex app-server --listen ws://127.0.0.1:6190`), called `thread/fork` against a real personal thread:

```json
{ "threadId": "019ee35a-e7ee-7742-bfd9-0e82fb4c65e5",
  "path": "~/.codex/sessions/2026/06/20/rollout-...-019ee35a-....jsonl",
  "model": "gpt-5.5", "ephemeral": false }
```

- **2a (fork):** returned new `thread.id: 019ee3f8-312a-7093-949b-a71daa39327d`, `thread.ephemeral: false`, `thread.forkedFromId: 019ee35a-...` (the source). Cross-home path-fork works; the typed `ThreadForkParams` omits `path` (ts-rs codegen gap) but the runtime accepts it — current Mortic code already passes `path: null` via `params: any` at `appServerBridge.ts:1405`.
- **2b (persistence across restart):** killed the app-server, started a **fresh** process, `thread/read({ threadId: fork, includeTurns: true })` → returned the fork with `turns.length: 111`, `ephemeral: false`, `forkedFromId` = source, `status: { type: "notLoaded" }` (loadable, not yet active). **The persisted fork survived the restart.**
- **On-disk:** fork written to `~/.mortic/codex-home/sessions/2026/06/20/rollout-...-019ee3f8-....jsonl`.
- **CLI invisibility:** fork ID absent from `~/.codex/session_index.jsonl`.
- **2c (turn on persisted fork):** `turn/start` failed with `"Invalid request: missing field 'type'"` — a `sandboxPolicy` shape bug in the probe script, not a persistence finding. `thread/read` already proved the fork is fully loaded and resumable; Mortic's bridge has the correct `sandboxPolicy` shape (`scratchTurnSandboxPolicy`).

**Conclusion: Design 1 (scoped home + path-fork + ephemeral:false) is the path.** Cross-home fork, persisted, restart-surviving, CLI-invisible, source-context-carrying — all confirmed. Probes 3 and 5 not needed.

#### Probe 4 — opencode fork + isolation: **PARTIAL (portability concern)**

opencode 1.17.8, `opencode serve --port 4097` in a temp project.

- **Fork-at-message works:** `POST /session/:id/fork` body `{ messageID }` → new session `ses_...` titled `"probe (fork #1)"`. opencode's fork is **more capable** than Codex's (fork at a specific message, not just thread-level).
- **Fork history:** the forked session has 0 messages in its own list — opencode forks create a branch point, not a history copy. Context is implicit via parent linkage (though `parentID` came back `None` in the probe — may need further investigation). This differs from Codex's `thread/fork` which copies turns.
- **Isolation: FAILS.** opencode stores sessions in a **shared global db** (`~/.local/share/opencode/opencode.db`, confirmed via sqlite — both probe sessions appeared in the `session` table). A separate `opencode serve` instance does **NOT** isolate sessions — Mortic-created forks would be **visible in the user's primary opencode TUI session list**.

**Portability implication:** Design 1's isolation approach (separate `CODEX_HOME`) does not map to opencode. opencode has no per-home concept; sessions are global. Options for the opencode path (future pass): (a) accept visibility + use naming markers `[mortic]`, (b) find an opencode storage-override option (not found in docs this pass), (c) accept that opencode scratches are visible and lean on the fork-at-message + naming convention. This does not block the Codex path this pass.

#### Probes 3 and 5 — not run

Probe 3 (copy-then-fork) was the fallback for Design 2 only if Probe 2 failed. Probe 2 passed, so Design 2 is unnecessary. Probe 5 (`thread/inject_items` replay fidelity) was only needed for Design 3 (fallback if scoped-home auth failed). Probe 1 passed, so Design 3 is unnecessary. Both deferred unless a future need arises.

#### Cleanup

- Probe test sessions removed from `~/.mortic/codex-home/sessions/`.
- Probe sessions deleted from opencode global db via `DELETE /session/:id` (confirmed 0 remaining).
- opencode probe server killed.
- `~/.codex/auth.json` verified intact (unmodified throughout).
- `~/.mortic/codex-home/` left in place (clean: auth symlink → `~/.codex/auth.json`, minimal config.toml, skills copied) — ready for the implementation pass.
- Temp probe scripts and logs removed.

### 12.11 Design decision (confirmed by probes)

**Design 1 is the path for the Codex implementation pass:**

1. Scoped home `~/.mortic/codex-home/` with symlinked `auth.json` (Probe 1 ✓).
2. `thread/fork({ threadId, path: "<~/.codex session file>", ephemeral: false })` from the scoped app-server (Probe 2 ✓).
3. Persisted forks survive restart, are CLI-invisible, and carry source context (Probe 2 ✓).
4. Divergence check via `thread/read({ threadId: source, includeTurns: true })` comparing `updatedAt`/`turns.length` to baseline (protocol confirmed, no app-server changes needed).
5. Resume via `thread/resume({ threadId: <persisted-fork> })` in the scoped home.
6. opencode portability is a follow-up pass (isolation needs a different mechanism — naming marker or storage override).

**No fallback build needed this pass** (per user instruction — if probes had failed, report and stop; no shared-home fallback to build).

### 12.12 File-by-file change surface (for execution pass, not this pass)

| File | Change |
|---|---|
| `src/server/appServerBridge.ts:1072` | Add `CODEX_HOME=~/.mortic/codex-home` to spawn env |
| `src/server/appServerBridge.ts:1385-1449` | `ephemeral: false`, `path` → source session file, flip the ephemeral guard at `:1431-1432` |
| `src/server/appServerBridge.ts` (new method) | `readSourceThread(threadId)` for divergence check + last-2-messages capture |
| `src/server/forkHandlers.ts` (new) | Fork handler registry: `~/.mortic/fork-handlers/<source>.json` |
| `src/server/app.ts` (new routes) | `GET /api/session/divergence`, `POST /api/session/refork`, `POST /api/session/resume-scratch/:id`, `GET /api/session/scratches` |
| `src/client/App.tsx` | Divergence badge + prompt UI + history view |
| `src/client/components/ScratchHistoryPanel.tsx` (new) | History list + resume action |
| `src/client/components/DivergencePrompt.tsx` (new) | Refresh/Retain/Skip/Auto prompt |
| `~/.mortic/codex-home/` (runtime, one-time) | Scoped home setup on first run/prewarm |

### 12.13 Sources

- OpenClaw docs: `docs.openclaw.ai/` (overview, features, nodes, agent, agent-runtimes, experimental-features, codex-harness, codex-harness-reference, codex-harness-runtime, streaming, voice-call plugin, talk mode).
- opencode docs: `opencode.ai/docs/server/` (HTTP API surface).
- Mortic source: `src/server/appServerBridge.ts`, `src/server/codex.ts`, `src/server/app.ts`, `src/server/storage.ts`, `src/server/codexAppServerProtocol/` (generated protocol types).

---

## 13. PRD: Persisted CLI-Invisible Scratch Forks + Divergence UX + Send to Main Thread

**Review label:** GLM 5.2 Review (PRD + Adversarial Implementation Plan)
**Date:** 2026-06-21
**Method:** PRD refined from user direction; implementation plan adversarially vetted by 4 parallel subagents (Phase 1 edges, Phase 2 edges, storage/abstraction, UX minimality). All findings synthesized below with `file:line` evidence. No code changed in this pass — this is the plan.

### 13.1 Overview

Make Mortic's scratch forks **persisted** (survive restart), **CLI-invisible** (don't clutter `codex threads`), and **resumable** through Mortic — with a live divergence indicator, manual sync, scratch history, an expandable source-when-forked bubble, and a **repo divergence indicator** ("+32,-11 from main repo state"). Phase 2 adds approval-gated **Send to Main Thread (Codex)** with delta handoffs, a handoff confirmation bubble (sent ✓ / responded ✓ only — no response content), and diff reporting on handoff send.

### 13.2 Goals & non-goals

**Goals — Phase 1:**
- Scratches persisted in scoped `~/.mortic/codex-home/`, invisible to `codex` CLI.
- Survive restart; resumable through Mortic.
- Live divergence counter ("fresh" / "N behind"), polled every 3s.
- **Repo divergence indicator** — "+32,-11" diff summary from fork-time repo state, alongside message staleness (in the divergence pill's tooltip).
- Manual Sync (click the stale pill → "Keep / Catch up" confirm).
- Scratch history (browsable + resumable) via transcript-header dropdown.
- Expandable "source when forked" bubble (last 2 source messages, drawer-only, collapsed).
- Scoped home setup as onboarding step (first run).
- One Codex login shared across CLI + Mortic via symlinked auth.

**Goals — Phase 2:**
- Send to Main Thread (Codex) — approval-gated direct-send. Modular terminology: "Main Thread" + "(Codex)" provider variable.
- Handoff confirmation: pill flips to "sent ✓" → "responded ✓". **No response content, no expandable response.** User continues work as usual.
- Diff reporting on handoff send — the diff the scratch introduced, in the "sent ✓" pill's tooltip.
- Delta handoffs (non-repetitive carry-forward, "what's new since H1").
- Handoff generation on ephemeral fork-of-scratch (not fork-of-source).

**Non-goals (this PRD):**
- opencode portability (separate probe — export+move idea; shared global db is the blocker).
- Auto-refresh (removed — would be destructive to user intent if they haven't handed off yet; revisit after Phase 2's handoff logging exists).
- Realtime voice mode (OpenClaw's native audio; different architecture).
- Showing the Main Thread's response content in the scratch (user explicitly rejected — the scratch is stale, can't speak a response it didn't generate).

### 13.3 User stories

- *As a user, I want my voice conversations to survive a Mortic restart so I can resume them tomorrow.*
- *As a user, I want my scratch forks to not clutter my `codex threads` list.*
- *As a user, I want to log in to Codex once — not separately for the CLI and for Mortic's scoped home.*
- *As a user, I want to see if my Main Thread has moved on since I forked, so I know if my scratch is stale — both messages and repo state.*
- *As a user, I want one click to catch up from the latest Main Thread, so I don't have to think about staleness.*
- *As a user, I want to browse and resume old voice conversations per source thread.*
- *As a user, I want to see what the Main Thread looked like when I forked, so I have context for an old scratch.*
- *(Phase 2) As a user, I want to send my handoff directly to my Main Thread (Codex) after reviewing it, instead of copy-pasting.*
- *(Phase 2) As a user, I want to see that my handoff was sent and that the Main Thread responded — without leaving my scratch or seeing the response content.*
- *(Phase 2) As a user, I want subsequent handoffs from the same scratch to not repeat what I already sent.*

### 13.4 Phase 1 — Persisted forks + divergence + history

#### 13.4.1 Persisted CLI-invisible forks (Probe-confirmed Design 1)
- Scoped home `~/.mortic/codex-home/` with `auth.json` → symlink `~/.codex/auth.json` (Probe 1 ✓).
- `thread/fork({ threadId: source, path: "<~/.codex session file>", ephemeral: false })` from scoped app-server (Probe 2 ✓).
- Survives restart; `thread/resume({ threadId: <persisted-fork> })` to resume.
- **Critical (subagent finding 0.1):** set `CODEX_HOME` **only in the spawned child env** at `appServerBridge.ts:1072`. **Never** mutate `process.env.CODEX_HOME` — four modules read it (`providerAdapters.ts:103,107`, `skillSync.ts:83`, `sparkContext.ts:184`, `runtimeContext.ts:61`) and would break (source listing, skills, spark preflight, runtime context).

#### 13.4.2 Divergence detection (message + repo staleness)
- **Message staleness:** poll every 3s. **Primary path: Mortic-side JSONL tail-parse** of the source session file (subagent finding Q6 — cheaper, app-server-independent). `thread/read` is the fallback if JSONL is unreadable.
- **Repo staleness:** `git diff --numstat <baselineSha>..HEAD` shell-out (subagent finding 0.4 — `gitDiffToRemote` has wrong semantics; it diffs against origin, not fork-time baseline). Throttle to every 3rd poll or on `messagesBehind` advance.
- **Baseline capture at fork:** `repoShaAtFork = response.thread.gitInfo?.sha` (`Thread.ts:79`); `sourceUpdatedAtAtFork`, `sourceTurnCountAtFork` from the fork response.
- **UX:** one divergence pill (see §13.7).

#### 13.4.3 Manual Sync (click stale pill)
- Click the stale divergence pill → inline 2-choice confirm: "Catch up from <thread>? · Keep / Catch up."
- `POST /api/session/refork`: archive current scratch (set-aside in registry, **not** `thread/archive` — see finding 0.6), fork from current source, reset baselines.
- **No auto-refresh** (removed).

#### 13.4.4 Scratch history + resume
- Fork handler registry at `~/.mortic/fork-handlers/<sourceThreadId>.json` (see §13.8.2).
- UI: transcript-header dropdown (no new modal), list past scratches, click → resume.

#### 13.4.5 Expandable "source when forked" bubble
- Drawer-only, collapsed `<details>`. Summary: "Snapshot from <thread> · 2 msgs." Body: the 2 messages verbatim.
- **Never use "fork"/"scratch" in user-facing copy** (§11 cognitive-load finding).

#### 13.4.6 Repo divergence indicator
- In the divergence pill's tooltip: "repo +32/−11 lines since fork" (units mandatory).
- Computed via `git diff --numstat <baselineSha>..HEAD` (Mortic-side, not via app-server protocol).
- Hidden when both insertions=0 and deletions=0 and messagesBehind=0.

### 13.5 Phase 2 — Send to Main Thread + delta handoffs + diff reporting

#### 13.5.1 Send to Main Thread (Codex)
- **Modular terminology:** "Main Thread" + "(Codex)" provider variable. `MainThreadProvider` interface (see §13.8.1).
- **Flow:** generate handoff → click "Send to Codex" (replaces Copy-full as primary; Copy-full to kebab) → approval modal → `turn/start({ threadId: sourceThreadId, input: [handoff prompt] })`.
- **Blocking probe needed (subagent finding Q1):** cross-home `turn/start` on a `~/.codex` source thread from the `~/.mortic/codex-home` app-server is **unverified**. Probe 2 verified cross-home `thread/fork` + `thread/read` but NOT `turn/start`. If it fails, Feature 1's shape changes materially.

#### 13.5.2 Handoff confirmation (no response content)
- The divergence pill transitions: **fresh → (send) → sent ✓ → (main responds) → responded ✓**.
- **No response content, no expandable response** (user explicitly rejected).
- "responded ✓" is a link: click → open the Codex thread (`sourceUri`).
- Drawer gets one one-line affordance: "Sent to Codex · <time> ›" (link, no body).
- **Self-caused divergence (subagent UX finding §6):** Mortic attributes correctly — it advances its baseline to include its own sent message, so its own send never counts as divergence. Main's *response* is real new content → "1 behind" is correct and useful.

#### 13.5.3 Continue working; manual sync when ready
- After send, the scratch stays active. User continues talking. No auto-refresh, no archive.
- User manually Syncs (clicks the stale pill) when they want fresh source context.

#### 13.5.4 Handoff generation — ephemeral fork-of-scratch
- **Current (wrong):** `runCodexTurn({ threadId: source })` forks the *source* and re-feeds the scratch transcript as a string (`app.ts:2415`).
- **New:** `createEphemeralFork(scratchThreadId)` → fork-of-scratch inherits source context + voice conversation natively. No re-feeding.
- **Ephemeral:** Codex implements `createEphemeralFork` as `thread/fork({ ephemeral: true })` (app-server cleans up). opencode will implement as "fork + delete session" (deferred).

#### 13.5.5 Delta handoffs (unified for both providers)
- **Handoff log per scratch:** `handoffHistory` in the fork handler record.
- **On each handoff generation:** fork the whole scratch (ephemeral) → inject: *"Previous handoff sent to Main Thread: [H1]. Conversation since last handoff checkpoint: [turns after checkpoint]. Generate the next handoff — what to carry forward, avoiding repetition of H1."*
- **Model generates a delta** ("what's new since H1").
- **Unified fork-whole + prompt-delta** for both Codex and opencode (no fork-granularity divergence).

#### 13.5.6 Diff reporting on handoff send
- When handoff is sent, compute the diff the scratch introduced: `git diff --numstat <headAtFork>..HEAD` in the scratch's cwd.
- Displayed in the "sent ✓" pill's tooltip: "Your scratch changed +4/−1 files; 3 turns kept."
- **Mortic-only metadata** — does NOT accompany the handoff prompt to Main Thread.

### 13.6 Code/diff staleness (in this pass)

The user's directive: "I want to see the diff summary (+32,-11 from main repo state). If code is written by the scratch, then the diff introduced by the thread is to be reported when handoff is sent back."

**Two surfaces:**
1. **Phase 1 — repo divergence indicator:** "+32,-11" in the stale pill's tooltip, showing how far the repo has moved since fork-time baseline. Computed via `git diff --numstat <baselineSha>..HEAD`.
2. **Phase 2 — diff reporting on handoff send:** the diff the scratch thread itself introduced, shown in the "sent ✓" pill's tooltip. Computed via `git diff --numstat <headAtFork>..HEAD` in the scratch's cwd at send time.

**Future (recorded, not this pass):** per-file diff tracking (which files the scratch touched), `turn/diff/updated` notification parsing, Codex `gitDiffToRemote` protocol surface — all deferred. The `git diff --numstat` shell-out is the cheapest correct approach for this pass.

### 13.7 UX design (minimal, merged from UX subagent)

**Headline:** eight features collapse into **3 always-visible elements** (one divergence pill, reused; +1 Send action replacing Copy-full; +2 collapsed transcript drawer items) by exploiting three observations: (i) divergence/repo-diff/sync are one concept in three clothes; (ii) the handoff confirmation "sent ✓" *is* the divergence pill's post-send state — no separate bubble; (iii) scratch history is recoverable, so it's a dropdown, not a modal.

**The divergence pill — one element, four states:**
| State | Copy | When |
|---|---|---|
| fresh | *(hidden)* | N=0, not just sent |
| stale | `» 3 behind` | source advanced; tooltip: "3 new messages in <thread> · repo +32/−11 lines since fork" |
| just sent | `sent ✓` | handoff sent; tooltip: "Handoff sent to <thread>; waiting for response · your scratch changed +4/−1 files" |
| responded | `responded ✓` | main responded; click → open Codex thread; tooltip: "Codex replied ~2m ago" |

**Key UX decisions:**
- **No 4-button Refresh/Retain/Skip/Auto prompt.** Click stale pill → 2-choice inline confirm ("Keep / Catch up"). "Skip" = doing nothing (close). "Auto" = advanced setting toggle, default off.
- **Sync = click the stale pill**, not a persistent button.
- **Scratch history = transcript-header dropdown**, no new modal.
- **"Source when forked" = drawer-only collapsed `<details>`**, not in compact 1-turn view.
- **Send replaces Copy-full as primary**; Copy-full to kebab/overflow. Net handoff actions: +0.
- **Never use "fork"/"scratch" in user-facing copy** (§11 cognitive-load finding). Use "your copy" / "main" / "thread" / "note."
- **Divergence is a parallel channel, never a 6th orb state.** The orb stays the §11 5-state surface (Pick a thread / Ready / Listening / Thinking / Speaking + Codex offline / Error).
- **Self-caused divergence: option (d)** — attribute correctly. Mortic advances its baseline to include its own sent message, so its own send never counts as divergence. Main's response is real new content → "1 behind" is correct. No transient mutating label (avoids §11 E2 anti-pattern).

**Net clutter delta:** overlay HUD +1 element (the pill, only when not fresh); full-app orb +0; handoff card +0 net actions; transcript compact view +0; transcript drawer +2 collapsed lines; new modals/panels 0.

### 13.8 Technical architecture

#### 13.8.1 MainThreadProvider abstraction
New `src/server/mainThreadProvider.ts` — provider-neutral interface:
```
interface MainThreadProvider {
  readonly name: "codex" | "opencode";
  readonly label: string;  // "Codex"
  forkFromSource(opts): Promise<PersistedFork>;
  createEphemeralFork(threadId, opts): Promise<EphemeralFork>;
  sendTurn(threadId, input, opts): Promise<{ turnId }>;
  readThread(threadId, opts?): Promise<ProviderThread>;
  resumeThread(threadId, opts?): Promise<ProviderThread>;
  archiveThread(threadId): Promise<void>;
  computeDiff(threadId, baselineRepoState): Promise<ProviderDiff>;
}
```
- Codex is the first implementation (`src/server/codexMainThreadProvider.ts`), wrapping `CodexAppServerBridge`.
- opencode deferred (shared global db — `UnsupportedProviderError` until isolation is solved).
- The bridge stays as the Codex WebSocket transport; the provider wraps it, doesn't extract it.

#### 13.8.2 Fork handler registry
`~/.mortic/fork-handlers/<sourceThreadId>.json`:
```json
{
  "schemaVersion": 1,
  "sourceThreadId": "...",
  "mainThreadProvider": "codex",
  "currentScratchId": "...|null",
  "baseline": {
    "sourceUpdatedAt": <unix>,
    "sourceTurnCount": <n>,
    "lastTwoMessages": [{ "role": "user|assistant", "text": "..." }],
    "repoState": { "branch": "...|null", "headCommit": "...|null", "dirty": false, "capturedAt": "..." }
  },
  "scratchSessions": [
    { "id": "...", "morticSessionDir": "sessions/...", "persistedThreadId": "...",
      "forkedAt": "...", "baselineSourceUpdatedAt": <unix>, "baselineSourceTurnCount": <n>,
      "status": "active|archived", "archivedAt": "..." }
  ],
  "createdAt": "...", "updatedAt": "..."
}
```
- Phase 2 adds `handoffHistory: [{ generatedAt, scratchId, scratchTurnCount, shortPrompt, fullPrompt, sentToMain, mainTurnId, mainResponseStatus, diffSummary }]`.
- **Forward-compat contract:** all writes go through `updateHandler(sourceThreadId, mutator)` with spread-based RMW. Never reconstruct a full object — that drops unknown fields a future version wrote.
- **Relative paths** for portability: `morticSessionDir` stored relative to `~/.mortic/`.
- Atomic writes via `writeTextAtomic` pattern (`storage.ts:138-145`).
- Per-handler `serializeOperations()` queue (`fsio.ts:24`) — different sources don't block each other.

#### 13.8.3 Raw rollout sidecar — DROPPED (YAGNI)
Subagent finding: the persisted Codex fork already writes the authoritative rollout to `~/.mortic/codex-home/sessions/`. A Mortic sidecar is redundant, lossy, and can't be fed back to Codex for resume. Drop it. Keep `transcript.md` (human-readable) + `session.json` (Mortic transcript) as today.

#### 13.8.4 `~/.mortic/` directory layout
```
~/.mortic/
├── sessions/              # existing — Mortic session storage
├── codex-home/            # new — scoped CODEX_HOME
│   ├── auth.json          #   symlink → ~/.codex/auth.json
│   ├── config.toml        #   minimal (model + reasoning effort)
│   ├── skills/            #   vendored (mortic-voice-output, mortic-canonical-state)
│   ├── sessions/          #   Codex-managed rollouts (persisted scratches)
│   └── session_index.jsonl
├── fork-handlers/         # new — registry
│   └── <sourceThreadId>.json
└── projects/              # existing — per-workspace
```

#### 13.8.5 Server routes
Phase 1: `GET /api/session/divergence`, `POST /api/session/refork`, `POST /api/session/resume-scratch/:id`, `GET /api/session/scratches`.
Phase 2: `POST /api/handoff/send-to-main`, `GET /api/session/handoff-history/:scratchId`.

### 13.9 Adversarial implementation plan (synthesized from 4 subagents)

#### 13.9.1 Critical findings (shape every feature)

| # | Finding | Impact | Mitigation |
|---|---|---|---|
| 0.1 | **`CODEX_HOME` process-wide footgun.** Four modules read `process.env.CODEX_HOME` (`providerAdapters.ts:103,107`, `skillSync.ts:83`, `sparkContext.ts:184`, `runtimeContext.ts:61`). Setting it globally breaks source listing, skills, spark preflight, runtime context. | High — silent total breakage | Set `CODEX_HOME` **only in the spawned child env** at `appServerBridge.ts:1072`. Never mutate `process.env.CODEX_HOME`. |
| 0.2 | **Boot archive path destroys persisted forks.** `archiveQueuedScratchThreads` (`appServerBridge.ts:1137`) runs on every `start()` and archives all `this.scratches`. Today safe (ephemeral). With persisted forks, restart would archive resumable scratches. | High — data loss on restart | Persisted scratches must **never** go into `scratchArchives`. Separate `persistedScratches` map, rehydrated from registry on boot, excluded from archive paths. |
| 0.3 | **`gitDiffToRemote` has wrong semantics.** Diffs against origin HEAD, not fork-time baseline. Overcounts unpushed commits; fails without remote. | Medium — wrong divergence numbers | Use `git diff --numstat <baselineSha>..HEAD` shell-out (Mortic-side). |
| 0.4 | **`thread/read` cross-home is unverified.** Probe 2 verified `thread/fork` + `thread/read` same-home (the fork in scoped home). It did NOT verify `thread/read({ threadId: source })` from scoped app-server where source lives in `~/.codex`. | Medium — divergence polling may fail | **Primary: Mortic-side JSONL tail-parse** of source session file (cheaper, app-server-independent). `thread/read` as fallback. |
| 0.5 | **`thread/archive` may make persisted fork unresumable.** Whether `thread/resume` can find an archived thread is unverified. | High — refork may permanently break resume-old | **Blocking probe before coding.** If archive breaks resume, refork must set-aside (registry-only, no `thread/archive`) rather than archive. |
| 0.6 | **`error` notification broadcasts to ALL pending turns** (`appServerBridge.ts:1736-1748`). A scratch-turn error would reject an in-flight main-thread turn. | High — send-to-main killed by scratch errors | Add `kind: "scratch" | "main"` field to `PendingTurn`; scope `error` broadcasts by `threadId` or `kind`. |
| 0.7 | **`PendingTurn` has no timeout** (`appServerBridge.ts:1493-1509` waits forever). A hung main turn hangs the bubble forever. | Medium — 3am hang | Add 10-min timeout to `sendToMainThread`. On timeout, bubble → "sent ✓ (no response yet)" with warning. |
| 0.8 | **`ws.onclose` doesn't reject pending** (`appServerBridge.ts:1379-1381`). In-flight requests hang forever on websocket close. | Medium — silent hang | In `ws.onclose`, reject all `this.pending` + `this.pendingTurns` with "websocket closed." |
| 0.9 | **`interrupt` rejects ALL `pendingTurns`** (`appServerBridge.ts:895-904`). Interrupting a scratch turn would also reject an in-flight main turn — but the main turn keeps running server-side (Mortic only rejected its local promise). | High — false "failed" on main turn | `interrupt` must filter by `kind: "scratch"`. Main turns are immune to scratch interrupts. |

#### 13.9.2 Race conditions + mitigations

| Race | Mitigation |
|---|---|
| Poll racing with refork | **Epoch token** — `reforkEpoch` incremented on refork; poll closure captures epoch; discard result if epoch changed. |
| Two surfaces (overlay + full app) polling same source | **Server-side dedupe** — cache last `readSourceThread` result for 2.5s; both surfaces' requests return cached value. One app-server RPC per 3s. |
| Refork while scratch turn is running | 409 (same pattern as `app.ts:1465`). User must interrupt first. |
| Send-to-main while scratch turn is running | `sendToMainThread` uses a **separate `mainThreadOpLock`** (not `withOperationLock`) so main-thread ops serialize among themselves but don't block scratch ops. Two concurrent `PendingTurn`s route correctly by `turnId`. |
| Two sends in quick succession | Client `sendPending` guard + 409 backstop. Do NOT queue main-thread turns (would spam the user's main thread). |
| Handoff-gen while refork is happening | **`checkpointLock`** (per-session mutex) held during refork's `setForkCheckpoint` AND during `/api/handoff`'s read+fork. |
| Registry concurrent RMW (same process) | Per-handler `serializeOperations` queue (`fsio.ts:24`). |
| Registry concurrent RMW (two Mortic instances) | `writeAtomic` prevents corruption (last-writer-wins). Document single-instance-per-machine as supported. Optional `MORTIC_SCOPED_HOME_OVERRIDE` env for dev. |
| Boot rehydration racing with user-triggered prewarm | `withOperationLock` serializes; prewarm waits for rehydration. |
| Ephemeral fork cleanup racing with `turn/completed` | Cleanup only AFTER `runScratchTurn`'s promise resolves (in a `finally` block). |

#### 13.9.3 Failure-mode matrix (top entries)

| Failure | User-visible | Auto-recovery | Manual action |
|---|---|---|---|
| Scoped home mkdir fails (disk/perms) | Onboarding blocks | Retry on "Check again" | Free disk / fix perms |
| `auth.json` symlink fails | Onboarding blocks | None (block, don't copy — copy causes stale-auth) | Fix filesystem |
| `~/.codex/auth.json` deleted after setup | First scoped turn 401s | Re-run `ensureScopedHome()`, retry once | `codex login` |
| `thread/fork` returns `ephemeral:true` (server ignored flag) | Turn fails: "scratch was not persisted" | None | Upgrade Codex CLI |
| Source session file not found | Turn/prewarm fails: "source session file for <id> not found" | None | Open thread in Codex CLI once |
| `thread/read` cross-home fails | Divergence shows "?" | JSONL fallback (Mortic-side) | None |
| App-server restarts mid-poll | "Reconnecting…" badge | `ensureReady` auto-restarts on next turn | None |
| App-server restarts mid-fork | Turn fails "app-server exited" | Retry creates new fork; orphan swept at boot | None |
| Registry JSON corrupt | "Scratch history for <thread> reset" notice | Move to `.corrupt-<ts>`, start fresh | None |
| `thread/resume` fails (file pruned / archived-unresumable) | "Scratch file no longer exists" | Mark registry entry `missing` | None |
| Refork while turn running | 409 "A turn is running" | None | Interrupt first |
| `git` not on PATH | Repo badge: "Git not found" | None | Install git |
| Not a git repo | Repo badge hidden / "Not a git repo" | None | None |
| Source thread rolled back (CLI `thread/rollback`) | "Source rolled back — consider catching up" | `messagesBehind` clamped to 0, `rollback` flag set | Catch up |
| Source thread deleted/archived in CLI | "Source thread no longer exists locally" | Disable turn input | Pick a different thread |
| Send-to-main 409 (main busy) | "Main Thread busy — retry" | None (no auto-retry) | Click Retry, or wait for CLI turn |
| Send-to-main — source thread not found | "Main Thread not found — copy instead" | None | Copy handoff manually |
| Main turn hangs (no `turn/completed`) | Pill "sent ✓" + warning "no response yet" after 10m | None | Check Codex CLI |
| Mortic restart with bubble in "sending" | Pill → "failed" "Mortic restarted before response" | Boot sweep (mirror `sweepStaleActiveTurn`, `app.ts:726`) | None |
| `interrupt` during in-flight main turn | Main turn NOT cancelled (still runs on source); pill stays "sent ✓" | None | None (filter by `kind:"scratch"`) |
| `CODEX_HOME` env leak (regression) | Source list empty / skills in wrong home | Boot assertion: `~/.mortic/codex-home/sessions/` must exist post-spawn | Remove the `process.env` mutation |

#### 13.9.4 Handoff confirmation state machine (Phase 2)

```
sending → sent ✓ → responded ✓
  │         │
  │         │ turn/completed with error → responded ✓ (warning tooltip)
  │         │ 10m timeout → sent ✓ (warning "no response yet")
  │         │ Mortic restart → failed
  │         │ websocket close → failed
  │
  │ turn/start rejected (409/error) → failed
  │ websocket close → failed
  │ Mortic restart → failed (boot sweep)
```
**States:** `sending` (turn/start sent, waiting for ack) → `sent ✓` (turn accepted, waiting for completion) → `responded ✓` (turn/completed, terminal). Failure: `failed` (terminal, user may Send again → new bubble).

#### 13.9.5 Delta handoff prompt (exact shape, Phase 2)

```
Convert the NEW scratch conversation since the last handoff into a paste-ready
instruction prompt for the user's original Codex chat. This is a DELTA handoff —
a previous handoff was already sent; do not repeat it.

Previous handoff sent to Main Thread (H1):
# Short Prompt
${previousHandoff.shortPrompt}

# Full Prompt
${previousHandoff.fullPrompt}

Conversation since the last handoff checkpoint (turns ${previousHandoff.scratchTurnCount}..now):
${turnsSinceCheckpointMarkdown}    // = transcript.slice(previousHandoff.scratchTurnCount), or "(no new turns since H1)"

${checkpointInstruction}

Generate the NEXT handoff — what to carry forward now, avoiding repetition of H1.
Rules:
- Do NOT repeat instructions or context that were already in H1.
- Focus only on what is NEW since H1: new decisions, actionables, risks, corrections, completed work.
- If nothing material has changed, output a Short Prompt that says so and an empty Full Prompt.

Return markdown with exactly these headings:
# Short Prompt
# Full Prompt
```

### 13.10 Blocking probes (before coding)

| # | Probe | Blocks | Status |
|---|---|---|---|
| 1 | Symlinked auth across scoped home | Design 1 viability | **PASS** (§12.10) |
| 2 | Cross-home `thread/fork` + persistence | Phase 1 fork | **PASS** (§12.10) |
| 3 | `thread/resume` on archived threads | Phase 1 refork + resume-old | **NEEDED** — if archive breaks resume, refork must set-aside (registry-only), not `thread/archive` |
| 4 | Cross-home `turn/start` on `~/.codex` source thread | Phase 2 send-to-main | **NEEDED** — if it fails, send-to-main must talk to the user's primary app-server (discovery needed) or shell out to `codex exec` |
| 5 | `thread/read` cross-home on source thread | Phase 1 divergence | **NEEDED** — if it fails, JSONL fallback is the primary path (already planned) |
| 6 | opencode fork + isolation | opencode portability | **DONE** (§12.10 — shared global db, isolation fails) |

Probes 3, 4, 5 are quick (10-15 min each against a real Codex app-server). Run before coding the features they gate.

### 13.11 Open implementation questions (resolved)

| # | Question | Resolution |
|---|---|---|
| Q1 | Compacted-spark-base forks stay ephemeral? | **Yes — keep ephemeral.** Only the main scratch path flips to persisted; compaction bases are transient by design. |
| Q2 | Symlink vs copy for auth (if symlink impossible)? | **Symlink primary (one login); separate-auth fallback (two logins, only if symlink fails); never copy-without-refresh.** If symlink is impossible (Windows dev-mode off, restricted perms), the scoped home gets its own `auth.json` (real file) and the user logs in separately. Token refresh in each is independent — no silent drift. Cost is two logins, only on systems where symlink is impossible (not macOS). |
| Q3 | Scoped `config.toml` — minimal or copy-and-strip? | **Replicate the Codex home (copy-and-strip).** The vision: the fork is essentially the same in ability. Copy the user's `config.toml` and strip the `CODEX_HOME` line. Scratches inherit marketplaces, MCP servers, plugins, notify — full user config minus the home path. |
| Q4 | Orphan recovery (fork on disk, registry write failed)? | **Prune silently, note the failure mode, don't over-index.** Orphan recovery adds complexity for a rare edge; the voice transcript is still in `~/.mortic/sessions/` (Mortic's storage), so only the Codex thread mapping is lost. |
| Q5 | Divergence polling primary path? | **JSONL primary; probe to confirm rollout schema.** `thread/read` fallback if JSONL unreadable. Run a quick probe to inspect a real rollout file's line schema (what `type` field marks a turn boundary). |
| Q6 | Refork clears transcript? | **Yes — "Re-Sync to Main" starts afresh.** Refork button is labeled "Re-Sync to Main" (not "Catch up"). Clears the Mortic transcript, archives the old scratch to history, forks fresh from current source. |
| Q7 | Registry retention cap? | **Storage unbounded; list UX shows last 20.** Text/JSONL is cheap — store everything. The history dropdown shows the 20 most recent scratches per source (scrollable for more). Reconciles "store everything" (user's earlier instinct) with list UX. |
| Q8 | Repo badge when clean? | **Hide when both zero AND messagesBehind=0; show "+0,-0" when messagesBehind>0.** Agree with subagent. |
| Q9 | Repo diff scope? | **"fork-time HEAD → current working tree" with label "from fork-time repo state."** Agree with subagent. Accept overcount as a known limitation. |
| Q10 | `/api/session/clear` semantics with persisted forks? | **clear == refork (Re-Sync). AND: if the scratch had no turns (nothing said), delete the scratch entirely — don't archive an empty conversation.** Clear with turns → archive + refork; clear with 0 turns → delete scratch + no fork (user is done). |
| Q11 | Concurrent Mortic instances? | **Document single-instance-per-machine as supported. Optional `MORTIC_SCOPED_HOME_OVERRIDE` env for dev.** Agree with subagent. |
| Q12 | Should scratches see user-installed Codex skills/marketplaces? | **Replicate the source environment.** Scratches inherit user-installed skills and marketplaces (via the copy-and-strip config.toml from Q3). The fork is "the same in ability" — scratches see what the CLI sees. |
| Q13 | opencode provider — implement stub now or defer? | **Defer.** Registry is Codex-only until opencode isolation is solved (separate probe). Agree with subagent. |
| Q14 | "Auto" button for divergence? | **No auto at all for now.** Revisit after Phase 2's handoff logging exists. Removed entirely (not even an advanced toggle this pass). |
| Q15 | "responded ✓" timeout? | **Just leave "sent ✓" if reply doesn't come.** No "(no reply yet)" warning, no auto-fail. The pill stays "sent ✓" indefinitely; the user checks their CLI. Honest, simplest. |
| Q16 | Send-to-Codex vs Copy-only (Phase 2)? | **Send is in Phase 2.** The user's Codex CLI/app being closed doesn't matter — Mortic spawns its own app-server (in the scoped home) which runs the turn independently. The result is written to the source thread's rollout file in `~/.codex/sessions/`; the user sees it when they next resume that thread in their CLI. The only failure is if Codex auth is expired (401 → surface re-login). |
| Q17 | Does diff summary accompany handoff prompt to Main Thread? | **Yes — include the diff in the handoff prompt.** Otherwise Main has no idea what the scratch changed. Append the diff summary (e.g., "Files changed by the scratch: +4/−1 — fileA.ts, fileB.ts") to the handoff prompt sent to Main. Main gets context for what the voice session did. |

**Key shifts from subagent recommendations:**
- **Q3 + Q12:** scratches *replicate* the source environment (config + skills + marketplaces), not hermetic isolation. The fork is "same in ability."
- **Q6:** Re-Sync button (not "Catch up"), starts afresh.
- **Q10:** clear == Re-Sync, AND empty scratches are deleted (not archived).
- **Q14:** no auto at all (not even an advanced toggle).
- **Q15:** sent ✓ stays forever if no reply (no soft warning).
- **Q17:** diff is included in the handoff prompt to Main (not Mortic-only metadata).

### 13.12 Phasing

**Phase 1 (this pass):** §13.4 + §13.6 (repo divergence indicator). Persisted CLI-invisible forks, divergence counter (message + repo) + manual sync, history + resume, expandable source-when-forked bubble, onboarding, one-login. Run blocking probes 3 + 5 first.

**Phase 2 (follow-on):** §13.5 + §13.6 (diff reporting on handoff send). Send to Main Thread, handoff confirmation (sent ✓ / responded ✓, no response content), fork-of-scratch handoff generation, delta handoffs with handoff logging. Run blocking probe 4 first.

**Deferred:** opencode portability (separate probe), auto-refresh (revisit after Phase 2), realtime voice, interrupt-semantics fix, per-file diff tracking, `gitDiffToRemote` protocol surface.

### 13.13 Success metrics (informal)

**Phase 1:**
- Scratch survives Mortic restart (talk, quit, reopen, resume).
- Scratch absent from `codex threads`.
- Divergence counter updates within ~3s of Main Thread advancing (messages) and on poll (repo).
- Manual Sync re-forks without touching the Main Thread.
- Resume-old loads a persisted scratch with full history.
- One login works for both CLI and Mortic.
- Repo divergence tooltip shows correct "+N,-M" against fork-time baseline.

**Phase 2:**
- Send to Main Thread (Codex) writes a turn to the source; user sees it in `codex` CLI.
- Pill transitions: sent ✓ → responded ✓ (no response content shown).
- Scratch stays active after send; user continues talking.
- Second handoff from the same scratch is a delta (doesn't repeat H1).
- Diff reporting shows the scratch's introduced diff in the "sent ✓" tooltip.

### 13.14 Subagent contributions

- **Phase 1 adversarial planner:** 11 open questions + critical findings 0.1-0.6 + failure-mode matrix + repo divergence computation (shell-out, not `gitDiffToRemote`) + JSONL primary for polling + epoch token for poll/refork race + boot archive path conflict.
- **Phase 2 adversarial planner:** cross-home `turn/start` blocking probe + `kind:"scratch"|"main"` field for `PendingTurn` + `mainThreadOpLock` separation + `checkpointLock` for refork/handoff-gen race + bubble state machine + boot sweep for "sending" bubbles + reject-on-close for ws + delta handoff prompt shape + `createEphemeralFork` abstraction.
- **Storage/abstraction planner:** DROP raw rollout sidecar (YAGNI) + fork handler schema with `schemaVersion` + `updateHandler` spread-based RMW contract for forward-compat + `MainThreadProvider` interface signatures + relative paths for portability + two-Mortic-instances risk + `thread/read` cross-home likely fails (JSONL fallback) + opencode `UnsupportedProviderError`.
- **UX minimality auditor:** merged divergence pill (4 states: fresh/behind/sent ✓/responded ✓) + drop 4-button prompt (2-choice Keep/Catch up) + Sync = click stale pill + history = dropdown + source-when-forked = drawer-only + Send replaces Copy-full + self-caused divergence option (d) + never use "fork"/"scratch" in copy + divergence is a parallel channel not a 6th orb state + net clutter delta (+1 overlay element, +0 orb, +0 handoff actions, +2 drawer lines).

---

## 14. Manual QA Test Suite — End-to-End Conversation Flows

**Purpose:** This is a human-run QA suite for product managers/QA. It covers full conversation flows, subjective visual/audio-latency checks, and granular regression checks for the recent Kimi/GLM visual-and-voice review changes. It is intentionally non-automated because many issues are subjective (timing feel, audio glitches, visual hierarchy) and are missed by static eval harnesses.

**How to use:**
1. Run each test in order or pick a section.
2. Capture telemetry as described in §14.3.
3. Record result in the Issue Log (§14.6) with severity, evidence, and pasted telemetry.
4. If a test fails, paste the relevant `POST /api/turn/:id/audio-health` body, SSE frame, or server log line into the issue.

**Current tree note (2026-06-19, later refactor):** The app has been simplified since §5 was written. `ChartModal.tsx`, `ProjectPanels.tsx`, `TelemetryPanel.tsx`, `ForkActionSheet.tsx`, and the extraction-review UI are no longer present. `HandoffPanel.tsx` is the new handoff surface. Live mode toggle is no longer in the dock. Copy-handoff feedback, Clear confirmation, clipboard fallback, modal focus traps, provider-notice rendering, Codex-offline input disabling, and `threadRequired` CTA are now implemented. Use the regression checklist in §14.5.Q to verify those changes granularly.

### 14.1 Environment & startup commands

- Node >= 20, Codex CLI installed and logged in (`codex login`).
- Recommended browser: Chrome (browser STT works best there). Use a real Codex thread id.
- Optional voice keys in `~/.mortic/.env`: `DEEPGRAM_API_KEY`, `INWORLD_API_KEY`, `OPENAI_API_KEY`, `ELEVENLABS_API_KEY`, `LIVEKIT_*`.

**Dev (web):**
```bash
npm install
npm run dev -- codex://threads/<thread-id> --api-port 5152 --ui-port 5173 --no-open
# open http://127.0.0.1:5173/?api=http://127.0.0.1:5152
```

**Dev (desktop overlay):**
```bash
npm run build:desktop
npm run desktop:dev
# or: npm run desktop:dev -- codex://threads/<thread-id>
```

**Packaged-style:**
```bash
npm run build
npm start -- codex://threads/<thread-id> --api-port 5152 --no-open
```

**Doctor:**
```bash
npm run build && node dist/node/cli/main.js doctor
```

**Static UX harness (sanity):**
```bash
node scripts/eval_desktop_ux.mjs
```

### 14.2 Surfaces under test

- **Full app:** browser tab or Electron full window (`?api=...`, no `surface` param).
- **Overlay:** Electron overlay (`?surface=overlay`). Collapsed HUD and expanded panel.
- **Both can run at once** in desktop mode; use this for surface-cohesion tests.

### 14.3 Telemetry observation guide

Open these before starting:

1. **Terminal running the server** — startup block, prewarm lines, warnings. Per-turn logs are normally not printed; watch for `Mortic queued turn failed to start` and project-store warnings.
2. **Browser DevTools → Network tab** — filter by `api`. Key requests:
   - `GET /api/session` (session snapshot)
   - `GET /api/session/stream` (SSE snapshot/audio-command channel)
   - `POST /api/turn` (returns `turnId`, `serverAcceptMs`)
   - `GET /api/turn/:turnId/stream` (SSE: `snapshot`, `log`, `delta`, `voiceActivity`, `status`, `completed`, `failed`, `interrupted`)
   - `POST /api/turn/:turnId/audio-health` (full audio timing ledger)
   - `POST /api/session/prewarm` (`prewarmMs`, `logs`)
   - `POST /api/handoff` (`handoff`, `shortPrompt`, `fullPrompt`, `generatedBy`)
   - `POST /api/session/clear`, `POST /api/session/source`
   - `POST /api/session/presence` (5s heartbeat)
3. **DevTools → EventStream pane** — select the `/api/turn/:id/stream` request to see SSE frame timing. The first `log` with `"App-server first model delta"` marks time-to-first-token.
4. **DevTools → Console** — warnings like `[Mortic] audio health update failed`, `[Mortic] text-to-speech stopped`, provider notices.
5. **In-app debug surfaces:**
   - **Codex working buffer** — appears while pending and no assistant text yet; shows latest activity label and up to 6 activity updates.
   - **Codex debug trace** (`<details>` "Codex debug trace") — last 32 lifecycle lines, spoken statuses, verdict.
   - **Agent orb** — `interactionState` (Select thread / Ready / Listening / Thinking / Speaking / Codex offline / Error) and `codexStateLabel` (Idle / Warming / Scratch ready / Warm failed / Thinking).
   - **Voice provider notices** — `transportNotice`, `sttProviderNotice`, `ttsProviderNotice` rendered below the dock/overlay when non-null.
   - **Clear button** — shows `Ready <ms>` / `Warming` / `Reset` to reflect prewarm.
6. **React DevTools** — inspect `App` hook state for `audioHealth`, `sttPhase`, `speechPhase`, `recognizing`, `queuedTurnPreview`, `prewarm`. `audioHealth` is only non-null for voice turns.
7. **Manual endpoint probes (optional):**
   - `GET /api/onboarding` — re-runs skill sync.
   - `GET /api/tts/elevenlabs/health` / `GET /api/tts/deepgram/health` — TTS round-trip latency.
   - `POST /api/stt/transcribe` — STT provider fallback chain.
   - `GET /api/provider/threads?limit=40&cwd=<path>&searchTerm=<term>` — thread list.

**Key audio-latency fields to capture from `POST /api/turn/:id/audio-health`:**
`firstDeltaMs`, `firstClientDeltaMs`, `firstVisibleTextMs`, `firstSpeakableTextMs`, `firstSpeechQueuedMs`, `firstTtsRequestMs`, `firstTtsResolvedMs`, `firstSpeechStartMs`, `firstSpeechEndMs`, `ttsConnectMs`, `firstAudioChunkMs`, `firstAudioPlayMs`, `audioBufferUnderruns`, `finalTextMs`, `speechAfterFinalMs`, `streamedChars`, `spokenChars`, `spokenChunks`, `ttsError`, `ttsProviderStatus`, `bargeInStartedMs`, `interruptionLatencyMs`.

### 14.4 Test case index

| ID | Area | Surface |
|---|---|---|
| A1–A4 | Cold start & onboarding | Both |
| B1–B8 | Thread selection | Both |
| C1–C9 | Overlay shell & windowing | Overlay |
| D1–D6 | Config & settings | Full app |
| E1–E8 | Voice turn E2E | Both |
| F1–F3 | Text turn E2E | Both |
| G1–G5 | Streaming & latency | Both |
| H1–H5 | TTS audio quality & latency | Both |
| I1–I5 | Barge-in & interrupt | Both |
| J1–J7 | Handoff generate/preview/copy | Both |
| K1–K4 | Clear scratch & confirmations | Both |
| L1–L6 | Surface switching & cohesion | Both |
| M1–M8 | Error & edge cases | Both |
| N1–N6 | Accessibility & keyboard | Both |
| O1–O5 | Visual & density | Overlay |
| P1–P5 | Remnant/dead-feature verification | Both |
| Q1–Q12 | Recent Kimi/GLM change regression | Both |

### 14.5 Test cases

Each test: **Steps → Expected → Telemetry to capture → Pass/Fail/Notes.**

---

#### A. Cold start & onboarding

**A1. First launch with Codex available**
1. `npm run dev -- codex://threads/<id> --no-open`; open browser.
2. Watch terminal startup block and `/api/onboarding`.
- **Expected:** Startup logs show `Mortic is running`, `Codex: <version> at <path>`, `Voice scratch prewarmed: …`. No onboarding modal. Topbar status dot green. Orb shows `Ready` / `Scratch ready` after prewarm.
- **Telemetry:** terminal startup block; `GET /api/session` `session.codex.available`; `POST /api/session/prewarm` `prewarmMs`.
- **Pass/Fail/Notes:**

**A2. Launch with Codex missing/logged out**
1. Temporarily rename `codex` on PATH or `codex logout` (only if safe).
2. Launch.
- **Expected:** Onboarding screen or inline warning “Codex is unavailable. Transcript and handoff remain available; turns are paused.” Voice/text controls disabled. Recheck button works.
- **Telemetry:** `GET /api/onboarding` `provider.available=false`; `GET /api/session` `session.codex.available=false`.
- **Pass/Fail/Notes:**

**A3. Onboarding screen readability**
1. Trigger A2.
2. Read each step text and error.
- **Expected:** Steps are plain-language; errors are readable (not faint italic). “Check again” shows busy state.
- **Pass/Fail/Notes:**

**A4. Prewarm confirmation**
1. Launch with a valid thread.
2. Watch terminal and orb.
- **Expected:** Terminal `Voice scratch primed: confirmation turn completed`; orb moves `Warming → Scratch ready`; Clear button shows `Ready <ms>`.
- **Telemetry:** `POST /api/session/prewarm` `prewarmConfirmation`.
- **Pass/Fail/Notes:**

---

#### B. Thread selection

**B1. Open Finder from full app**
1. Click “Finder” button in topbar.
- **Expected:** Picker opens with search input focused, workspace scope toggle, list of recent threads. Trigger button label toggles to “Close”.
- **Telemetry:** `GET /api/provider/threads?limit=40&cwd=…`.
- **Pass/Fail/Notes:**

**B2. Search threads**
1. Open picker. Type a project/thread fragment.
- **Expected:** List updates after ~160ms debounce; empty state offers “Search all projects” when scoped.
- **Telemetry:** Network requests with `searchTerm`.
- **Pass/Fail/Notes:**

**B3. Workspace scope toggle**
1. Open picker. Toggle “All projects” / “This project”.
- **Expected:** Scope label changes; list filters by `cwd` when scoped.
- **Telemetry:** Requests include/omit `cwd`.
- **Pass/Fail/Notes:**

**B4. Preview then open**
1. Click a thread row.
2. Click “Open this thread” in preview.
- **Expected:** Single click highlights + fills preview; double-click or preview button commits; picker closes; focus returns to trigger; topbar updates.
- **Pass/Fail/Notes:**

**B5. Keyboard navigation**
1. Open picker. Type query, then Arrow Down/Up, Enter, Escape.
- **Expected:** Arrow keys move focus and preview; Enter commits preview; Escape closes and returns focus to trigger.
- **Pass/Fail/Notes:**

**B6. No threads / empty state**
1. Use a workspace with no Codex sessions.
- **Expected:** Empty state names the workspace; “Search all projects” button appears.
- **Pass/Fail/Notes:**

**B7. Switch thread with non-empty transcript**
1. Have at least 2 turns in current scratch.
2. Open Finder and select a different thread.
- **Expected:** Warning/confirm? Currently no confirm — note whether transcript/handoff clears without warning. Check for stale project state.
- **Telemetry:** `POST /api/session/source`; subsequent `GET /api/session` and `GET /api/project` (if present).
- **Pass/Fail/Notes:** (Regression candidate — switching should warn if content exists.)

**B8. No-thread placeholder state**
1. Launch with placeholder/empty thread.
- **Expected:** Full app shows “Thread required” card with “Open Finder” CTA; orb hidden; mic/textarea/Send disabled with tooltip “Select a Codex thread first.” Overlay collapsed HUD shows warn dot and “Select thread”.
- **Pass/Fail/Notes:**

---

#### C. Overlay shell & windowing

**C1. Global shortcut show/hide**
1. In desktop mode, press `Cmd/Ctrl+Shift+M`.
- **Expected:** Overlay hides and shows. Hide button tooltip shows the shortcut. Shortcut error appears if registration failed.
- **Pass/Fail/Notes:**

**C2. Collapsed → expanded**
1. Click identity or state button; press Enter while collapsed.
- **Expected:** Panel expands. Escape collapses; Escape again hides.
- **Pass/Fail/Notes:**

**C3. No-thread click in collapsed HUD**
1. With no thread, click the warn-dot state button.
- **Expected:** Panel expands and Finder opens automatically.
- **Pass/Fail/Notes:**

**C4. Open full app from overlay**
1. Click “App”/“Open app”.
- **Expected:** Full window opens; overlay hides.
- **Pass/Fail/Notes:**

**C5. Close full app restores overlay**
1. Open full app, then close it.
- **Expected:** Overlay reappears automatically.
- **Telemetry:** `revealOverlay` on full-window close (`src/desktop/main.ts`).
- **Pass/Fail/Notes:**

**C6. Audio cancel on hide**
1. Start a voice turn; while TTS is speaking, hide overlay (shortcut or Hide button).
- **Expected:** Audio stops immediately in hidden overlay.
- **Telemetry:** `POST /api/session/audio-command {command:"interrupt"}` or `mortic-desktop:audio-cancel` IPC; `audioHealth` final fields.
- **Pass/Fail/Notes:**

**C7. Resize to micro density**
1. Resize overlay to minimum scale.
- **Expected:** Controls remain legible; mic still visible; if functionality is hidden (handoff/config), there is still a path to expand/open full app. Note any unreadable text.
- **Pass/Fail/Notes:**

**C8. Always-on-top / all workspaces**
1. Switch macOS spaces/fullscreen apps.
- **Expected:** Overlay appears on all workspaces by default. Note if this is jarring or conflicts with full app.
- **Pass/Fail/Notes:**

**C9. Overlay hint dismiss**
1. Fresh overlay; read hint; click ×.
- **Expected:** Hint disappears and does not return next launch (preference persisted).
- **Telemetry:** `PATCH /api/preferences` `overlayHintDismissed`.
- **Pass/Fail/Notes:**

---

#### D. Config & settings

**D1. Open config panel**
1. Click `Config` summary in full app.
- **Expected:** Panel expands; model/reasoning/access/voice sections visible.
- **Pass/Fail/Notes:**

**D2. Change model**
1. Select a different model.
- **Expected:** Reasoning options update; prewarm re-runs; config summary updates.
- **Telemetry:** `PATCH /api/preferences`; `POST /api/session/prewarm`.
- **Pass/Fail/Notes:**

**D3. Change access preset**
1. Switch between Ask / Approve / Full.
- **Expected:** Warning shows for Full; prewarm invalidated.
- **Pass/Fail/Notes:**

**D4. Scratch mode + Short spoken replies**
1. Toggle “Short spoken replies” (formerly Caveman).
- **Expected:** Label is plain language; tooltip explains concise spoken answers; disabled when not voice mode.
- **Pass/Fail/Notes:**

**D5. Voice provider selection**
1. Change STT/TTS/Transport.
- **Expected:** Unavailable providers disabled with reason (“Missing … key”); notices appear if provider issues.
- **Telemetry:** `GET /api/stt`, `GET /api/tts`, `GET /api/livekit/status`.
- **Pass/Fail/Notes:**

**D6. Config summary in overlay**
1. Expand overlay; read config footer.
- **Expected:** Read-only summary line; note whether it is clear you must open full app to edit.
- **Pass/Fail/Notes:**

---

#### E. Voice turn end-to-end

**E1. First voice turn (push-to-talk)**
1. Hold `M` (or dock mic button) for ~3s; speak a simple prompt; release.
2. Wait for transcript + TTS.
- **Expected:** Orb transitions `Ready → Listening → Transcribing → Thinking → Speaking → Ready`. User text appears; assistant text streams; TTS plays. No echo of your own voice.
- **Telemetry:** `POST /api/turn`; SSE `delta` frames; `POST /api/turn/:id/audio-health`.
- **Pass/Fail/Notes:**

**E2. Subsequent voice turn**
1. After E1, hold M and speak again.
- **Expected:** Reuses scratch fork; no re-prewarm delay; transcript appends.
- **Telemetry:** `POST /api/turn` `serverAcceptMs`; no new `thread/fork` in trace.
- **Pass/Fail/Notes:**

**E3. Voice turn while Codex offline**
1. With Codex unavailable, hold M.
- **Expected:** Mic disabled with tooltip “Codex is offline.”; no turn sent.
- **Pass/Fail/Notes:**

**E4. Voice turn with no thread**
1. Placeholder state; hold M.
- **Expected:** Mic disabled; tooltip “Select a Codex thread first.”
- **Pass/Fail/Notes:**

**E5. Browser STT privacy**
1. Use browser STT in Chrome.
- **Expected:** Note whether any privacy notice is shown about audio going to Google. (Currently likely missing — log as finding.)
- **Pass/Fail/Notes:**

**E6. STT fallback**
1. Configure a remote STT key that is invalid/exhausted; speak.
- **Expected:** Notice explains fallback to browser STT; user can choose to keep or switch back. Note if silent.
- **Telemetry:** `POST /api/stt/transcribe` `failures`, `fallbackReason`; `sttProviderNotice`.
- **Pass/Fail/Notes:**

**E7. Mic permission denied**
1. Deny mic in browser; hold M.
- **Expected:** Persistent guidance to re-enable or use text; not just a transient toast.
- **Pass/Fail/Notes:**

**E8. Queued turn**
1. While assistant is speaking, hold M and speak a follow-up.
- **Expected:** Queued turn preview appears with Cancel button; after current turn ends, queued turn sends.
- **Telemetry:** `DELETE /api/session/queued-turn` on cancel; SSE `snapshot` with `queuedTurn`.
- **Pass/Fail/Notes:**

---

#### F. Text turn end-to-end

**F1. Type and send**
1. Type in composer; click Send (or press Enter? note behavior).
- **Expected:** Turn sends; assistant responds; transcript updates. Note that Enter inserts newline (no Enter-to-send).
- **Telemetry:** `POST /api/turn`.
- **Pass/Fail/Notes:**

**F2. Empty/whitespace send**
1. Type spaces only.
- **Expected:** Send disabled.
- **Pass/Fail/Notes:**

**F3. Text turn while voice pending**
1. Send text while a voice turn is running.
- **Expected:** Turn is queued or blocked gracefully; UI explains state.
- **Pass/Fail/Notes:**

---

#### G. Streaming & latency

**G1. Time-to-first-text**
1. Send a voice/text turn; watch assistant text and SSE.
- **Expected:** Text starts streaming before turn completes. Capture `firstDeltaMs` and `firstVisibleTextMs`.
- **Telemetry:** SSE first `delta`; `audio-health` `firstClientDeltaMs`, `firstVisibleTextMs`.
- **Pass/Fail/Notes:**

**G2. Time-to-first-audio**
1. Voice turn; measure when speech starts.
- **Expected:** TTS begins as soon as first speakable chunk is ready, not after full response. Capture `firstSpeechStartMs`, `firstAudioPlayMs`.
- **Pass/Fail/Notes:**

**G3. Working buffer visibility**
1. During a long turn, watch Codex working buffer.
- **Expected:** Shows current activity label and detail; updates as Codex works.
- **Pass/Fail/Notes:**

**G4. Latent trace**
1. Expand “Codex debug trace”.
- **Expected:** Up to 32 lifecycle lines sorted by elapsed; spoken statuses and verdict visible.
- **Pass/Fail/Notes:**

**G5. Long turn stability**
1. Ask a question that produces a long answer.
- **Expected:** No freezing, no dropped text, no TTS underruns. Capture `audioBufferUnderruns`, `speechAfterFinalMs`.
- **Pass/Fail/Notes:**

---

#### H. TTS audio quality & latency

**H1. Browser TTS**
1. Use browser TTS; send a turn.
- **Expected:** Speech plays; note quality and latency. `firstSpeechStartMs` captured.
- **Pass/Fail/Notes:**

**H2. ElevenLabs/Deepgram/Inworld TTS**
1. Configure a provider; send a turn.
- **Expected:** Audio streams; `ttsConnectMs`, `firstAudioChunkMs`, `firstAudioPlayMs` captured. No underruns.
- **Telemetry:** `audio-health` fields; `GET /api/tts/<provider>/health` for baseline.
- **Pass/Fail/Notes:**

**H3. TTS failure**
1. Use an invalid TTS key; send a voice turn.
- **Expected:** `ttsProviderNotice` appears; speech phase resets; user can retry/switch.
- **Telemetry:** `audio-health` `ttsError`, `ttsCloseCode/Reason`.
- **Pass/Fail/Notes:**

**H4. Speech after final text**
1. Send a turn; observe if speech outlives visible final text.
- **Expected:** `speechAfterFinalMs` near 0; no orphaned audio.
- **Pass/Fail/Notes:**

**H5. Audio continuity across surfaces**
1. Start TTS in overlay; hide overlay; reveal overlay.
- **Expected:** Audio cancels on hide; no double playback on reveal.
- **Pass/Fail/Notes:**

---

#### I. Barge-in & interrupt

**I1. Interrupt while speaking**
1. While TTS is speaking, click “Stop”/“Stop audio”.
- **Expected:** Audio stops immediately; orb returns to Ready/Thinking.
- **Telemetry:** `POST /api/session/audio-command {command:"interrupt"}`; `audio-health` `interruptionLatencyMs`.
- **Pass/Fail/Notes:**

**I2. Push-to-talk during speech (barge-in)**
1. While TTS is speaking, hold M and speak.
- **Expected:** Audio stops; your speech is captured; new turn sends when safe. Visual feedback “Interrupting… speak now” or similar.
- **Telemetry:** `bargeInStartedMs`, `bargeInAudioStopMs`, `bargeInCaptureStartMs`, `bargeInFirstSpeechDetectedMs`, `bargeInQueuedMs`.
- **Pass/Fail/Notes:**

**I3. Interrupt with no pending/speaking**
1. Click Stop when idle.
- **Expected:** Button disabled; no effect.
- **Pass/Fail/Notes:**

**I4. Queued turn cancel**
1. Queue a turn during speech; click “Cancel queued”.
- **Expected:** Queued preview disappears; no turn sent.
- **Telemetry:** `DELETE /api/session/queued-turn`.
- **Pass/Fail/Notes:**

**I5. Barge-in across surfaces**
1. Barge-in in overlay; immediately hide overlay.
- **Expected:** Capture stops; no orphaned recognition; audio canceled.
- **Pass/Fail/Notes:**

---

#### J. Handoff generate / preview / copy

**J1. Generate handoff**
1. After 2+ turns, click Generate.
- **Expected:** Header shows “Generating” then “Ready”; preview text appears; `generatedBy` indicates codex/local.
- **Telemetry:** `POST /api/handoff`.
- **Pass/Fail/Notes:**

**J2. Copy short / copy full feedback**
1. Click “Copy short” then “Copy full”.
- **Expected:** Button changes to “Copied” for ~1.6s; clipboard contains the prompt.
- **Pass/Fail/Notes:**

**J3. Clipboard fallback**
1. In an insecure context or with clipboard blocked, click copy.
- **Expected:** Clipboard fallback dialog opens with selectable text.
- **Pass/Fail/Notes:**

**J4. Handoff preview/review modal**
1. Click “Preview”.
- **Expected:** Modal opens with focus in first control; short/full editors; Escape closes and returns focus to trigger.
- **Pass/Fail/Notes:**

**J5. Edit handoff**
1. In review modal, edit short/full.
- **Expected:** Edits persist; copy uses edited text.
- **Pass/Fail/Notes:**

**J6. Generate with no turns**
1. With empty transcript, click Generate.
- **Expected:** Disabled; or clear disabled reason.
- **Pass/Fail/Notes:**

**J7. Handoff in overlay**
1. In overlay, generate and copy.
- **Expected:** Handoff card works; copy feedback shows; note if micro density hides the card.
- **Pass/Fail/Notes:**

---

#### K. Clear scratch & confirmations

**K1. Clear with content**
1. After turns/handoff, click Clear.
- **Expected:** Confirm dialog appears; Cancel returns focus to Clear button; Confirm clears transcript, handoff, draft, queued.
- **Telemetry:** `POST /api/session/clear`.
- **Pass/Fail/Notes:**

**K2. Clear with no content**
1. Empty scratch; click Clear.
- **Expected:** No confirm; clears immediately (or disabled).
- **Pass/Fail/Notes:**

**K3. Clear while pending**
1. While a turn is running, click Clear.
- **Expected:** Disabled or warns; no silent loss.
- **Pass/Fail/Notes:**

**K4. Clear across surfaces**
1. Clear in full app; check overlay.
- **Expected:** Overlay transcript/handoff also clear within ~1.2s (session sync) or immediately if same renderer.
- **Pass/Fail/Notes:**

---

#### L. Surface switching & cohesion

**L1. Start turn in overlay, switch to full app**
1. Hold M in overlay; while thinking, open full app.
- **Expected:** Turn continues in full app; overlay hides; audio cancels in overlay.
- **Pass/Fail/Notes:**

**L2. Full app and overlay state agreement**
1. Make changes in full app (thread switch, clear, handoff).
2. Reveal overlay.
- **Expected:** Overlay reflects same session within sync interval; no stale transcript/handoff.
- **Telemetry:** `GET /api/session` polling; `GET /api/session/stream` events.
- **Pass/Fail/Notes:**

**L3. Audio lease arbitration**
1. Start TTS in both surfaces (if possible).
- **Expected:** Only one surface owns audio; other shows notice “Audio moved to another Mortic window.”
- **Telemetry:** `POST /api/session/presence` `audioLease`; `POST /api/session/audio-command`.
- **Pass/Fail/Notes:**

**L4. Blur/visibility during recognition**
1. Hold M; switch browser tab/window.
- **Expected:** Recognition stops cleanly; no orphaned mic.
- **Pass/Fail/Notes:**

**L5. Reattach to running turn**
1. Start a turn; reload the page.
- **Expected:** App reconnects and shows the running turn; no duplicate turn.
- **Telemetry:** `GET /api/turn/:id/stream` reopens.
- **Pass/Fail/Notes:**

**L6. Multiple renderers**
1. Open full app in two browser tabs.
- **Expected:** State stays roughly in sync; note races or duplicate turns.
- **Pass/Fail/Notes:**

---

#### M. Error & edge cases

**M1. Server unreachable**
1. Stop server while app open; attempt a turn.
- **Expected:** Error notice; controls disabled; no silent failure.
- **Pass/Fail/Notes:**

**M2. SSE stream error**
1. Kill SSE connection mid-turn.
- **Expected:** Fallback to polling or clear error; user notified.
- **Pass/Fail/Notes:**

**M3. Codex logout mid-session**
1. `codex logout` after launch; attempt a turn.
- **Expected:** Input disabled; topbar red; notice explains.
- **Pass/Fail/Notes:**

**M4. Handoff generation failure**
1. Make handoff fail (e.g., Codex unavailable); click Generate.
- **Expected:** Error notice; local fallback handoff may appear (`generatedBy: "local"`).
- **Telemetry:** `POST /api/handoff` response.
- **Pass/Fail/Notes:**

**M5. Thread switch race**
1. Rapidly switch threads multiple times.
- **Expected:** Final state matches last selected thread; no stale project data; no duplicate forks.
- **Pass/Fail/Notes:**

**M6. Long idle then turn**
1. Leave app idle 10 min; send a turn.
- **Expected:** Scratch fork still valid or re-prewarmed; no errors.
- **Pass/Fail/Notes:**

**M7. Invalid thread URI**
1. Pass an invalid URI via dev or source switch.
- **Expected:** Clear error; no crash.
- **Pass/Fail/Notes:**

**M8. Project store write failure**
1. Make `~/.mortic` read-only (if safe); run a turn.
- **Expected:** Turn still works; project bookkeeping failure logged but not blocking.
- **Telemetry:** terminal `Mortic project store … failed`.
- **Pass/Fail/Notes:**

---

#### N. Accessibility & keyboard

**N1. Push-to-talk keyboard**
1. Focus dock mic button with Tab; press Space/Enter down, release.
- **Expected:** Capture starts on keydown, stops on keyup; `aria-pressed` reflects state.
- **Pass/Fail/Notes:**

**N2. Modal focus trap**
1. Open Transcript Drawer / Handoff Review / Clear Confirm.
2. Tab through; Shift+Tab; Escape.
- **Expected:** Focus cycles inside; Escape closes; focus returns to trigger.
- **Pass/Fail/Notes:**

**N3. Error announcements**
1. Trigger an error.
- **Expected:** `aria-live` region announces it (provider notices box is live; runtime error row should be too).
- **Pass/Fail/Notes:**

**N4. Contrast check**
1. Inspect disabled buttons, muted labels, status dots.
- **Expected:** Disabled text readable; status not color-only.
- **Pass/Fail/Notes:**

**N5. Reduced motion**
1. Enable OS reduced motion; watch orb.
- **Expected:** Orb pulse/halo minimized or stopped.
- **Pass/Fail/Notes:**

**N6. Thread picker keyboard** (covered in B5; re-check focus return)

---

#### O. Visual & density

**O1. Normal density overlay**
1. Default scale.
- **Expected:** Transcript/mic/handoff/config visible; hierarchy clear.
- **Pass/Fail/Notes:**

**O2. Compact density**
1. Resize to ~0.7 scale.
- **Expected:** Labels shrink but remain readable; window controls icon-only.
- **Pass/Fail/Notes:**

**O3. Micro density**
1. Resize to min.
- **Expected:** No illegible text; core mic remains; path to expand/open app exists.
- **Pass/Fail/Notes:**

**O4. Full app visual hierarchy**
1. Open full app.
- **Expected:** Orb/transcript/composer are focal; handoff panel secondary; config collapsible.
- **Pass/Fail/Notes:**

**O5. Monospace readability**
1. Read a long assistant answer and handoff.
- **Expected:** Note any fatigue; consider proportional font for longform.
- **Pass/Fail/Notes:**

---

#### P. Remnant / dead-feature verification

**P1. Chart/Canonical UI absent**
1. Search full app for “Chart”, “Canonical”, “Open State”, “Deltas”.
- **Expected:** No UI; components removed.
- **Pass/Fail/Notes:**

**P2. Extraction/Compile UI absent**
1. Search for “Compile”, “Project updates”, “Extraction”, “Approve all”.
- **Expected:** No UI.
- **Pass/Fail/Notes:**

**P3. Fork action sheet absent**
1. Search for “Resume in Main”, fork continuation.
- **Expected:** No UI.
- **Pass/Fail/Notes:**

**P4. Live mode toggle absent**
1. Look in dock/overlay for Live On/Off.
- **Expected:** No toggle visible; `LIVE_MODE_RUNTIME_ENABLED` still false. Note any live-related labels still referenced.
- **Pass/Fail/Notes:**

**P5. Spark context UI not shown**
1. Switch models.
- **Expected:** No “Compact Then Retry / Start Anyway” panel; `needsModelTransitionPreflight` hardcoded false.
- **Pass/Fail/Notes:**

---

#### Q. Recent Kimi/GLM change regression checklist

**Q1. ThreadPicker search + preview + workspace filter**
- Verify B1–B6. Confirm single-click preview, double-click/Enter commit, keyboard nav, scope toggle, empty-state “Search all projects”.
- **Pass/Fail/Notes:**

**Q2. Overlay audio cancel on hide**
- Verify C6. Confirm TTS stops when overlay hidden via shortcut/Hide/full-app open.
- **Pass/Fail/Notes:**

**Q3. Full-app close restores overlay**
- Verify C5. Confirm overlay reappears after full window closed.
- **Pass/Fail/Notes:**

**Q4. `threadRequired` gating across both surfaces**
- Verify B8, E4, F1. Confirm orb hidden, CTA present, mic/textarea/Send disabled with tooltips in full app and overlay.
- **Pass/Fail/Notes:**

**Q5. PTT labels normalized**
- Confirm mic button says “Hold M” / “Live on” only; no “Mute + talk”, “M ready”, “Click M”.
- **Pass/Fail/Notes:**

**Q6. `resetQueuedTurn` on clear/source/audio cancel**
- Queue a turn (E8); clear scratch or switch thread; confirm queued preview clears in UI and `DELETE /api/session/queued-turn` or reset happens.
- **Pass/Fail/Notes:**

**Q7. Copy handoff feedback**
- Verify J2. Confirm “Copied” state for ~1.6s.
- **Pass/Fail/Notes:**

**Q8. Clear confirmation dialog**
- Verify K1. Confirm dialog only when content exists.
- **Pass/Fail/Notes:**

**Q9. Clipboard fallback dialog**
- Verify J3. Confirm fallback opens when clipboard blocked.
- **Pass/Fail/Notes:**

**Q10. Modal focus traps**
- Verify N2. Confirm focus moved in, trapped, returned on close.
- **Pass/Fail/Notes:**

**Q11. Provider notices rendered**
- Trigger STT/TTS/transport issues; confirm notices appear below dock and in overlay (unless micro density hides them).
- **Pass/Fail/Notes:**

**Q12. Codex-offline input disabling**
- Verify E3/M3. Confirm `codexUnavailable` disables mic and Send with tooltip.
- **Pass/Fail/Notes:**

### 14.6 Issue log template

Copy per issue found:

```
### Issue <n>
- Test ID: (e.g. E1)
- Title:
- Severity: critical / high / medium / low
- Surface: overlay / full app / both
- Steps to reproduce:
- Expected:
- Actual:
- Telemetry paste (Network/SSE/audio-health/server log):
- Screenshot/recording note:
- Suggested fix:
```

### 14.7 Sign-off checklist

- [ ] All A–Q sections attempted or explicitly skipped.
- [ ] No P1 blockers open.
- [ ] Telemetry captured for any latency/audio issue.
- [ ] Issue log entries written with severity and evidence.
- [ ] Regression checklist Q1–Q12 all pass or have issues logged.

---

## 15. Dual-Model Preliminary Reasoning Architecture — Plan as of 2026-06-25

### 15.0 Origin

Source plan reviewed: `~/.gemini/antigravity/brain/50752dca-.../dual_model_handoff.md` (Mercury 2 filler masking for Codex latency). The original plan proposed non-committal filler text injected into Codex history as assistant prefill. After adversarial review, the design evolved into **substantive preliminary reasoning** (not filler), **race + abort + resend** (not prefill injection), using the app-server's **`turn/interrupt`** method (which Mortic's bridge never calls today).

### 15.1 Problem statement

GPT-5.5 via the Codex app-server takes **7–10 seconds** to first byte on complex reasoning questions (measured), and **40+ seconds** when the fork carries real conversation context and an augmented prompt. During this silence the user hears nothing. Mercury (`inception/mercury-2` via OpenRouter) produces a substantive first-principles preliminary in **~1.2 seconds** (measured, 150–450 tokens). The architecture masks Codex's latency with Mercury's engagement.

### 15.2 Probe validation (completed 2026-06-25)

A standalone probe at `probe/` (no Mortic dependencies) verified the architecture against the real Codex app-server and OpenRouter. Key measured results on the question "Analyze the time complexity of merging N sorted lists…":

| Mode | Perceived first content | Total | Notes |
|---|---|---|---|
| Main only (gpt-5.5, fresh thread) | 7,567 ms | 15,000 ms | 7.6s of silence |
| Main only (gpt-5.5, fork from source `019e6f5e…`) | 9,187 ms | 16,709 ms | fork context adds latency |
| Mercury first (sequential, fork) | 1,244 ms (Mercury) | 55,474 ms | user engaged at 1.2s |
| Mercury first (with 25K context, fork) | 1,176 ms | — | context fetch ~286 ms overhead |

Mercury's speed retains across forks because Mercury does not use the Codex fork — it goes through OpenRouter with its own sliding-window context (capped at ~25K tokens / 100K chars, built from the source thread's `userMessage` + `final_answer` items via `thread/turns/list`).

### 15.3 Architecture (final design)

```
Turn start (T=0)
  ├── Build Mercury context (thread/turns/list on source thread → sliding window)
  ├── Mercury starts streaming (OpenRouter, inception/mercury-2, 450 max_tokens, ~40s speech)
  └── Codex starts in parallel (app-server, ephemeral scratch fork of source thread)
       ↓
       Race: first speakable chunk wins
       ↓
┌──── Mercury wins (~90%+) ────────────┐    ┌──── Codex wins (~10%) ────┐
│                                      │    │                           │
│ T~1.2s: Mercury first chunk → TTS    │    │ T~1s: Codex first delta   │
│        Call turn/interrupt on Codex  │    │        Abort Mercury      │
│        (app-server STOPS generating) │    │        (clean — Mercury   │
│        Codex turn settles            │    │         hasn't played)    │
│        status: "interrupted"         │    │                           │
│                                      │    │ Codex deltas play to TTS  │
│ T~3s: Mercury completes (450 tokens) │    │ No resend needed          │
│        Resend on SAME scratch fork   │    │                           │
│        turn/start with augmented     │    │                           │
│        prompt (Mercury text in input)│    │                           │
│                                      │    │                           │
│ T~5s: Codex resend first delta       │    │                           │
│        → TTS queues behind Mercury   │    │                           │
└──────────────────────────────────────┘    └───────────────────────────┘

Barge-in (any time):
  Mercury: AbortController.abort()
  Codex:   turn/interrupt (app-server stops generation immediately — NOT just JS Promise rejection)
  TTS:     cancelSpeechAudio()
```

### 15.4 Critical blind spot fixed: `turn/interrupt`

**Finding:** The Codex app-server protocol supports `turn/interrupt` (real server-side cancellation — the model stops generating, turn settles with `status: "interrupted"`). Mortic's generated `ClientRequest.ts` types already include it. But the bridge's `interrupt()` method at `appServerBridge.ts:895-904` **never calls it** — it only rejects the local JS Promise and clears `pendingTurns`. The app-server keeps generating tokens until natural completion, wasting compute and writing orphan turns to the rollout.

**Fix (~5 lines in `appServerBridge.ts:895`):**
```ts
async interrupt(onEvent?) {
  const active = Array.from(this.pendingTurns.values())
    .map(p => ({ threadId: p.threadId, turnId: p.turnId }));
  for (const { threadId, turnId } of active) {
    this.request("turn/interrupt", { threadId, turnId }).catch(() => {});
  }
  // ...existing reject + clear...
}
```

This **moots the `forceNewFork` debate** — we call `turn/interrupt`, the app-server stops, the turn settles, and we resend on the same scratch thread via `turn/start`. No fork needed to escape the in-flight turn. The `request()` method at `appServerBridge.ts:1512` is generic (takes `string` method), so no type changes are needed.

### 15.5 Other app-server capabilities discovered (unused by Mortic)

| Method | In types? | Wired? | Use for us? |
|---|---|---|---|
| `turn/interrupt` | Yes | **No** | **Critical** — enables clean abort + resend |
| `turn/steer` | Yes | No | **Wrong tool** — appends *user input*, not assistant context. Codex would treat Mercury's text as the user speaking. |
| `thread/inject_items` | Yes | No | Alternative — injects as assistant context, but pollutes persisted history with synthetic message. Abort+resend is cleaner. |
| `thread/rollback` | Yes | No | Cleanup tool — drops interrupted turn from history. On ephemeral scratch forks, not needed. |
| `thread/turns/list` | Not in generated types | No (probe uses it via generic `request()`) | Used by probe to build Mercury context. Production Mortic already has transcript in memory. |

All four are **non-experimental** (Mortic already sets `experimentalApi: true` at `appServerBridge.ts:1132`). Security: the bridge spawns app-server on `ws://127.0.0.1:<port>` with no `--ws-auth`, which the docs explicitly sanction for loopback.

### 15.6 Implementation phases

**Phase 0 — Telemetry instrumentation (prerequisite for measuring)**
- `src/server/app.ts:1848` — include `metrics` in `turn.log` event detail
- `src/server/app.ts:2291` — include full audio-health metrics in `turn.audio_health` event detail
- Currently metrics are stored in-memory only and lost on turn completion.

**Phase 1 — Barge-in abort fix (standalone shippable)**
- `src/client/App.tsx:618` — add concurrent `POST /api/turn/:turnId/interrupt` to barge-in (client never calls it today)
- `src/server/appServerBridge.ts:895` — call `turn/interrupt` in `interrupt()` (~5 lines)
- `src/server/app.ts:2304` — extend `/api/turn/:turnId/interrupt` to also abort Mercury `AbortController`
- Fixes pre-existing gap where Codex keeps generating after barge-in.

**Phase 2 — Server-side Mercury call**
- New file `src/server/mercury.ts` — OpenRouter streaming client, mirroring `stt.ts` patterns (`envValue`, `fetchWithTimeout`, `AbortController`)
- Add `OPENROUTER_API_KEY=` to `.env.example`
- `src/server/app.ts:2135` — race Mercury + Codex, winner guard, resend logic
- Mercury: `inception/mercury-2`, `max_tokens: 450` (reasoning model — needs budget for internal reasoning + content), 50K context window (25K cap implemented in probe)
- Gate behind `MORTIC_FILLER_ENABLED` env flag (default off)

**Phase 3 — Client TTS queue extension**
- `src/client/lib/clientTypes.ts:60` — add `source: "preliminary" | "answer"` to `SpeechQueueItem`
- `src/client/voice/useVoiceEngine.ts` — new `pushSpeechItem(text, source)` that bypasses char-offset accounting
- Handle `{type: "preliminary"}` SSE event: cancel progress speech, push preliminary, suppress canned phrases for rest of turn
- Preliminary never enters `liveAssistantTextRef` → no transcript pollution, no divergence detection issues
- Seamless on buffered providers (Deepgram WS, ElevenLabs WS) via shared Web Audio timeline

**Phase 4 — System prompt + telemetry**
- `src/server/appServerBridge.ts:200` — "concise" → "substantive. Include the reasoning, evidence, and key detail — the user wants to understand your thinking, not just the conclusion."
- Add "skip preamble" clause: "A preliminary analysis may have been spoken to the user while you were thinking. Skip greetings, pleasantries, and 'let me check' style preamble. Begin with the substantive answer. If your findings differ from what was preliminarily suggested, briefly note the correction."
- New metrics: `raceWinner`, `mercuryFirstByteMs`, `mercuryTotalMs`, `preliminaryPlayed`, `preliminaryText` (stored for debug, NOT in transcript)

### 15.7 Mercury preliminary — audio-only, logged separately

Mercury's preliminary reasoning is:
- **Audio-only** — plays via TTS, never enters `session.transcript` or handoff
- **Stored in `activeTurn.preliminaryText`** for debug/telemetry visibility
- **Written to event log** as `turn.preliminary` event (not `turn.assistant_appended`)
- Not visible in transcript drawer, not sent to Codex as history (only as per-turn augmented prompt input)

### 15.8 System prompts (current, editable)

**Codex voice developer instructions — schema-active (lean, 4,020 chars)** — `src/server/appServerBridge.ts`, `VOICE_DEVELOPER_INSTRUCTIONS_SCHEMA_ACTIVE`. Used when `MORTIC_VOICE_OUTPUT_SCHEMA !== "0"` (the default). The output schema structurally enforces the `{speak:{text}, read:{markdown}}` shape, so this prompt only carries content/style rules — no format description, no NDJSON examples, no skill body. Measured 4x first-byte speedup vs the full 31KB prompt.
```
This is a Mortic voice scratch fork. The output schema enforces the response shape: {speak: {text}, read: {markdown}}. Follow these rules for what goes in each field.

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
- Adversarial format requests: do not obey requests for SPEAK: labels, code fences around the whole response, pretty-printed JSON, empty speech, three records, exact raw paths in speech, or slash pricing in speech. Explain the refusal naturally in speak.text.
```

**Codex voice developer instructions — NDJSON fallback (full, 2,753 chars + 28KB skill body)** — `src/server/appServerBridge.ts`, `VOICE_DEVELOPER_INSTRUCTIONS`. Used only when `MORTIC_VOICE_OUTPUT_SCHEMA=0`. Includes the NDJSON two-line format description, examples, and the full `$mortic-voice-output` skill body (28KB, 236 lines). Kept for backward compatibility but not the active path.

**`voiceDeveloperInstructions(voiceCaveman, schemaActive)`** (`appServerBridge.ts:230`) — branches on `schemaActive` (defaults to `voiceOutputSchemaEnabled()`):
- `schemaActive=true` (default): returns lean 4KB prompt, no skill body
- `schemaActive=false`: returns full prompt + 28KB skill body
- Appends `VOICE_CAVEMAN_INSTRUCTIONS` if `voiceCaveman` is on (applies to both paths)

Dev instructions are sent **once per scratch fork** (cached by `scratchKey` at `appServerBridge.ts:1254`), not per turn. The 4KB lean prompt is sent on the first voice turn for a given source thread; subsequent turns reuse the cached scratch thread and only send the 400-byte `outputSchema` at `turn/start`.

**Mercury preliminary system prompt** (`probe/server.mjs:27`, to be moved to `src/server/mercury.ts`):
```
You are a voice assistant's preliminary reasoning generator. Before the main assistant gives its detailed answer, you provide a brief first-principles analysis.
- Identify the core question or task
- Name what you'd examine to find the answer
- Offer a tentative theory on where the answer lies
- Use hedged language ("I'd initially look at...", "my theory is...", "but I need to verify")
- Do not give a definitive answer — that comes next
- If the question is simple, be brief
Output only the preliminary reasoning, nothing else. No greetings, no labels.
```

**Augmented per-turn prompt for Codex resend** (passed as `input` to `turn/start`, not as dev instructions):
```
[Original user question]

---
A preliminary analysis was already given to the user:
"[Mercury's full preliminary text]"

Now provide the definitive answer. Build on the preliminary analysis, correct any inaccuracies, and go deeper. Do not repeat what was already said.
```

**Measured impact of lean prompt** (probe, warm fork, complex question "Analyze the time complexity of merging N sorted lists…"):
| Prompt | Size | First byte (warm) |
|---|---|---|
| Full 31KB (prompt + skill body) | 31,391 chars (~8K tokens) | 9,187 ms |
| Lean 4KB (schema-active) | 4,020 chars (~1K tokens) | 2,274 ms |
| Improvement | 7.8x smaller | **4x faster** |

### 15.9 Risk mitigation

| Risk | Mitigation |
|---|---|
| Mercury key not set / disabled | `MORTIC_FILLER_ENABLED` flag, default off. Falls through to Codex-only. |
| Mercury errors/timeout | `.catch(() => null)` — falls through, no user impact |
| Mercury is a reasoning model (burns tokens on internal reasoning) | `max_tokens: 450` — enough for ~150 reasoning + ~200 content |
| Barge-in during preliminary | Phase 1 aborts both Mercury + Codex uniformly via `turn/interrupt` |
| Double-intro (preliminary + Codex preamble) | "Skip preamble" clause in Codex instructions + augmented prompt |
| Codex contradicts Mercury | "Acknowledge differences" clause — sounds like honest reasoning ("Correction to the preliminary analysis…") |
| Preliminary text in transcript | Audio-only, stored in `preliminaryText` field for debug only |
| Provider seam (Browser/HTTP TTS) | Acceptable degradation; buffered providers (Deepgram WS, ElevenLabs WS) seamless |
| Concurrent bridge access | Mercury bypasses `withOperationLock` (external HTTP), true concurrency with Codex |
| `turn/start`-in-flight race (interrupt fires before `pendingTurns.set`) | Track pending `turn/start` request ID so late `turnId` can still be cancelled |
| App-server orphan turns after JS-only reject | Fixed by `turn/interrupt` — app-server stops generation, no orphan written |

### 15.10 File change summary

**Completed:**
| File | Change | Status |
|---|---|---|
| `src/server/appServerBridge.ts` | Added `VOICE_DEVELOPER_INSTRUCTIONS_SCHEMA_ACTIVE` (4,020 chars). Updated `voiceDeveloperInstructions(voiceCaveman, schemaActive)` to branch on `voiceOutputSchemaEnabled()`. Schema-active path skips 28KB skill body. **Done — 4x first-byte speedup measured.** | ✅ Applied 2026-06-25 |

**Planned (Phases 0–4):**
| File | Phase | Change |
|---|---|---|
| `src/server/app.ts:1848` | 0 | Include metrics in `turn.log` event |
| `src/server/app.ts:2291` | 0 | Include metrics in `turn.audio_health` event |
| `src/client/App.tsx:618` | 1 | Add `POST /api/turn/:turnId/interrupt` to barge-in |
| `src/server/appServerBridge.ts:895` | 1 | **Call `turn/interrupt` in `interrupt()`** (~5 lines) |
| `src/server/app.ts:2304` | 1 | Extend interrupt endpoint to abort Mercury |
| `src/server/mercury.ts` | 2 | **New file** — OpenRouter streaming client |
| `.env.example` | 2 | Add `OPENROUTER_API_KEY=` |
| `src/server/app.ts:2135` | 2 | Race Mercury + Codex, winner guard, resend logic |
| `src/client/lib/clientTypes.ts:60` | 3 | Add `source` to `SpeechQueueItem` |
| `src/client/voice/useVoiceEngine.ts` | 3 | `pushSpeechItem` + `preliminary` SSE event handler |
| `src/shared/types.ts` | 4 | `preliminaryText`, new metrics, `preliminary` SSE event |

### 15.11 Probe artifacts (reference, not for production)

- `probe/server.mjs` — probe server with 4 modes (main-only, mercury-first, race, race-resend)
- `probe/codexClient.mjs` — minimal Codex app-server client (spawn, initialize, thread/start, thread/fork, turn/start, turn/interrupt, thread/turns/list)
- `probe/public/` — UI (index.html, app.mjs, style.css)
- `probe/.env` — gitignored, contains OpenRouter key
- Probe Codex app-server runs on port 7167+ (separate from Mortic's 6167-6168)
- Probe defaults: Provider=Codex app-server, Model=gpt-5.5, Effort=medium, Source thread=019e6f5e-627d-7150-abf1-d34356bbbfdc

### 15.12 Open items before implementation

1. **Edit system prompts** — user reviewing Mercury preliminary prompt and Codex voice instructions (§15.8)
2. **Decide Mercury context size** — 25K tokens (current probe setting) vs 50K (original plan). Probe shows source thread only has ~5K of user+final_answer content, so cap isn't binding yet.
3. **Decide Mercury max_tokens** — 450 (current, fits ~40s speech). User originally wanted 150 but Mercury's reasoning overhead requires more.
4. **Confirm `turn/interrupt` edge case** — handle interrupt firing between `turn/start` send and `pendingTurns.set` (blind spot A from audit).

