import { expect, it } from "vitest";
import { ErrorCodes } from "../../packages/gateway-protocol/src/index.js";
import { WorkerTaskError } from "../infra/worker-task-pool.js";
import { IncognitoSessionEndedError } from "../state/incognito-session-error.js";
import { errorShapeFromError } from "./error-shape.js";

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

it("reports worker capacity refusals as retryable while keeping the surface's message", () => {
  const overload = new WorkerTaskError("Placement read capacity reached", "overloaded");
  expect(
    errorShapeFromError(ErrorCodes.INVALID_REQUEST, overload, { message: "sessions.list failed" }),
  ).toEqual({
    code: ErrorCodes.UNAVAILABLE,
    message: "sessions.list failed",
    retryable: true,
    retryAfterMs: 1000,
    details: { code: "worker-task-overloaded" },
  });
  expect(
    errorShapeFromError(ErrorCodes.UNAVAILABLE, new WorkerTaskError("timed out", "timeout")),
  ).toEqual({ code: ErrorCodes.UNAVAILABLE, message: expect.any(String) });
});
