export type PostCommitTask = () => void;

export function runPostCommitTasks(tasks: readonly PostCommitTask[]) {
  let completed = true;

  for (const task of tasks) {
    try {
      task();
    } catch {
      completed = false;
    }
  }

  return completed;
}
