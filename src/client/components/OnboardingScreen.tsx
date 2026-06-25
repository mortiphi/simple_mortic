import type { OnboardingStatusResponse } from "../../shared/types.js";

export type OnboardingScreenProps = {
  status: OnboardingStatusResponse;
  busy: boolean;
  onRecheck: () => void;
};

function stepStateClass(done: boolean): string {
  return done ? "onboarding-step onboarding-step-done" : "onboarding-step onboarding-step-todo";
}

export function OnboardingScreen({ status, busy, onRecheck }: OnboardingScreenProps) {
  const provider = status.provider;
  const codexInstalled = provider.available;
  const loggedIn = codexInstalled && provider.loginStatus !== "logged-out";

  return (
    <div className="modal-backdrop onboarding-backdrop" role="presentation">
      <section className="onboarding-card" role="dialog" aria-modal="true" aria-label="Mortic setup">
        <h2>Set up Mortic</h2>
        <p className="onboarding-intro">
          Mortic drives the Codex CLI for voice turns and handoff prompts. Finish the steps below, then check again.
        </p>
        <ol className="onboarding-steps">
          <li className={stepStateClass(codexInstalled)}>
            <span className="onboarding-step-mark" aria-hidden="true">{codexInstalled ? "✓" : "1"}</span>
            <div>
              <strong>Install the Codex CLI</strong>
              {codexInstalled ? (
                <span className="onboarding-step-detail">
                  Found {provider.version ?? "codex"} at {provider.path}
                </span>
              ) : (
                <span className="onboarding-step-detail">
                  <code>codex</code> was not found on PATH. Install it with <code>npm install -g @openai/codex</code>, then check again.
                  {provider.error ? <em className="onboarding-step-error">{provider.error}</em> : null}
                </span>
              )}
            </div>
          </li>
          <li className={stepStateClass(loggedIn)}>
            <span className="onboarding-step-mark" aria-hidden="true">{loggedIn ? "✓" : "2"}</span>
            <div>
              <strong>Log in to Codex</strong>
              {loggedIn ? (
                <span className="onboarding-step-detail">
                  Logged in{provider.accountId ? ` as ${provider.accountId}` : ""}
                </span>
              ) : (
                <span className="onboarding-step-detail">
                  Run <code>{provider.loginCommand ?? "codex login"}</code> in a terminal, then check again.
                </span>
              )}
            </div>
          </li>
        </ol>
        <div className="onboarding-actions">
          <button type="button" onClick={onRecheck} disabled={busy}>
            {busy ? "Checking…" : "Check again"}
          </button>
        </div>
      </section>
    </div>
  );
}
