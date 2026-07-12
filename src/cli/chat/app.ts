import { ChatApplication } from './chatApplication.js';
import type { ChatLaunchOptions } from './chatApplication.js';

export type RunChatOpts = ChatLaunchOptions;

/** Interactive chat entrypoint. Non-TTY invocation stays actionable and does not create a client or
 * mutate terminal state; every interactive owner lives under one ChatApplication instance. */
export async function runChat(options: RunChatOpts): Promise<void> {
  if (!process.stdout.isTTY) {
    process.stderr.write('elowen chat needs an interactive terminal (a TTY).\n');
    return;
  }
  const application = new ChatApplication(options);
  await application.run();
}
