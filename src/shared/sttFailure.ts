import type { SttProvider, SttProviderFailure } from "./types.js";

// Phrases that mean a provider rejected the request for billing reasons.
// Matched per provider failure, never against the joined fallback string,
// so an out-of-credits fallback provider cannot be blamed on the requested one.
const CREDIT_ERROR_PHRASES = [
  "no credits remaining",
  "add credits",
  "insufficient credits",
  "does not have enough credits",
  "quota",
  "billing"
];

export function isSttCreditError(message: string): boolean {
  const clean = message.toLowerCase();
  return CREDIT_ERROR_PHRASES.some((phrase) => clean.includes(phrase));
}

export type SttFailureAttribution = {
  // The provider whose own message matched a billing phrase, if any.
  creditProvider?: SttProviderFailure["provider"];
  // True only when the REQUESTED provider itself failed for billing reasons;
  // that is the only case where auto-switching to browser STT is justified.
  switchToBrowser: boolean;
  // The requested provider's own failure message when known.
  requestedMessage?: string;
};

export function attributeSttFailure(
  requestedProvider: SttProvider,
  failures: SttProviderFailure[],
  joinedMessage: string
): SttFailureAttribution {
  const requestedFailure = failures.find((failure) => failure.provider === requestedProvider);
  const creditFailure = failures.find((failure) => isSttCreditError(failure.message));

  if (failures.length === 0) {
    // No structured detail (old server or transport error): the joined
    // message is all we have, and it can only be about the requested provider.
    return {
      creditProvider: isSttCreditError(joinedMessage) ? requestedProvider : undefined,
      switchToBrowser: isSttCreditError(joinedMessage),
      requestedMessage: joinedMessage
    };
  }

  return {
    creditProvider: creditFailure?.provider,
    switchToBrowser: Boolean(requestedFailure && isSttCreditError(requestedFailure.message)),
    requestedMessage: requestedFailure?.message
  };
}
