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
  const skillErrors = status.skills.filter((skill) => skill.action === "error");
  const keptCopies = status.skills.filter((skill) => skill.action === "kept-user-copy");
  const skillsOk = skillErrors.length === 0;

  return (
    <div className="modal-backdrop onboarding-backdrop" role="presentation">
      <section className="onboarding-card" role="dialog" aria-modal="true" aria-label="Mortic setup">
        <h2>Set up Mortic</h2>
        <p className="onboarding-intro">
          Mortic drives the Codex CLI for voice turns and Compile. Finish the steps below, then check again.
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
          <li className={stepStateClass(skillsOk)}>
            <span className="onboarding-step-mark" aria-hidden="true">{skillsOk ? "✓" : "3"}</span>
            <div>
              <strong>Mortic skills</strong>
              {skillsOk ? (
                <span className="onboarding-step-detail">Compile and voice-output skills are synced to ~/.codex/skills</span>
              ) : (
                <span className="onboarding-step-detail">
                  Skill sync failed:
                  {skillErrors.map((skill) => (
                    <em key={skill.skill} className="onboarding-step-error">
                      {skill.skill}: {skill.detail ?? "unknown error"}
                    </em>
                  ))}
                </span>
              )}
            </div>
          </li>
        </ol>
        {keptCopies.length > 0 && (
          <p className="onboarding-note">
            Kept your edited cop{keptCopies.length === 1 ? "y" : "ies"} of {keptCopies.map((skill) => skill.skill).join(", ")} — Mortic never overwrites skills you changed.
          </p>
        )}
        <div className="onboarding-actions">
          <button type="button" onClick={onRecheck} disabled={busy}>
            {busy ? "Checking…" : "Check again"}
          </button>
        </div>
      </section>
    </div>
  );
}
