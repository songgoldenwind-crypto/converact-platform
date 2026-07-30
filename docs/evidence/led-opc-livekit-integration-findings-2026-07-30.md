# LED / OPC LiveKit integration findings — 2026-07-30

## Decision

The production blocker was independently revalidated on 2026-07-31 and remains
isolated:

- OPC can create the durable call, allocate placement, produce a valid LiveKit
  join plan, and clean up the call and room.
- LED incorrectly uses new-call capacity (`capabilities.calls`) as a prerequisite
  for joining an already-created call.
- No LED source, configuration, image, container, or database row was changed
  directly. The browser and official API workflow created only the retained
  test order, assignment, payment, and call-lifecycle rows described below.
- The complete two-browser audio/video and reconnect test remains `not_run`
  until LED separates its create and join readiness gates.

OPC remains the generic communications substrate. LED must adapt its
application workflow to the operation-specific OPC capability contract.

## Scope and environment

| Item | Value |
| --- | --- |
| LED application | `https://app.64-225-122-227.sslip.io/` |
| LED API | `https://api.64-225-122-227.sslip.io/` |
| OPC tenant | `30e66be2-7fd2-48f0-8b1b-f7eac832b1b6` |
| LiveKit browser endpoint | `wss://rtc.freeotp.win:2096` |
| Customer test role | Spencer test account |
| Engineer test role | SJF test account |
| Original order | `cms7pyogi0011ru1rs2z97urq` |
| Original assignment | `cms7pzlui0016ru1rm8sn8ise` |
| 2026-07-31 revalidation order | `cms85mbkz002aru1r3qqz75pm` |
| 2026-07-31 revalidation assignment | `cms85ms98002fru1r6tqgkju7` |

Passwords, bearer tokens, LiveKit tokens, API keys, and server secrets are
deliberately omitted.

## Browser and server evidence

The test used two clean, independent local Chrome contexts with fake camera and
microphone devices. It did not reuse the ambient signed-in browser session.

### Independent revalidation — 2026-07-31

A complete fresh customer/engineer workflow independently reproduced the
original result:

1. Spencer created `OPC LiveKit findings revalidation 2026-07-31`; SJF accepted
   the assignment.
2. Stripe test-mode payment completed. The browser stated that no real charge
   would be made, and the reloaded order showed `Payment funded` and
   `Ready To Start`.
3. Before call creation, the authenticated capability response was ready with
   `calls=true`, `join=true`,
   `livekit_server_configured=true`,
   `livekit_browser_join_ready=true`, and one eligible candidate.
4. While an existing call was ringing, the customer call API returned
   `allowedActions=["accept","reject"]`, but the browser showed
   `Video calling is temporarily unavailable` and rendered no Accept button.
5. At the same point, a fresh capability request returned:

   ```text
   calls=false
   join=true
   media_call_create_availability=unavailable
   reason=no_eligible_candidates
   candidate_count=0
   ```

6. The customer accepted the controlled call through LED's official action
   endpoint. The accepted snapshot returned `allowedActions=["join"]`.
7. The subsequent official LED join request again failed with HTTP 503:

   ```text
   call_id=mcall_2de01c3e-c5fa-41b8-8602-202422abdd90
   request_id=e507c902-573d-40d5-809e-f6f7c2af6c8e
   path=/engagement/assignments/cms85ms98002fru1r6tqgkju7/media-call/mcall_2de01c3e-c5fa-41b8-8602-202422abdd90/join
   server_timestamp=2026-07-30T23:44:05.521Z
   ```

8. The LED API container log recorded `ServiceUnavailableException`, HTTP 503,
   the same request ID, and the same route. The failed request completed in
   20.38 ms and did not reach OPC's call-bound join operation.
9. An authenticated direct request to OPC for that same accepted call returned:

   ```text
   mode=webrtc
   role=participant
   room_name=ivekit-mcall_2de01c3e-c5fa-41b8-8602-202422abdd90
   livekit_url=wss://rtc.freeotp.win:2096
   token_configured=true
   token_nonempty=true
   placement_reservation_id=111d4a27-20a5-451e-9ce7-4d43cc8dcd7a
   placement_cell_id=ivekit-goal3-cell-a
   ```

   The token value was neither printed nor persisted.
10. The controlled call was ended through LED's official action endpoint with
    `controlled_test_cleanup`. Final authoritative checks showed:

    ```text
    mcall_cd536439-61b5-44fa-bd90-199104b76fb7  timed_out  ring_timeout
    mcall_50a1e7fd-55cd-4f07-9a12-e4d8eab199b7  timed_out  ring_timeout
    mcall_2de01c3e-c5fa-41b8-8602-202422abdd90  ended     controlled_test_cleanup

    all interaction placements: state=closed desired_state=closed sync_state=succeeded
    all Cell admission reservations: state=closed
    matching_livekit_rooms=0
    calls=true
    join=true
    media_call_create_availability=ready
    candidate_count=1
    ```

Relevant LED and OPC containers remained running; containers with configured
health checks reported healthy. No server configuration or deployment artifact
was changed.

### Successful workflow before media join

1. The customer published `OPC media dual-browser canary 2026-07-30`.
2. The engineer accepted the listed USD 1 test rate.
3. The customer completed Stripe test-mode payment. The UI explicitly stated
   that no real charge would be made.
4. The assignment became funded and both roles exposed the assignment-call
   entry point.
5. Before call creation, OPC reported:

   ```text
   calls=true
   join=true
   livekit_server_configured=true
   livekit_browser_join_ready=true
   media_call_create_availability=ready
   ```

### Deterministic LED join-gate reproduction

The first browser-created call was
`mcall_afed1ff8-0de9-4cff-b007-79e41a957681`.

- LED call creation returned HTTP 201.
- Once that call owned the bounded test capacity, OPC correctly reported
  `calls=false` and `join=true`.
- The customer call snapshot was still `ringing`, and LED reported the customer
  actions as `accept` and `reject`.
- Despite that existing call and those allowed actions, the LED customer UI
  removed the accept controls and displayed:
  `Video calling is temporarily unavailable`.
- No participant accepted before the bounded ring deadline, so the call ended
  normally as `timed_out` with `ring_timeout`.
- OPC released capacity and returned to `calls=true`, `join=true`.

The second controlled call was
`mcall_755cfa80-70a1-4703-a682-ecfbc0160ad2`.

1. The customer accepted it through LED's official action endpoint; HTTP 201,
   call state `accepted`, allowed action `join`.
2. At that exact point OPC reported:

   ```text
   calls=false
   join=true
   media_call_create_availability=unavailable
   reason=no_eligible_candidates
   ```

3. A customer join through LED returned HTTP 503:

   ```text
   request_id=5166456f-c269-409d-8211-031895085475
   path=/engagement/assignments/cms7pzlui0016ru1rm8sn8ise/media-call/mcall_755cfa80-70a1-4703-a682-ecfbc0160ad2/join
   server_timestamp=2026-07-30T16:26:23.829Z
   ```

4. The LED API log recorded
   `ServiceUnavailableException` for the same request ID and path.
5. The call was ended through the official LED action endpoint with
   `controlled_test_cleanup`.

This is the required regression shape: denying another **new call** is correct;
denying a participant's **join to the existing call** is incorrect.

### Direct OPC control proof

The third controlled call was
`mcall_770d889c-43c2-447d-8163-15575039bd85`.

After LED created and accepted the call, an authenticated server-side request
called OPC's official call-bound join endpoint directly. OPC returned:

```text
mode=webrtc
role=participant
room_name=ivekit-mcall_770d889c-43c2-447d-8163-15575039bd85
livekit_url=wss://rtc.freeotp.win:2096
token_configured=true
token_nonempty=true
placement_reservation_id=d366e406-c5e6-4d97-9931-d3ccc178ae42
```

The token value was neither printed nor persisted. This proves the OPC join
path was available while LED's shared readiness predicate would have rejected
the same operation.

The call was then ended through LED's official action endpoint with
`controlled_test_cleanup`. Final checks showed:

```text
matching_livekit_rooms=0
calls=true
join=true
media_call_create_availability=ready
candidate_count=1
```

The authoritative OPC PostgreSQL state also showed all three calls terminal,
all three interaction placements `closed/closed/succeeded`, and all three Cell
admission reservations `closed`.

## Why this is an LED defect

The deployed LED artifact contains one predicate for two different operations.
In
`src/modules/engagement/engagement-media-call.service.ts` (compiled artifact
`/app/dist/modules/engagement/engagement-media-call.service.js`):

- compiled line 109: `createCall` calls `assertDurableCallsReady()`;
- compiled line 213: `joinCall` calls the same predicate;
- compiled lines 793–807: the predicate requires both
  `capabilities.calls === true` and `capabilities.join === true`;
- compiled line 225: the OPC `createCallJoinPlan` request occurs only after that
  predicate, so the failing request never reaches OPC.

`calls` means that capacity is available to create another durable call.
`join` means that the participant may obtain a join plan for an already
admitted call. These are intentionally independent capabilities.

## Required LED changes

### 1. Split create readiness from join readiness

Use two explicit predicates:

```text
createCall readiness:
  tenant matches
  capabilities.calls == true
  capabilities.join == true
  livekit_server_configured == true
  livekit_browser_join_ready == true

join/rejoin/recovery readiness:
  tenant matches
  capabilities.join == true
  livekit_server_configured == true
  livekit_browser_join_ready == true
```

Join, rejoin, and placement recovery must not require
`capabilities.calls`, `media_call_create_availability`, or a candidate for a
new placement. They are bound to the existing durable call and placement.

### 2. Make the UI operation-aware

- `calls=false, join=true`: disable only `Start call` / `Start new call`.
- For a ringing existing call, keep `Accept` and `Reject` available.
- For an accepted or active existing call, keep `Join`, `Rejoin`, and recovery
  available.
- A retryable join failure must not cancel, duplicate, or recreate the durable
  call.
- Preserve the accepted call in the UI and provide bounded retry with backoff
  plus a manual retry action.

### 3. Add the missing regression tests

At minimum, cover:

1. `calls=false, join=true`, no existing call: create returns 503.
2. `calls=false, join=true`, ringing call: accept/reject remain available.
3. `calls=false, join=true`, accepted call: join succeeds.
4. `calls=false, join=true`, disconnected active call: rejoin succeeds.
5. Placement recovery for an existing call does not evaluate new-call
   availability.
6. Repeated UI retry does not create a second call or repeat a terminal action.

### 4. Improve safe diagnostics

Emit structured readiness decisions with safe fields:

```text
operation=create|join|rejoin|recovery
tenant_match
calls
join
livekit_server_configured
livekit_browser_join_ready
create_availability_reason
call_id
request_id
```

Return a stable, non-secret application error code for join readiness instead
of reducing the response to the generic `Internal server error`.

## OPC hotfixes applied before this test

The following OPC defects were independently reproduced, fixed with regression
tests, and deployed:

1. **Cell admission terminal recovery**
   - An active Cell leader could recover an old-owner reservation but could not
     persist its monotonic `closed`/`expired` state.
   - The active Cell lease remains the write fence; only terminal monotonic
     recovery transitions bypass the old owner-epoch equality check.
2. **Component-node terminal recovery**
   - Recovery admitted the old-owner checkpoint but rejected its terminal
     `active -> closed` continuation.
   - Terminal `closed`, plus `reserved -> expired`, are now permitted.
     Nonterminal old-owner advancement such as `reserved -> active` remains
     fenced as `stale_owner_epoch`.
3. **LiveKit runtime endpoint**
   - The invalid IP/8443 endpoint was replaced with
     `rtc.freeotp.win:2096`.
   - The management and browser endpoints, API credentials, and server
     readiness were validated without exposing secrets.

Focused regression result:

```text
node --import tsx --test \
  test/ivekit-component-node-admission.test.ts \
  test/ivekit-cell-admission-ledger.test.ts

25 tests passed, 0 failed
```

Deployed control/recovery image:

```text
ivekit/opc:production-media-control-recovery-c32e8f369583
sha256:f1b388dabe30540fb8d7d9d17a4bff39afb71ec5196b8d497378307146081307
```

The Cell, capacity projector, placement snapshot projector, and LiveKit
component-node use that image. The OPC API continues to use the previously
validated production-media image
`sha256:a7cefdc4fb22c46495fc78d9ee7d89776f7ece28fac6dc41d60146bef788fb0d`.

## Test-account and tooling findings

These are LED test-fixture or tooling issues, not OPC media defects:

- The supplied shared test password is valid for the wfelix account but not for
  the yenna, spencer, or lele accounts. Password values are intentionally not
  recorded here.
- Spencer can act as a customer, but the engineer role is blocked by LED
  compliance state (`platform_review_not_approved`, `kyc_not_verified`,
  `payout_not_ready`, `tax_form_not_verified`, and
  `stripe_account_missing`). The SJF account was therefore used as engineer.
- Stripe emitted an Apple Pay domain-registration warning. Standard Stripe test
  card payment still completed successfully; this is unrelated to OPC media.
- A manually issued unauthenticated diagnostic request produced one expected
  401, and a wrong-origin diagnostic request produced one expected 404. They
  were not application workflow failures.

## Remaining status

| Check | Status |
| --- | --- |
| Independent customer/engineer browser sessions | passed |
| Order, acceptance, and test payment | passed |
| LED durable call create | passed |
| OPC placement and bounded capacity behavior | passed |
| LED join with `calls=false, join=true` | failed — LED defect |
| Direct OPC join plan and correct WSS endpoint | passed |
| Terminal call cleanup and capacity release | passed |
| LiveKit room cleanup | passed |
| Two-browser audio/video tracks | `not_run` — blocked by LED join gate |
| Browser reconnect/rejoin | `not_run` — blocked by LED join gate |

Test data retained in LED because no safe cancel/refund control was exposed in
the tested customer UI:

- funded test order `cms7pyogi0011ru1rs2z97urq`;
- funded assignment `cms7pzlui0016ru1rm8sn8ise`;
- unused open test order `cms7pqcl3000xru1rsc59sc55`.
- funded revalidation order `cms85mbkz002aru1r3qqz75pm`;
- funded revalidation assignment `cms85ms98002fru1r6tqgkju7`.

No direct LED database cleanup was attempted.
