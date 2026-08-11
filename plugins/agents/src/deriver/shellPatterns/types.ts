export interface DetectedPrompt {
  question: string;
  options: { id: string; label: string }[];
  context: string;
  /** Keys that accept/approve the prompt. The deriver sends these only when autonomy permits. */
  acceptKeys: string[];
  /** Environmental gate (e.g. workspace-trust) the agent must clear just to start — not an action
   *  it wants to take. The deriver clears these directly under autonomy, without an overseer call:
   *  elowen only ever spawns into projects the user registered, so trusting the workspace is implied. */
  autoAccept?: boolean;
  /** What kind of prompt this is. 'permission' (default) is an approve/reject gate the deriver clears
   *  with `acceptKeys`. 'choice' is the agent asking the user to pick one of `options`: the overseer
   *  picks an option id and the deriver navigates to it (Down × position-1) before pressing accept. */
  kind?: 'permission' | 'choice';
}
