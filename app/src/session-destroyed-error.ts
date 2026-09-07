/**
 * Fork/clone failed AFTER the runtime tore down the current session
 * (migration.md F-1). The session object left in place is disposed; the
 * worker must fail the command and exit instead of keeping a zombie thread.
 */
export class SessionDestroyedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SessionDestroyedError";
  }
}
