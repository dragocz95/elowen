export interface RunnerReloadActivitySource {
  reloadOwnedWorkCount(): Promise<number>;
}

export async function runnerReloadActivityCount(
  runningChannelCount: number,
  brain: RunnerReloadActivitySource | undefined,
): Promise<number> {
  return runningChannelCount + (brain ? await brain.reloadOwnedWorkCount() : 0);
}
