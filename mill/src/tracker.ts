export type Tracker = {
  create(input: { title: string; description: string; project: string }): Promise<{ id: string; url: string }>;
  move(id: string, state: string): Promise<void>;
  comment(id: string, body: string): Promise<void>;
};

export function createLogTracker(): Tracker {
  let counter = 0;
  return {
    async create({ title, project }) {
      counter += 1;
      const id = `LOCAL-${counter}`;
      console.log(`[tracker] create ${id} in ${project}: ${title}`);
      return { id, url: `local://${id}` };
    },
    async move(id, state) {
      console.log(`[tracker] move ${id} to ${state}`);
    },
    async comment(id, body) {
      console.log(`[tracker] comment on ${id}: ${body}`);
    },
  };
}
