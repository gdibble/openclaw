import type { ServerResponse } from "node:http";
import {
  AgentDatabaseAdmissionError,
  createAgentDatabaseAdmissionErrorShape,
  type AgentDatabaseAdmissionRefusal,
} from "../state/agent-database-admission.js";
import { resolveWorkerOverload } from "./error-shape.js";
import { prepareGatewayHttpErrorResponse, sendJson } from "./http-common.js";

/** HTTP form of the RPC `UNAVAILABLE` shape for storage admission refusals. */
export type GatewayHttpUnavailableError = {
  message: string;
  type: "service_unavailable";
  code: string;
  retryable: boolean;
  retryAfterMs?: number;
  details: { code: string; agentId?: string };
};

// Refusal reasons and repair hints quote database paths and shell commands. HTTP clients
// get the refusal class and agent; RPC, status, and Doctor keep the full operator text.
const REFUSAL_MESSAGES = {
  "agent-database-inspection-pending": (agentId) =>
    `Agent ${agentId} has not completed startup inspection and preparation. Retry shortly.`,
  "agent-database-inspection-failed": (agentId) =>
    `Agent ${agentId} database is unavailable. Run "openclaw doctor --fix" on the Gateway host, then restart the Gateway.`,
  "agent-database-ownership-mismatch": (agentId) =>
    `Agent ${agentId} database belongs to another agent. Run "openclaw doctor" on the Gateway host for repair steps.`,
} satisfies Record<AgentDatabaseAdmissionRefusal["code"], (agentId: string) => string>;

/** Classify refusals that the RPC path already answers as `UNAVAILABLE`. */
export function resolveGatewayHttpUnavailableError(
  error: unknown,
): GatewayHttpUnavailableError | undefined {
  if (error instanceof AgentDatabaseAdmissionError) {
    const { refusal } = error;
    const shape = createAgentDatabaseAdmissionErrorShape(refusal);
    return {
      message: REFUSAL_MESSAGES[refusal.code](refusal.agentId),
      type: "service_unavailable",
      code: shape.code,
      retryable: shape.retryable === true,
      ...(shape.retryAfterMs !== undefined ? { retryAfterMs: shape.retryAfterMs } : {}),
      details: { code: refusal.code, agentId: refusal.agentId },
    };
  }
  const overload = resolveWorkerOverload(error);
  if (overload) {
    return {
      message: overload.message,
      type: "service_unavailable",
      code: "UNAVAILABLE",
      retryable: true,
      retryAfterMs: overload.retryAfterMs,
      details: { code: overload.code },
    };
  }
  return undefined;
}

export function setGatewayHttpRetryAfter(res: ServerResponse, retryAfterMs: number | undefined) {
  if (retryAfterMs !== undefined && retryAfterMs > 0) {
    res.setHeader("Retry-After", String(Math.ceil(retryAfterMs / 1000)));
  }
}

/** Answer a storage admission refusal as 503; other failures keep their owner's response. */
export function finishGatewayHttpUnavailable(res: ServerResponse, error: unknown): boolean {
  const unavailable = resolveGatewayHttpUnavailableError(error);
  if (!unavailable) {
    return false;
  }
  if (prepareGatewayHttpErrorResponse(res, "Service Unavailable")) {
    setGatewayHttpRetryAfter(res, unavailable.retryAfterMs);
    sendJson(res, 503, { error: unavailable });
  }
  return true;
}
