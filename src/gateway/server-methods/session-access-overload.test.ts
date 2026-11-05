import { describe, expect, it, vi } from "vitest";
import { SqliteWorkerError } from "../../infra/sqlite-worker-contract.js";
import type { GatewayRequestHandlerOptions } from "./types.js";

const prepareSessionSharingAccess = vi.hoisted(() => vi.fn());
vi.mock("./sessions-sharing-authority.js", () => ({ prepareSessionSharingAccess }));

import { withSessionDiscoveryAccess } from "./session-discovery-access.js";
import { withSessionReactionAccess } from "./sessions-reactions-access.js";

const overloaded = {
  code: "UNAVAILABLE",
  message: "SQLite worker store capacity reached",
  details: { code: "sqlite-worker-overloaded" },
};
const retry = { retryable: true, retryAfterMs: 1000 };

function access(respond: ReturnType<typeof vi.fn>) {
  return {
    client: null,
    context: {},
    respond,
    sessionKey: "agent:main:main",
    agentId: "main",
  } as unknown as Pick<GatewayRequestHandlerOptions, "client" | "context" | "respond"> & {
    sessionKey: string;
    agentId: string;
  };
}

describe("session access helpers", () => {
  // Both helpers answered every failure as INVALID_REQUEST, so a capacity refusal told the
  // client its request was malformed.
  it.each([
    {
      surface: "discovery",
      expected: { ...overloaded, ...retry },
      run: (respond: ReturnType<typeof vi.fn>) =>
        withSessionDiscoveryAccess(
          { ...access(respond), changedError: { code: "UNAVAILABLE", message: "changed" } },
          async () => ({}),
        ),
    },
    {
      surface: "reaction read",
      expected: { ...overloaded, ...retry },
      run: (respond: ReturnType<typeof vi.fn>) =>
        withSessionReactionAccess({ ...access(respond), write: false }, async () => {}),
    },
    {
      // A write may have acted before the refusal, so it carries the class but no retry hint.
      surface: "reaction write",
      expected: overloaded,
      run: (respond: ReturnType<typeof vi.fn>) =>
        withSessionReactionAccess({ ...access(respond), write: true }, async () => {}),
    },
  ])("answers a worker overload in $surface as typed UNAVAILABLE", async ({ expected, run }) => {
    prepareSessionSharingAccess.mockRejectedValueOnce(
      new SqliteWorkerError("SQLite worker store capacity reached", "overloaded"),
    );
    const respond = vi.fn();
    await run(respond);
    expect(respond).toHaveBeenCalledExactlyOnceWith(false, undefined, expected);
  });
});
