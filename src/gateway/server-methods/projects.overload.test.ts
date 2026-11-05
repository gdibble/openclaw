import { expect, test, vi } from "vitest";
import { SqliteWorkerError } from "../../infra/sqlite-worker-contract.js";
import * as projectRegistry from "../../projects/project-registry.js";
import { invokeProjectMethod } from "./projects.test-support.js";

test.each([
  {
    method: "projects.list",
    params: {},
    registry: "listProjectRegistry",
    retry: { retryable: true, retryAfterMs: 1000 },
  },
  // A refused registration may follow an accepted write, so it never invites a retry.
  {
    method: "projects.register",
    params: { path: "/projects/overloaded" },
    registry: "registerProjectRegistry",
    retry: {},
  },
] as const)("$method answers a project registry overload as typed UNAVAILABLE", async (row) => {
  using registry = vi.spyOn(projectRegistry, row.registry);
  registry.mockRejectedValueOnce(
    new SqliteWorkerError("SQLite worker store capacity reached", "overloaded"),
  );
  expect(await invokeProjectMethod(row.method, row.params)).toEqual({
    ok: false,
    payload: undefined,
    error: {
      code: "UNAVAILABLE",
      message: "SQLite worker store capacity reached",
      ...row.retry,
      details: { code: "sqlite-worker-overloaded" },
    },
  });
  expect(registry).toHaveBeenCalledOnce();
});
