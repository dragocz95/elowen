/** What a turn should do about the vision-fallback model, decided BEFORE any session is touched.
 *  Pure — the caller (BrainService.send, inside its user-level lock) performs the stop/start. */
export type VisionHop =
  /** Stay on the current session. */
  | { action: 'none' }
  /** Image turn with a configured, different vision model → respawn on it. */
  | { action: 'hop'; provider?: string; model: string }
  /** Text-only turn while parked on the fallback → respawn back on the user's normal model. */
  | { action: 'hop-back' };

export function decideVisionHop(i: {
  hasImages: boolean;
  /** Whether the session currently runs on the vision-fallback model. */
  onFallback: boolean;
  /** The model the CURRENT session runs on — so we never hop onto the model we're already on. */
  currentModel?: string;
  /** Config provider entry of the current session. The same model id can exist under multiple
   *  providers, so provider identity participates whenever the fallback explicitly names one. */
  currentProvider?: string;
  visionModel?: string;
  visionModelProvider?: string;
}): VisionHop {
  // Route an image turn to the operator's configured vision model whenever one is set AND its configured
  // provider/model pair differs from the current session. We can't probe per-model vision capability
  // for inline providers, so rather than
  // guess from the (now always-multimodal) descriptor, we honour the explicit visionModel choice: if it's
  // configured, images go there. When the current provider/model already IS the vision target, there's nothing to
  // hop to — the image passes straight through, no churn.
  const providerDiffers = !!i.visionModelProvider && i.visionModelProvider !== i.currentProvider;
  if (i.hasImages && i.visionModel && (i.visionModel !== i.currentModel || providerDiffers)) {
    return { action: 'hop', provider: i.visionModelProvider || undefined, model: i.visionModel };
  }
  if (!i.hasImages && i.onFallback) return { action: 'hop-back' };
  return { action: 'none' };
}
