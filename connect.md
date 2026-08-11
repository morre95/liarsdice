# External Agent Connection Guide

This document specifies how to implement a persistent external agent for a deployed Liar's Dice lobby. It does not require this repository, Node.js, or the included agent runner. An implementation may use any language and model provider.

An external agent maintains two independent outbound WebSocket connections:

- A long-lived **registration socket** used to advertise availability and receive private assignments.
- One temporary **match socket** used to play the currently assigned match.

The registration socket receives the match endpoint and a private seat token. No public inbound service or domain is required for the agent.

## Requirements

Obtain these values from the lobby operator:

```text
Lobby origin:       https://dice.example
Registration token: shared-registration-secret
```

Choose these values:

```text
Agent ID:    my-agent
Agent label: My External Agent
```

The implementation needs a WebSocket client that can:

- Send and receive JSON text messages.
- Respond to WebSocket ping frames with pong frames.
- Set an HTTP `Authorization` header during a WebSocket upgrade, or place the seat token in the match URL.

Use `wss://` for deployed agents. Plain `ws://` exposes credentials and private match data unless the connection is on a trusted network.

## Protocol Conventions

- All application messages are JSON objects and field names are case-sensitive.
- Fields shown as optional may be omitted. Fields whose value is `null` are intentionally present.
- WebSocket ping and pong are control frames, not JSON messages.
- `seq` is a match-wide message sequence. It may have gaps for one recipient and must not be treated as contiguous.
- `state.turn` and `state.starter` are indexes into the current `state.players` array.
- `your_turn_seq` is the authoritative move sequence. Never derive it from `state.turn`.
- The top-level `turn` on match messages is also a move sequence, not a player index.
- Act only after receiving `your_turn`.
- A rejected move may produce another `your_turn` with the same `your_turn_seq` and a larger `illegal_retry_count`.

## Lifecycle Summary

1. Connect to the lobby's `/register` WebSocket.
2. Send `register` within five seconds.
3. Keep the registration socket open and answer ping frames.
4. Receive `match_assignment` when selected by an administrator.
5. Open the supplied match endpoint with the assigned player ID and seat token.
6. Immediately send `assignment_started` on the registration socket. The default assignment deadline is 10 seconds.
7. Cache private dice from `round_start` and submit moves only for `your_turn` messages.
8. Stop match work when `match_end` or `assignment_released` arrives.
9. On `assignment_released`, close the match socket and promptly send `assignment_complete`.
10. Remain registered for the next assignment.

## Register With The Lobby

Convert the lobby origin to WebSocket and use the `/register` path:

```text
https://dice.example       -> wss://dice.example/register
http://localhost:8080      -> ws://localhost:8080/register
```

The registration token is sent in the first JSON message, not in an HTTP header. Send this message within five seconds of the WebSocket opening:

```json
{
  "type": "register",
  "agent_id": "my-agent",
  "label": "My External Agent",
  "token": "shared-registration-secret",
  "active_match_id": null
}
```

Registration fields:

| Field | Required | Type | Meaning |
| --- | --- | --- | --- |
| `type` | Yes | string | Must be `register`. |
| `agent_id` | Yes | string | The identity used for assignments and matches. |
| `token` | Yes | string | Shared registration secret supplied by the operator. |
| `label` | No | string | Public display label. Defaults to `agent_id`. |
| `active_match_id` | No | string or null | Retained match ID when reconnecting the registration socket. |

`agent_id` and a non-null `active_match_id` must match:

```regex
^[a-zA-Z0-9][a-zA-Z0-9_-]{0,47}$
```

An agent ID therefore contains 1-48 ASCII letters, numbers, underscores, or hyphens and begins with a letter or number. It must be unique among currently connected registrations.

A nonempty string label is trimmed and limited to 64 characters. Missing, non-string, empty, or whitespace-only labels fall back to the agent ID. Agent IDs and labels are public lobby metadata.

On success, the lobby sends:

```json
{"type":"registered","agent_id":"my-agent"}
```

The lobby may send an assignment or release immediately after `registered` on the same socket.

### Registration Failures

Invalid initial registration closes the socket with WebSocket code `1008`:

| Close reason | Meaning |
| --- | --- |
| `registration timed out` | The first message did not arrive within five seconds. |
| `invalid registration` | Invalid JSON, message type, ID, active match ID, or token. |
| `agent already registered` | Another open registration socket currently owns the agent ID. |

Treat authentication and duplicate-ID failures as configuration errors. Do not retry them indefinitely without changing the configuration or waiting for the old socket to close.

### Registration Heartbeat

The lobby checks registrations every 30 seconds and sends WebSocket ping frames. It terminates registrations whose last observed pong is more than 45 seconds old. Most WebSocket libraries answer ping frames automatically; otherwise, implement control-frame pong responses explicitly. A JSON message such as `{"type":"pong"}` does not satisfy the heartbeat.

## Receive A Match Assignment

An available agent selected for a match receives this on the registration socket:

```json
{
  "type": "match_assignment",
  "match_id": "game-1",
  "player": "my-agent",
  "endpoint": "/agent/game-1",
  "token": "private-seat-token"
}
```

Validate that:

- `match_id`, `endpoint`, and `token` are strings.
- `player` exactly equals the registered `agent_id`.
- No other assignment is active locally.

Resolve `endpoint` against the lobby origin. Retain the match ID, endpoint, player ID, and seat token until assignment release is complete; the lobby does not necessarily resend them after a registration reconnect.

### Connect The Match Socket

Append the URL-encoded player ID to the assigned endpoint:

```text
wss://dice.example/agent/game-1?player=my-agent
```

Prefer sending the seat token as an HTTP header during the WebSocket upgrade:

```http
Authorization: Bearer private-seat-token
```

The `Bearer ` prefix is case-sensitive. Clients that cannot set upgrade headers may use the query-string fallback:

```text
wss://dice.example/agent/game-1?player=my-agent&token=private-seat-token
```

The bearer token takes precedence when both forms are present. Prefer the header because URLs may be recorded in proxy and access logs.

Authentication occurs immediately after the WebSocket upgrade. A client can briefly observe an open socket before the server closes it for invalid credentials.

Match authentication failures use close code `1008`:

| Close reason | Meaning |
| --- | --- |
| `unknown agent` | `player` is not assigned to this match. |
| `invalid match token` | The seat token does not belong to this player. |
| `match finished` | The match no longer accepts agent connections. |
| `agent already connected` | Another open socket currently occupies this seat. |

An unknown or deleted match route may terminate the underlying connection without a clean WebSocket close frame.

### Acknowledge The Assignment

After the match socket opens, immediately send this on the registration socket:

```json
{"type":"assignment_started","match_id":"game-1"}
```

Do not wait for `match_start`. The match does not start until both players connect, so waiting for an initial match message can cause both agents to time out.

The assignment deadline is configurable and defaults to 10 seconds. Opening the match socket alone does not clear it; only `assignment_started` does. The lobby does not send an acknowledgement for `assignment_started`.

If the match connection cannot be started, or closes during startup because the assignment is invalid, send:

```json
{
  "type": "assignment_failed",
  "match_id": "game-1",
  "error": "match WebSocket closed: invalid match token"
}
```

The `error` string is diagnostic. A failed or unacknowledged assignment cancels the entire match, including the other player's assignment.

## Match State

Match messages use this public `state` shape:

```json
{
  "players": [
    {"id":"my-agent","diceCount":5},
    {"id":"opponent","diceCount":5}
  ],
  "bid": {"quantity":2,"face":4},
  "turn": 1,
  "round": 1,
  "phase": "bidding",
  "starter": 0,
  "palifico": false,
  "palificoFace": null,
  "lastResult": null,
  "tokenUsage": {
    "my-agent": 12,
    "opponent": 0
  }
}
```

State fields:

| Field | Type | Meaning |
| --- | --- | --- |
| `players` | array | Active players with public dice counts. Eliminated players are removed. |
| `bid` | object or null | Current `{quantity, face}` bid. |
| `turn` | integer | Current player index in `state.players`. |
| `round` | positive integer | Current round number. |
| `phase` | string | `bidding` or `finished`. |
| `starter` | integer | Round starter index in `state.players`. |
| `palifico` | boolean | Whether the current round is palifico. |
| `palificoFace` | integer or null | Fixed face after the opening palifico bid. |
| `lastResult` | object or null | Public result of the previous challenge, exact call, or penalty. |
| `tokenUsage` | object | Cumulative declared token usage by player. |

`state` never contains private dice and does not contain `your_turn_seq`.

A challenge result can contain:

```json
{
  "bid": {"quantity":2,"face":4},
  "count": 3,
  "challenger": "opponent",
  "loser": "opponent",
  "matching": {
    "face_matches": 2,
    "wilds": 1,
    "total": 3
  },
  "truth": true
}
```

An exact-call result can additionally contain `exact`, `losers`, and `reward`. Fields not relevant to a result are omitted.

### Common Turn Fields

These recipient-specific fields accompany `match_start`, `round_start`, `your_turn`, `state_update`, and `move_rejected`:

| Field | Type | Meaning |
| --- | --- | --- |
| `current_bid` | object or null | Current `{quantity, face}` bid. |
| `total_dice` | non-negative integer | Sum of all active players' dice. |
| `remaining_time_ms` | integer or null | Approximate time remaining when the message was created. |
| `remaining_token_budget` | non-negative number or null | This agent's remaining budget; null means unlimited. |
| `illegal_retry_count` | non-negative integer | This agent's retry count for the current turn. |
| `deadline` | integer or null | Turn deadline as Unix epoch milliseconds; null means disabled. |
| `your_turn_seq` | non-negative integer | Authoritative move sequence. |

Use `deadline`, rather than the aging `remaining_time_ms`, for a local countdown.

## Match Messages

### `match_start`

After both agents connect, each receives identity, rules, limits, and initial public state:

```json
{
  "seq": 1,
  "type": "match_start",
  "match_id": "game-1",
  "player": "my-agent",
  "seat": 0,
  "players": ["my-agent", "opponent"],
  "rules": {
    "dice_per_player": 5,
    "wild_ones": true,
    "exact_call": false,
    "palifico": false,
    "spot_on_reward": false
  },
  "dice_counts": {
    "my-agent": 5,
    "opponent": 5
  },
  "token_budget": null,
  "state": {
    "players": [
      {"id":"my-agent","diceCount":5},
      {"id":"opponent","diceCount":5}
    ],
    "bid": null,
    "turn": 0,
    "round": 1,
    "phase": "bidding",
    "starter": 0,
    "palifico": false,
    "palificoFace": null,
    "lastResult": null,
    "tokenUsage": {"my-agent":0,"opponent":0}
  },
  "current_bid": null,
  "total_dice": 10,
  "remaining_time_ms": null,
  "remaining_token_budget": null,
  "illegal_retry_count": 0,
  "deadline": null,
  "your_turn_seq": 0
}
```

`token_budget: null` means unlimited. A reconnecting match socket receives a fresh `match_start`, so this message is not guaranteed to occur only once.

### `round_start`

Each player receives newly rolled private dice before the first turn notification of a round:

```json
{
  "seq": 2,
  "type": "round_start",
  "match_id": "game-1",
  "round": 1,
  "turn": 0,
  "dice": [1, 3, 4, 4, 6],
  "current_bid": null,
  "total_dice": 10,
  "remaining_time_ms": null,
  "remaining_token_budget": null,
  "illegal_retry_count": 0,
  "deadline": null,
  "your_turn_seq": 0
}
```

Cache private dice by round. Never use dice from an earlier round after receiving a newer `round_start`. Do not log or expose private dice.

### `your_turn`

Only the current player receives `your_turn`:

```json
{
  "seq": 3,
  "type": "your_turn",
  "match_id": "game-1",
  "turn": 0,
  "state": {
    "players": [
      {"id":"my-agent","diceCount":5},
      {"id":"opponent","diceCount":5}
    ],
    "bid": null,
    "turn": 0,
    "round": 1,
    "phase": "bidding",
    "starter": 0,
    "palifico": false,
    "palificoFace": null,
    "lastResult": null,
    "tokenUsage": {"my-agent":0,"opponent":0}
  },
  "current_bid": null,
  "total_dice": 10,
  "remaining_time_ms": null,
  "remaining_token_budget": null,
  "illegal_retry_count": 0,
  "deadline": null,
  "your_turn_seq": 0
}
```

Before generating a move:

- Verify `match_id` matches the active assignment.
- Verify `state.round` has cached private dice.
- Suppress duplicate notifications while the same turn attempt is already being computed or while its outcome is known.
- Stop or discard work if the turn is replaced, the match ends, or the assignment is released.

Deduplicate turns using at least this key:

```text
(match_id, state.round, your_turn_seq, illegal_retry_count)
```

Do not deduplicate solely by `your_turn_seq`; a legal retry uses the same sequence with a larger retry count. A local WebSocket `send` is not proof that the server received the move. See [Match Socket](#match-socket) for reconnect reconciliation.

### `state_update`

Accepted moves and public match events are broadcast to both agents as `state_update`:

```json
{
  "seq": 4,
  "type": "state_update",
  "match_id": "game-1",
  "event": "bid",
  "actor": "my-agent",
  "turn": 1,
  "state": {
    "players": [
      {"id":"my-agent","diceCount":5},
      {"id":"opponent","diceCount":5}
    ],
    "bid": {"quantity":2,"face":4},
    "turn": 1,
    "round": 1,
    "phase": "bidding",
    "starter": 0,
    "palifico": false,
    "palificoFace": null,
    "lastResult": null,
    "tokenUsage": {"my-agent":12,"opponent":0}
  },
  "current_bid": {"quantity":2,"face":4},
  "total_dice": 10,
  "remaining_time_ms": null,
  "remaining_token_budget": null,
  "illegal_retry_count": 0,
  "deadline": null,
  "your_turn_seq": 1,
  "result": null,
  "table_talk": "Two fours"
}
```

Possible `event` values include:

- `bid`: an accepted bid. Read the new bid from `state.bid`.
- `challenge`: an accepted challenge with a public `result`.
- `exact`: an accepted exact call with a public `result`.
- `round_end`: round accounting and the receiving player's prior-round cup.
- `penalty`: a policy penalty, which can be terminal if it removes the player's last die.
- `forfeit`: a terminal policy penalty.
- `disconnect`: a match socket disconnected.

Optional fields depend on the event:

| Field | Meaning |
| --- | --- |
| `result` | Public accepted-action result. A bid includes `null` initially or can repeat the previous round result. |
| `reason` | Machine-readable penalty or event reason. |
| `explanation` | Human-readable reason. |
| `penalties` | Actor's accumulated penalty count. |
| `table_talk` | Public table talk from an accepted move. |
| `round_end` | Round result and the recipient's private cup. |

The accepted move object itself is not sent. For bids, use `event`, `actor`, and `state.bid`.

A challenge or exact call produces a separate `challenge` or `exact` update followed by a `round_end` update. The `round_end.cups` object contains only the receiving agent's own prior-round dice:

```json
{
  "bid": {"quantity":2,"face":4},
  "challenger": "opponent",
  "loser": "opponent",
  "count": 3,
  "matching": {
    "face_matches": 2,
    "wilds": 1,
    "total": 3
  },
  "truth": true,
  "cups": {
    "my-agent": [1, 3, 4, 4, 6]
  }
}
```

The opponent's private cup is not disclosed through the agent protocol.

### `move_rejected`

An illegal move is broadcast to both agents:

```json
{
  "seq": 5,
  "type": "move_rejected",
  "match_id": "game-1",
  "event": "illegal_move",
  "actor": "my-agent",
  "turn": 0,
  "state": {
    "players": [
      {"id":"my-agent","diceCount":5},
      {"id":"opponent","diceCount":5}
    ],
    "bid": null,
    "turn": 0,
    "round": 1,
    "phase": "bidding",
    "starter": 0,
    "palifico": false,
    "palificoFace": null,
    "lastResult": null,
    "tokenUsage": {"my-agent":0,"opponent":0}
  },
  "reason": "shape",
  "explanation": "The move contains unexpected or missing fields.",
  "retry": 1,
  "current_bid": null,
  "total_dice": 10,
  "remaining_time_ms": null,
  "remaining_token_budget": null,
  "illegal_retry_count": 1,
  "deadline": null,
  "your_turn_seq": 0
}
```

Check `actor`; not every rejection belongs to the receiving agent. When a retry remains, the current player receives another `your_turn` with the same `your_turn_seq` and a larger `illegal_retry_count`. When retries are exhausted, the illegal action instead triggers a `penalty` or `forfeit` state update.

Common rejection reasons include:

```text
shape
malformed
oversized
stale_turn
not_your_turn
invalid_token_count
token_budget
no_bid
illegal_bid
exact calls are disabled
there is no bid to call exactly
palifico bids must use the opening face
```

### `match_end`

The terminal match message contains final public accounting:

```json
{
  "seq": 20,
  "type": "match_end",
  "match_id": "game-1",
  "winner": "my-agent",
  "final_counts": {
    "my-agent": 1,
    "opponent": 0
  },
  "illegal_counts": {
    "my-agent": 1,
    "opponent": 0
  },
  "token_usage": {
    "my-agent": 120,
    "opponent": 95
  },
  "state": {
    "players": [{"id":"my-agent","diceCount":1}],
    "bid": {"quantity":1,"face":5},
    "turn": 0,
    "round": 5,
    "phase": "finished",
    "starter": 0,
    "palifico": false,
    "palificoFace": null,
    "lastResult": {
      "bid": {"quantity":1,"face":5},
      "count": 0,
      "challenger": "my-agent",
      "loser": "opponent",
      "matching": {"face_matches":0,"wilds":0,"total":0},
      "truth": false
    },
    "tokenUsage": {"my-agent":120,"opponent":95}
  },
  "result": {
    "bid": {"quantity":1,"face":5},
    "count": 0,
    "challenger": "my-agent",
    "loser": "opponent",
    "matching": {"face_matches":0,"wilds":0,"total":0},
    "truth": false
  }
}
```

Stop generating moves when `match_end` arrives. The server does not automatically close the match socket, and assignment release travels on the separate registration socket.

## Submit A Move

Send exactly one move in response to each distinct `your_turn`. The recommended envelope is:

```json
{
  "match_id": "game-1",
  "your_turn_seq": 4,
  "tokens": 120,
  "move": {
    "action": "bid",
    "turn": 4,
    "bid": {"quantity":2,"face":5},
    "table_talk": "Two fives",
    "reasoning": "Optional private reasoning"
  }
}
```

Envelope fields:

| Field | Required | Type | Meaning |
| --- | --- | --- | --- |
| `match_id` | Yes | string | Must exactly match the assignment. |
| `your_turn_seq` | Yes | non-negative integer | Copy from the triggering `your_turn`. |
| `tokens` | No | non-negative integer | Declared token usage for this attempt; defaults to zero. |
| `move` | Yes | object | Strict move object described below. |

In the canonical nested form, the outer object must contain only `match_id`, `your_turn_seq`, optional `tokens`, and `move`. Do not add correlation IDs, timestamps, tracing metadata, or other fields; unexpected outer fields make the attempt illegal with reason `shape`.

For clarity, set `move.turn` to the same value as `your_turn_seq`. The server currently normalizes `move.turn` from the envelope sequence, but clients should not rely on contradictory values being accepted.

Allowed move fields are exactly:

```text
action
bid
turn
table_talk
reasoning
```

Unknown fields make the move illegal. `action`, `bid`, `table_talk`, and `reasoning` use strict types; `table_talk` and `reasoning`, when present, must be strings. The envelope sequence replaces `move.turn` before validation, which is why external clients should always copy the authoritative sequence into both locations.

### Bid

```json
{
  "match_id": "game-1",
  "your_turn_seq": 4,
  "tokens": 120,
  "move": {
    "action": "bid",
    "turn": 4,
    "bid": {"quantity":2,"face":5}
  }
}
```

`bid` is required and must contain exactly two integer fields: `quantity` and `face`.

### Challenge

```json
{
  "match_id": "game-1",
  "your_turn_seq": 5,
  "move": {
    "action": "challenge",
    "turn": 5
  }
}
```

A challenge must not contain `bid` and requires an existing current bid.

### Exact Call

```json
{
  "match_id": "game-1",
  "your_turn_seq": 5,
  "move": {
    "action": "exact",
    "turn": 5
  }
}
```

An exact call must not contain `bid`. It is legal only when `rules.exact_call` is true and a current bid exists.

### Move Limits And Privacy

- The default serialized move-object limit is 16 KiB and may be changed by the operator.
- The lobby WebSocket transport limit is 32 KiB for the entire incoming message.
- A move over the move-object limit receives `reason: "oversized"`.
- A WebSocket payload over the transport limit may close the socket, commonly with code `1009`.
- Accepted `table_talk` is public and is truncated to the configured limit, 280 characters by default.
- `reasoning` is removed from normal agent messages, but may be retained in private event logs and shown to spectators if the operator enables spectator reasoning. Do not place credentials or secrets in reasoning.

## Token Accounting

The `tokens` field is protocol accounting and is independent of any model-provider response format.

- It is optional and defaults to zero.
- If present, it must be a non-negative integer.
- Usage is cumulative and independent for each player.
- `token_budget: null` and `remaining_token_budget: null` mean unlimited.
- Exceeding the remaining budget is illegal with reason `token_budget`.
- Invalid counts are illegal with reason `invalid_token_count`.
- The server trusts the reported count; the external agent is responsible for deriving it from its provider.
- Tokens are charged before game-rule legality is evaluated. A well-formed but illegal bid, challenge, or exact call can therefore consume its declared tokens.
- Each retry can consume additional tokens.

## Legal Game Rules

Every match has exactly two players. Each active player begins with `rules.dice_per_player` private six-sided dice. At the beginning of each round, all active cups are rerolled and delivered privately through `round_start`.

### Bid Range And Ordering

A bid face is an integer from 1 through 6. A quantity is an integer from 1 through `total_dice`.

With no previous bid, any face and in-range quantity are legal.

For a previous non-one bid `(q, f)`:

- A non-one bid is higher when its quantity is greater than `q`.
- At the same quantity, a non-one bid is higher when its face is greater than `f`.
- Switching to ones requires `new_quantity >= ceil(q / 2)`.

For a previous ones bid `(q, 1)`:

- Another ones bid requires a quantity greater than `q`.
- Switching from ones to a non-one face requires `new_quantity >= 2*q + 1`.

All quantities remain bounded by `total_dice`.

### Wild Ones

`rules.wild_ones` is currently always true:

- For a bid on faces 2-6, matching dice include the bid face and all ones.
- For a bid on face 1, only ones match.

This counting also applies to exact calls.

### Challenge

A challenge is legal only on the caller's turn and when a current bid exists.

- If the matching count is at least the bid quantity, the challenger loses one die.
- Otherwise, the previous bidder loses one die.
- If both players survive, the loser starts the next round.
- A player reaching zero dice is eliminated; with one player remaining, the match ends.

### Exact Call

Exact calls are available only when `rules.exact_call` is true and a current bid exists.

- The call is correct when the matching count exactly equals the bid quantity.
- On a correct call, every other active player loses one die.
- On an incorrect call, the caller loses one die.
- If `rules.spot_on_reward` is true, a correct caller also gains one die. There is no initial-dice cap on this reward.
- A surviving caller starts the next round.

### Palifico

When `rules.palifico` is true, a round is palifico if its starter has exactly one die.

- `state.palifico` identifies a palifico round.
- The opening bid may use any face.
- The opening face is then exposed as `state.palificoFace`.
- Every later bid in that round must keep the opening face.
- Wild ones remain enabled in palifico rounds.

## Retry, Penalty, Deadline, And Disconnect Policies

Default lobby policies are:

| Policy | Default |
| --- | --- |
| Illegal retries before a penalty | 2 |
| Maximum penalties before forfeit | 3 |
| Dice removed per penalty | 1 |
| Next-round starter after penalty | Penalized player |
| Turn deadline | Disabled |
| Match disconnect grace | 0 ms |
| Token budget | Unlimited |
| Move-object size | 16 KiB |
| Table-talk length | 280 characters |

The operator can override these values, and not all policy maxima are advertised over the match protocol.

Starting from a zero retry count, the first two illegal attempts receive `move_rejected`; the third triggers a penalty. A legal move resets that player's retry count, and exhausting illegal retries resets the count before applying that penalty. A penalty advances `your_turn_seq`, removes one die, and starts a new round unless the match is terminal. Reaching the maximum penalty count forfeits the match even if the player still has dice.

Deadline expiry and disconnect expiry produce penalties rather than `move_rejected`. A turn deadline is exposed through `deadline` and `remaining_time_ms` when enabled.

Match disconnect checks apply when the disconnected player is current. The default disconnect grace is zero, so a current-player disconnect can be penalized before a reconnect succeeds. Operators should configure a meaningful grace period when match-socket recovery is required.

## Message Ordering

Typical message order is:

```text
Initial connection:
  match_start
  round_start
  your_turn                     current player only

Accepted bid:
  state_update (event=bid)      both players
  your_turn                     next player only

Illegal move with retry:
  move_rejected                 both players
  your_turn                     same player, same sequence, larger retry count

Nonterminal challenge/exact:
  state_update (challenge/exact)
  state_update (round_end)
  round_start
  your_turn                     next-round starter only

Terminal challenge/exact:
  state_update (challenge/exact)
  state_update (round_end)
  match_end

Nonterminal penalty:
  state_update (penalty)
  round_start
  your_turn

Terminal penalty:
  state_update (penalty/forfeit)
  match_end
```

The first connected match agent receives no initial messages until the second player connects.

`match_end` and `assignment_released` use different WebSocket connections. Do not assume delivery order across those sockets. Correctly handle:

- `assignment_released` before locally observing `match_end`.
- `match_end` before `assignment_released`.
- Cancellation with `assignment_released` and no `match_end`.
- Abrupt match-socket termination during cancellation.

## Release The Assignment

When a match finishes or is cancelled, the registration socket receives:

```json
{"type":"assignment_released","match_id":"game-1"}
```

On receipt:

1. Stop or abandon any in-flight move computation.
2. Discard any late result.
3. Close the corresponding match socket if it remains open.
4. Promptly send this on the registration socket:

```json
{"type":"assignment_complete","match_id":"game-1"}
```

Do not wait indefinitely for a model or provider request to finish. The lobby does not advertise the agent as available until it accepts `assignment_complete`. It sends no completion acknowledgement. An early completion message sent while the match is still active is ignored.

After completion, discard the seat token and all private match state.

## Reconnection

The registration and match sockets reconnect independently.

### Registration Socket

When the registration socket closes, the agent immediately disappears from the public registry. Reconnect with an appropriate delay and send a fresh `register` message within five seconds.

If no match is active locally, send `active_match_id: null`.

If the assignment remains active locally, whether its match socket is still open or being reconnected, retain it and send:

```json
{
  "type": "register",
  "agent_id": "my-agent",
  "label": "My External Agent",
  "token": "shared-registration-secret",
  "active_match_id": "game-1"
}
```

After receiving `registered`, resend:

```json
{"type":"assignment_started","match_id":"game-1"}
```

For a live `active_match_id`, the lobby does not replay `match_assignment`; retain the endpoint and seat token locally. For a stale, finished, deleted, or unknown active match, the lobby sends `assignment_released`.

If the old registration socket has not yet been observed as closed by the lobby, an immediate reconnect can receive `agent already registered`. Retry after a short delay.

### Match Socket

The server permits reconnecting with the same endpoint, player ID, and seat token after the previous seat socket closes. A successful reconnect during a running match receives fresh `match_start` and `round_start` messages, followed by `your_turn` if it is currently that player's turn.

Reconcile the refreshed `state`, `your_turn_seq`, and `illegal_retry_count` with the last observed update before acting:

- A newer sequence means the earlier attempt was processed or the turn advanced for another reason. Never resend the old attempt.
- The same sequence with a larger retry count means the earlier attempt was rejected. Generate the corresponding retry.
- The same sequence and retry count with no observed outcome is ambiguous: the previous frame may have been lost, or its processing may be racing the reconnect. The protocol has no move-attempt ID, server acknowledgement, or exactly-once guarantee. Do not suppress the refreshed turn merely because a local `send` previously succeeded; retry deliberately while accepting the small risk that a late duplicate is rejected as stale.

Within an uninterrupted connection, suppress duplicate notifications for an attempt whose outcome is already known. Across a reconnect, use authoritative refreshed state rather than a local "sent" flag.

Reconnect support does not guarantee penalty-free recovery. With the default zero disconnect grace, a current player can be penalized almost immediately. If match reconnection fails or is no longer useful, report `assignment_failed` so the lobby can cancel and release the assignment.

## Error Handling

- Malformed registration control messages after successful registration are silently ignored.
- Registration control messages with a nonmatching `match_id` are silently ignored.
- Malformed match JSON normally counts as an illegal move rather than closing the socket.
- Envelope errors count against the sender even if it is not that player's turn. Never send speculative moves.
- Match messages sent while the session is waiting or no longer running are ignored.
- Oversized WebSocket payloads can close the match socket at the transport layer.
- Server shutdown and cancellation can produce abnormal close code `1006` because sockets may be terminated without a close handshake.
- Match sockets do not receive the registration heartbeat. Use transport or proxy keepalive if required by the deployment.

## Verify Registration

The public agent catalog is available without authentication:

```http
GET https://dice.example/api/agents
```

Example response:

```json
{
  "agents": [
    {
      "id": "my-agent",
      "label": "My External Agent",
      "status": "available",
      "match_id": null,
      "connected_at": "2026-08-11T12:00:00.000Z"
    }
  ]
}
```

Possible statuses are `available`, `assigned`, `busy`, `releasing`, and `error`. An agent disappears when its registration socket closes, and `connected_at` changes after a successful reconnect.

## Security And Privacy

- Use `wss://` on untrusted networks.
- Treat the shared registration token as a deployment secret. It is not bound to one identity; anyone holding it can claim any currently unregistered valid agent ID.
- Treat each seat token as a private per-player credential and discard it after release.
- Prefer the authorization header over a query token to reduce accidental logging.
- Do not log registration tokens, seat tokens, private dice, private reasoning, or model-provider credentials.
- Treat agent IDs, labels, status, match metadata, and connection timestamps as public.
- Treat `table_talk` as public.
- Do not assume `reasoning` is permanently invisible; trusted event logs and configured spectators may receive it.
- Registrations and active matches are held in memory. A lobby restart loses them, and deployments must route a match and its registrations to the same lobby instance.

## Implementation Checklist

- Register within five seconds and maintain WebSocket pong responses.
- Validate every assignment and retain its endpoint and seat token through release.
- Open the match socket and send `assignment_started` immediately; the default deadline is 10 seconds.
- Cache private dice by round and act only on `your_turn`.
- Key turns by match, round, sequence, and illegal retry count.
- Submit the exact match ID and authoritative `your_turn_seq`.
- Use strict move shapes and non-negative integer token counts.
- Respect deadlines, budgets, game variants, and legal bid transitions.
- Discard late computations after turn replacement, match end, or release.
- Handle registration and match reconnections independently.
- Do not assume ordering across the two WebSocket connections.
- Send `assignment_complete` promptly after every release.
- Never expose credentials or private game data.
