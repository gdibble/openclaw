import { collectNestedErrorCandidates } from "@openclaw/normalization-core/error-coercion";
import { WorkerTaskError } from "@openclaw/worker-runtime";
import { ErrorCodes, errorShape } from "../../packages/gateway-protocol/src/index.js";
import { copyErrorDiagnostic } from "../infra/error-diagnostics.js";
import { formatErrorMessageWithCode } from "../infra/errors.js";
import { isSqliteWorkerError } from "../infra/sqlite-worker-contract.js";
import {
  AgentDatabaseAdmissionError,
  createAgentDatabaseAdmissionErrorShape,
} from "../state/agent-database-admission.js";
import { IncognitoSessionEndedError } from "../state/incognito-session-error.js";

const WORKER_OVERLOAD_RETRY_AFTER_MS = 1_000;

/** Capacity refusals from the SQLite broker and worker task pools. */
export type WorkerOverload = {
  code: "sqlite-worker-overloaded" | "worker-task-overloaded";
  /** Fixed owner text; it never quotes paths or request content. */
  message: string;
  retryAfterMs: number;
};

/** Both owners refuse before their own work starts; a surface that recorded no outcome may retry. */
export function resolveWorkerOverload(error: unknown): WorkerOverload | undefined {
  // Cleanup aggregates do not certify non-execution, so they keep the generic failure.
  if (isSqliteWorkerError(error, "overloaded")) {
    return {
      code: "sqlite-worker-overloaded",
      message: error.message,
      retryAfterMs: WORKER_OVERLOAD_RETRY_AFTER_MS,
    };
  }
  if (error instanceof WorkerTaskError && error.code === "overloaded") {
    return {
      code: "worker-task-overloaded",
      message: error.message,
      retryAfterMs: WORKER_OVERLOAD_RETRY_AFTER_MS,
    };
  }
  return undefined;
}

/**
 * Preserve typed refusals while allowing each surface's existing error message.
 * A worker overload keeps its class, but its retry hint stays with the caller: a surface
 * that records the failure as the request's outcome replays it to a same-ID retry.
 */
export function errorShapeFromError(
  code: Parameters<typeof errorShape>[0],
  error: unknown,
  opts?: Parameters<typeof errorShape>[2] & { message?: string },
) {
  const { message, ...metadata } = opts ?? {};
  const ended = collectNestedErrorCandidates(error).find(
    (candidate) => candidate instanceof IncognitoSessionEndedError,
  );
  const overload = resolveWorkerOverload(error);
  const shape =
    error instanceof AgentDatabaseAdmissionError
      ? createAgentDatabaseAdmissionErrorShape(error.refusal)
      : ended instanceof IncognitoSessionEndedError
        ? errorShape(ErrorCodes.UNAVAILABLE, ended.message, {
            ...metadata,
            retryable: false,
            details: { code: ended.code },
          })
        : overload
          ? errorShape(ErrorCodes.UNAVAILABLE, message ?? formatErrorMessageWithCode(error), {
              ...metadata,
              details: { code: overload.code },
            })
          : errorShape(code, message ?? formatErrorMessageWithCode(error), metadata);
  copyErrorDiagnostic(error, shape);
  return shape;
}
