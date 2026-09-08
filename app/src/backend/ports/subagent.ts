/**
 * P5 subagent port (capability-packs plan §1.3): the grandchild driver face
 * the registry consumes (spawn-shaped runner speaking the internal worker
 * protocol) and the registry face backends' tools consume. The registry
 * itself is composition; the driver is backend-owned. Backends without the
 * subagents capability never see either face.
 */

import type {
  GrandchildDriver,
  GrandchildHooks,
  GrandchildMessage,
  GrandchildResult,
  GrandchildTaskSpec,
} from "../../subagent-contract.ts";
import type { LaunchHandle, SnapshotEntry, SubagentStatus } from "../../subagent-registry.ts";

/** The spawn-shaped grandchild runner (backend-owned; tests inject fakes). */
export type StartGrandchildTask = (deps: {
  spec: GrandchildTaskSpec;
  hooks: GrandchildHooks;
  signal?: AbortSignal;
}) => GrandchildDriver;

/** The registry surface backend tools consume (worker wires the registry in). */
export interface SubagentRegistryFace {
  inFlight(): number;
  launch(deps: {
    spec: GrandchildTaskSpec;
    hooks: GrandchildHooks;
    background?: boolean;
    outerSignal?: AbortSignal;
  }): LaunchHandle;
  queueMessage(subagentId: string, message: GrandchildMessage): void;
  snapshot(subagentId?: string): SnapshotEntry[] | SnapshotEntry | undefined;
  stopOne(subagentId: string): SubagentStatus | undefined;
  awaitOf(subagentId: string): Promise<GrandchildResult> | undefined;
  steer(subagentId: string, message: string): Promise<boolean | string>;
  suppressNotifications(ids: string[]): void;
  releaseNotifications(ids: string[]): void;
}
