import assert from "node:assert/strict";
import fs from "node:fs";
import { afterEach, expect, it, vi } from "vitest";
import { SqliteWorkerBroker } from "../infra/sqlite-worker-broker.js";
import { useSqliteWorkerStoreFixture } from "../infra/sqlite-worker-fixture.test-support.js";
import { createSqliteWorkerOperationAdmission } from "../infra/sqlite-worker-operation-admission.js";
import { createDeferredCore } from "../shared/deferred.js";
import { readGlobalSingleton } from "../shared/global-singleton.js";
import { closeOpenClawAgentDatabasesAsync } from "./openclaw-agent-db-lifecycle.js";
import type { AgentDatabaseRequestExecutionSource } from "./openclaw-agent-execution-admission-contract.js";
import * as native from "./openclaw-agent-execution-native.js";
import { captureOpenClawAgentDatabaseExecution } from "./openclaw-agent-execution.js";
import { closeOpenClawStateDatabaseAsync } from "./openclaw-state-db.js";

const fixture = useSqliteWorkerStoreFixture("agent-capacity-filler-");

afterEach(async () => {
  await closeOpenClawAgentDatabasesAsync();
  await closeOpenClawStateDatabaseAsync();
  vi.restoreAllMocks();
});

const source: AgentDatabaseRequestExecutionSource = {
  assertCurrent: () => undefined,
  createAdmission(binding) {
    return () => {
      const admission = createSqliteWorkerOperationAdmission((request, grant) => {
        binding.authorize(request);
        if (!grant()) {
          throw new Error("Capacity fixture lost admission");
        }
      }, binding.attachment);
      return { nativeLocations: binding.nativeLocations, admission };
    };
  },
};

// Fill the shared budget until no owner-confirmed idle client remains to retire.
async function fillUntilRefused(): Promise<unknown> {
  const databasePath = fixture.databasePath();
  for (let opened = 0; opened < 1024; opened++) {
    try {
      await fixture.open(databasePath);
    } catch (error) {
      return error;
    }
  }
  throw new Error("The SQLite worker broker never refused an open");
}

it("retires a parked agent executor when ordinary opens reach the broker client budget", async () => {
  const env = { OPENCLAW_STATE_DIR: fs.realpathSync(fixture.tempDirs.make("agent-capacity-")) };
  const generations = vi.spyOn(native, "createAgentDatabaseNativeGeneration");
  const parked = captureOpenClawAgentDatabaseExecution({ agentId: "parked", env });
  await parked.prepare(source);
  await parked.release();
  const generation = generations.mock.results[0];
  assert(generation?.type === "return");
  const close = vi.spyOn(generation.value, "close");

  const refusal = await fillUntilRefused();
  expect(refusal).toMatchObject({ code: "overloaded" });
  expect(close).toHaveBeenCalledOnce();
  await Promise.all([...fixture.stores].map((store) => store.close()));
  fixture.stores.clear();

  // The retired executor reopens through ordinary admission on its next borrow.
  const reopened = captureOpenClawAgentDatabaseExecution({ agentId: "parked", env });
  try {
    await reopened.prepare(source);
    expect(generations).toHaveBeenCalledTimes(2);
  } finally {
    await reopened.release();
  }
});

it("admits the reclaiming open before the retired executor's lease cleanup settles", async () => {
  const env = { OPENCLAW_STATE_DIR: fs.realpathSync(fixture.tempDirs.make("agent-capacity-")) };
  const generations = vi.spyOn(native, "createAgentDatabaseNativeGeneration");
  const parked = captureOpenClawAgentDatabaseExecution({ agentId: "parked", env });
  await parked.prepare(source);
  await parked.release();
  const generation = generations.mock.results[0];
  assert(generation?.type === "return");
  const closeGeneration = generation.value.close.bind(generation.value);
  // Lease cleanup after an unclean native exit opens its own client, so the reclaiming
  // open must not wait for it: that open would queue behind the reclaiming one.
  const leaseCleanup = createDeferredCore();
  const close = vi.spyOn(generation.value, "close").mockImplementation(async () => {
    await closeGeneration();
    await leaseCleanup.promise;
  });

  let refusal: unknown;
  const filling = fillUntilRefused().then((error) => {
    refusal = error;
  });
  try {
    await vi.waitFor(() => expect(refusal).toBeDefined(), { timeout: 10_000 });
  } finally {
    leaseCleanup.resolve();
    await filling;
  }
  expect(refusal).toMatchObject({ code: "overloaded" });
  expect(close).toHaveBeenCalledOnce();
});

it("seals a reclaimed agent client in the broker's turn so host drainage cannot cycle", async () => {
  const env = { OPENCLAW_STATE_DIR: fs.realpathSync(fixture.tempDirs.make("agent-capacity-")) };
  const generations = vi.spyOn(native, "createAgentDatabaseNativeGeneration");
  const parked = captureOpenClawAgentDatabaseExecution({ agentId: "parked", env });
  await parked.prepare(source);
  await parked.release();
  const generation = generations.mock.results[0];
  assert(generation?.type === "return");
  const broker = readGlobalSingleton(Symbol.for("openclaw.sqliteWorkerBroker"));
  assert(broker instanceof SqliteWorkerBroker);
  const closeGeneration = generation.value.close.bind(generation.value);
  let draining: Promise<void> | undefined;
  // Host shutdown begins while reclamation is closing the parked executor.
  vi.spyOn(generation.value, "close").mockImplementation(() => {
    draining ??= broker.close();
    return closeGeneration();
  });

  const refusal = await fillUntilRefused();
  expect(draining).toBeDefined();
  await draining;
  expect(refusal).toMatchObject({ code: "closed" });
  fixture.stores.clear();
});
