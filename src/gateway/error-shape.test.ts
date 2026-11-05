import { expect, it } from "vitest";
import { ErrorCodes } from "../../packages/gateway-protocol/src/index.js";
import { isTransientRestartRecoveryError } from "../infra/restart-recovery-errors.js";
import { SqliteWorkerError } from "../infra/sqlite-worker-contract.js";
import { WorkerTaskError } from "../infra/worker-task-pool.js";
import { IncognitoSessionEndedError } from "../state/incognito-session-error.js";
import { errorShapeFromError } from "./error-shape.js";
import { resolveGatewayHttpUnavailableError } from "./http-unavailable.js";

it("reports ended incognito sessions as typed nonretryable client failures through cleanup wrappers", () => {
  const ended = new IncognitoSessionEndedError();
  const error = new AggregateError([new Error("cleanup"), ended], "operation failed");
  expect(
    errorShapeFromError(ErrorCodes.INVALID_REQUEST, error, {
      message: "generic failure",
      retryable: true,
    }),
  ).toMatchObject({
    code: ErrorCodes.UNAVAILABLE,
    message: ended.message,
    retryable: false,
    details: { code: "INCOGNITO_SESSION_ENDED" },
  });
});

it("classifies worker capacity refusals while leaving the retry hint to the surface", () => {
  const overload = new WorkerTaskError("Placement read capacity reached", "overloaded");
  expect(
    errorShapeFromError(ErrorCodes.INVALID_REQUEST, overload, { message: "sessions.list failed" }),
  ).toEqual({
    code: ErrorCodes.UNAVAILABLE,
    message: "sessions.list failed",
    details: { code: "worker-task-overloaded" },
  });
  expect(
    errorShapeFromError(ErrorCodes.UNAVAILABLE, overload, { retryable: true, retryAfterMs: 250 }),
  ).toMatchObject({
    retryable: true,
    retryAfterMs: 250,
    details: { code: "worker-task-overloaded" },
  });
  expect(
    errorShapeFromError(ErrorCodes.UNAVAILABLE, new WorkerTaskError("timed out", "timeout")),
  ).toEqual({ code: ErrorCodes.UNAVAILABLE, message: expect.any(String) });
});

it("offers the overload's own retry hint only to a surface that asks and only for an overload", () => {
  const overload = new WorkerTaskError("Placement read capacity reached", "overloaded");
  expect(
    errorShapeFromError(ErrorCodes.INVALID_REQUEST, overload, {
      message: "skills.status failed",
      retryOverload: true,
    }),
  ).toEqual({
    code: ErrorCodes.UNAVAILABLE,
    message: "skills.status failed",
    retryable: true,
    retryAfterMs: 1000,
    details: { code: "worker-task-overloaded" },
  });
  expect(
    errorShapeFromError(ErrorCodes.INVALID_REQUEST, new Error("bad skill filter"), {
      retryOverload: true,
    }),
  ).toEqual({ code: ErrorCodes.INVALID_REQUEST, message: "bad skill filter" });
});

it.each([
  { error: new SqliteWorkerError("SQLite worker host is closing", "overloaded"), retry: true },
  {
    error: new SqliteWorkerError(
      "SQLite worker commit receipt exceeds the transport limit",
      "too-large",
    ),
    retry: false,
  },
])(
  "answers '$error.message' with the retry class restart recovery gives it",
  ({ error, retry }) => {
    expect(isTransientRestartRecoveryError(error)).toBe(retry);
    expect(resolveGatewayHttpUnavailableError(error)).toEqual(
      retry ? expect.objectContaining({ retryable: true, retryAfterMs: 1000 }) : undefined,
    );
    expect(errorShapeFromError(ErrorCodes.INVALID_REQUEST, error).code).toBe(
      retry ? ErrorCodes.UNAVAILABLE : ErrorCodes.INVALID_REQUEST,
    );
  },
);
