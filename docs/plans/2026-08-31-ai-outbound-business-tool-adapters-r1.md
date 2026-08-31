# AI Outbound Generic Business Tool Adapters R1 Plan

**Goal:** Complete the D5 controlled demonstration with one industry-neutral query Tool and one
idempotent mutation Tool, implemented as Rust provider ports behind the existing Tool Broker.

**Architecture:** Add `converact-agent-tool-adapters`. It accepts only `AuthorizedToolAction`,
dispatches two compile-time capability names, validates typed bounded arguments, and maps typed
provider observations into the existing `ActionObservation`. It never receives endpoints,
credentials, SQL, scripts or Agent state.

## TDD slice

1. Add one failing behavior test for `customer.lookup` plus ambiguous
   `task.create_follow_up -> query`, asserting the mutation provider receives `ToolCallId` as its
   idempotency key.
2. Implement bounded customer and follow-up types, provider ports and compile-time dispatch.
3. Run only the new test, Tool Broker Core tests, scoped Clippy and format.
4. Commit code separately, then record exact controlled evidence. Real providers and production
   remain `not_run`.
