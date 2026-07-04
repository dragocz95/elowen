/** What a turn should do about the vision-fallback model, decided BEFORE any session is touched.
 *  Pure — the caller (BrainService.send, inside its user-level lock) performs the stop/start. */
export type VisionHop =
  /** Stay on the current session. */
  | { action: 'none' }
  /** Image turn on a text-only model with a configured fallback → respawn on the vision model. */
  | { action: 'hop'; provider?: string; model: string }
  /** Text-only turn while parked on the fallback → respawn back on the user's normal model. */
  | { action: 'hop-back' };

export function decideVisionHop(i: {
  hasImages: boolean;
  /** Whether the CURRENT session's model accepts image input. */
  visionCapable: boolean;
  /** Whether the session currently runs on the vision-fallback model. */
  onFallback: boolean;
  /** The model the CURRENT session runs on — so we never hop onto the model we're already on. */
  currentModel?: string;
  visionModel?: string;
  visionModelProvider?: string;
}): VisionHop {
  // Hop only when an image turn lands on a model that can't take images AND a DIFFERENT vision model is
  // configured. If the current model already IS the vision model (common when the operator points both
  // at one multimodal model), there's nothing to hop to — send the image straight through, no churn.
  if (i.hasImages && !i.visionCapable && i.visionModel && i.visionModel !== i.currentModel) {
    return { action: 'hop', provider: i.visionModelProvider || undefined, model: i.visionModel };
  }
  if (!i.hasImages && i.onFallback) return { action: 'hop-back' };
  return { action: 'none' };
}
