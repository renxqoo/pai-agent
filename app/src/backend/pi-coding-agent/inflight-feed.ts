/**
 * Feed the thread's in-flight retention from the session event subscription
 * (single implementation for both bind paths — bindThread / rebindThread).
 * `agent_start` pins this turn's persistent prefix boundary: the leaf entry id
 * at turn start, which is what makes reload convergence independent of which
 * events a client happened to receive. Tool/bash events keep the running
 * outputs' tails; `agent_settled` drops the turn (everything durable has moved
 * to the session file by then).
 */

import type { AgentSession, AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { type InflightState } from "../../inflight-state.ts";

export function feedInflight(
  inflight: InflightState,
  session: AgentSession,
  event: AgentSessionEvent,
): void {
  switch (event.type) {
    case "agent_start":
      // 边界与时刻同点采集：客户端据此跨重载续算轮计时（否则刷新后从 0 起算）
      inflight.beginTurn(session.sessionManager.getLeafId(), Date.now());
      return;
    case "agent_settled":
      inflight.endTurn();
      return;
    case "tool_execution_start":
      inflight.noteToolStart(event.toolCallId);
      return;
    case "tool_execution_update":
      // The raw cumulative snapshot: the state instance owns the cap (single truth).
      inflight.noteToolUpdate(event.toolCallId, event.partialResult);
      return;
    case "tool_execution_end":
      inflight.noteToolEnd(event.toolCallId);
      return;
    case "bash_execution_update":
      // 帧携带命令帧 id（executeBash options.id）：并发直执行互不串台；
      // 无 id 的调用方退化为单一 "" 槽
      inflight.noteBashOutput(event.id ?? "", event.delta);
      return;
    default:
      return;
  }
}
