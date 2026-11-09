# Summary Views

A summary view is a standing summary the server keeps over long-term memories, one per group: per user, session, namespace or memory type. It gives a workflow a "standing briefing" in one call, where template authors otherwise chain dozens of nodes or have a human type the note: the hand-off packet at escalation, the weekly "what did the agent learn about each customer" digest, the state a scheduled agent reads at the start of each run, a tutor's per-student progress. No other n8n memory integration offers shared, grouped, on-demand summaries.

!!! note
    Summary views must be enabled on the store.

## Define a view

**Summary View → Create** takes:

| Field | Meaning |
|---|---|
| **Name** | A name for the view, for example `customer-briefing`. |
| **Group By** | One summary per distinct value of these keys: *User*, *Session*, *Namespace*, *Memory Type*, or a combination. **Get Result** then selects a summary with the same keys. |
| **Output Format** | *Text* (prose) or *Structured* (an object that follows the **Schema** under Additional Fields, for example `{ "fields": [...] }` with `dietary`, `city`, `language`). |
| **Instructions** | What the summary should focus on, in plain language. |
| **Refresh Mode** | *Manual*: a summary is computed only after **Refresh**. *Continuous*: recomputed whenever the memories change, at a model call per change; **Debounce** and **Reconcile Interval** under Additional Fields tune it. |
| Additional Fields | Filters (User ID, Namespace ID, Session ID, Memory Type, Topics, a **Time Window** in seconds), **Max Partitions** (how many groups the server keeps), **Visibility** (*Private* or *Shared* with the store's other API keys), **Description**. |

**Update** changes any of these, plus **State** (*Active* or *Disabled*; a disabled view keeps its results) and the switches **Clear Filter** and **Clear Time Window**. **Delete** removes the view and its results.

## Read a group

**Get Result** reads one group's summary. Give the keys the view groups by under **Group**, for example the User ID for a view grouped by user. The result's `status` is:

| Status | Meaning |
|---|---|
| `COLD` | Never computed for this group. |
| `PENDING`, `REFRESHING` | Being computed. |
| `READY` | `text` (or `data`) holds the summary; `computedAt` says when. |
| `EMPTY` | Computed, but the group has no memories to summarize. |
| `FAILED` | The server could not compute it; `errorCode` says why. |

`stale` is true when memories changed since `computedAt`. `sourceMemoryCount` and `summarizedMemoryCount` say how much went in; `truncated` warns that not everything fit. **Include Source Memory IDs** under Options adds the IDs the summary was computed from.

**Wait For Result** polls every two seconds until the status is `READY`, `EMPTY` or `FAILED`, and fails after **Max Wait** seconds (default 60). A `FAILED` result is returned as an item with its `errorCode`, not thrown.

## Refresh

**Refresh** asks the server to compute again. **Target** *Partition* recomputes one group, selected by the **Group** keys, and can **Wait For Result** like Get Result does, so "refresh this customer and give me the text" is one node. *Full* recomputes every group and returns `{ viewId, target, accepted }` at once; read the groups afterwards with Get Result and Wait For Result.

## Patterns

- **Hand-off packet.** At escalation, Refresh (Partition, Wait For Result) for the customer's User ID, then paste `text` into the ticket. The [hand-off example](../examples.md#hand-off-packet-and-weekly-digest) does this from a webhook.
- **Weekly digest.** Schedule → Refresh (Full) → one Get Result per known user → join the texts. Same example.
- **Standing briefing for an agent.** Set the chat memory node's **Summary View ID** option to a view grouped by user: the model gets the user's briefing on every turn, before the session summary, once it is computed. Adds one request per turn.
- **"What do you know about me?"** A **Redis Agent Memory Tool** set to Get Result with the view and the User ID group pinned answers in one call.
- **Structured profile fields.** A *Structured* view with a schema fills CRM columns from conversations without a parsing step.
