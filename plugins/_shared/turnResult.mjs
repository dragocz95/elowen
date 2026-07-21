/** Shared interpretation of the brain's channel-send return value.
 *
 *  `ChannelSessionService.send()` resolves to the assistant reply for a fresh turn, but to `''` when a
 *  same-sender message that arrived MID-turn was STEERED into the running turn (injected between steps,
 *  not answered on its own — the running turn's original message carries the eventual reply). Adapters must
 *  read this here rather than each re-deriving the sentinel, so the contract has a single owner. */

/** True when the handler steered the message into a running turn instead of answering it — no success
 *  reaction (✅/👍) belongs to it; the in-flight turn owns the outcome. */
export const isSteered = (reply) => reply === '';
