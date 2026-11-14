/**
 * CI exit codes (locked by tests):
 * 0 — pass
 * 1 — assertion / regression fail
 * 2 — invalid fixture
 * 3 — infrastructure error
 */
export const ExitCode = {
  PASS: 0,
  ASSERTION_FAIL: 1,
  INVALID_FIXTURE: 2,
  INFRA_ERROR: 3,
} as const;

export type ExitCodeValue = (typeof ExitCode)[keyof typeof ExitCode];
