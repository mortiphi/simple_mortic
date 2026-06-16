import { useState } from "react";

import type {
  ProviderForkContinuation,
  ProviderForkRecord,
  ScratchSessionNode
} from "../../shared/types.js";
import { redactThreadId } from "../../shared/threadUri.js";
import { chartDateLabel } from "../lib/labels.js";

const continuationOptions: Array<{
  value: ProviderForkContinuation;
  label: string;
  detail: string;
  dangerous?: boolean;
}> = [
  {
    value: "scratch",
    label: "Scratch",
    detail: "Default. Ephemeral fork — turns never touch the main thread."
  },
  {
    value: "resumable",
    label: "Resumable",
    detail: "Keep this fork as a persisted side thread you can come back to."
  },
  {
    value: "resume-in-main",
    label: "Resume in Main",
    detail: "Continue this work in the main Codex thread.",
    dangerous: true
  }
];

export type ForkActionSheetProps = {
  scratch: ScratchSessionNode;
  fork: ProviderForkRecord | null;
  pending: boolean;
  onSelect: (providerRefId: string, continuation: ProviderForkContinuation) => void;
  onClose: () => void;
};

export function ForkActionSheet({ scratch, fork, pending, onSelect, onClose }: ForkActionSheetProps) {
  const [armedMainResume, setArmedMainResume] = useState(false);
  const requested = (fork?.requestedAccessPreset as ProviderForkContinuation | undefined) ?? "scratch";

  function choose(option: (typeof continuationOptions)[number]) {
    if (!fork) return;
    if (option.dangerous && !armedMainResume) {
      setArmedMainResume(true);
      return;
    }
    setArmedMainResume(false);
    onSelect(fork.providerRefId, option.value);
  }

  return (
    <div className="modal-backdrop fork-sheet-backdrop" role="presentation" onClick={onClose}>
      <section className="fork-action-sheet" role="dialog" aria-modal="true" aria-label="Fork actions" onClick={(event) => event.stopPropagation()}>
        <div className="fork-sheet-header">
          <div>
            <span>Fork</span>
            <h2>{scratch.title || "Scratch fork"}</h2>
          </div>
          <button type="button" onClick={onClose}>Close</button>
        </div>
        <div className="fork-sheet-meta">
          <span>{scratch.ephemeral ? "ephemeral" : "local"}</span>
          <span>{scratch.mode}</span>
          <span>{chartDateLabel(scratch.updatedAt)}</span>
          {scratch.codexScratchThreadId && <code>{redactThreadId(scratch.codexScratchThreadId)}</code>}
        </div>
        {fork ? (
          <>
            <div className="fork-sheet-access">
              <div>
                <span>Requested</span>
                <strong>{requested}</strong>
              </div>
              <div>
                <span>Effective</span>
                <strong>{fork.effectiveAccessPreset ?? "fork default"}</strong>
              </div>
            </div>
            {fork.accessCanChange === false && fork.accessDisabledReason && (
              <p className="fork-sheet-note">{fork.accessDisabledReason} Requested mode is recorded for future fork upgrades.</p>
            )}
          </>
        ) : (
          <p className="fork-sheet-note">No fork record yet — open Chart once to sync the fork tree.</p>
        )}
        <div className="fork-sheet-options">
          {continuationOptions.map((option) => {
            const selected = requested === option.value;
            const armed = option.dangerous && armedMainResume;
            return (
              <button
                key={option.value}
                type="button"
                className={`fork-sheet-option ${selected ? "fork-option-selected" : ""} ${option.dangerous ? "fork-option-danger" : ""} ${armed ? "fork-option-armed" : ""}`}
                disabled={!fork || pending}
                onClick={() => choose(option)}
              >
                <strong>
                  {armed ? "Confirm: resume in main thread" : option.label}
                  {selected && !armed ? " · current" : ""}
                </strong>
                <span>
                  {armed
                    ? "Future work for this fork targets the main Codex thread. Click again to confirm."
                    : option.detail}
                </span>
              </button>
            );
          })}
        </div>
        {armedMainResume && (
          <button type="button" className="fork-sheet-cancel" onClick={() => setArmedMainResume(false)}>
            Cancel main-thread resume
          </button>
        )}
      </section>
    </div>
  );
}
