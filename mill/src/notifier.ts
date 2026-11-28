export type Notifier = {
  send(text: string): Promise<number>;
  ask(taskId: string, text: string): Promise<number>;
};

export function createLogNotifier(): Notifier {
  let counter = 0;
  return {
    async send(text) {
      counter += 1;
      console.log(`[notify ${counter}] ${text}`);
      return counter;
    },
    async ask(taskId, text) {
      counter += 1;
      console.log(`[ask ${counter}] ${taskId}: ${text}`);
      return counter;
    },
  };
}
