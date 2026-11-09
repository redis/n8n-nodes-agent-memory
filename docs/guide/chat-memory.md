# Chat Memory

**Redis Agent Chat Memory** connects to the **Memory** input of an AI Agent.

**Loading history.** The node returns the session's recent turns to the AI Agent. When enabled, they are preceded by the server-maintained summary of older turns, by a summary view's briefing on the user, and by long-term memories recalled for the current message. The Chat Trigger's *Load Previous Session* and n8n's Chat Memory Manager node get the turns only.

**Saving history.** The node appends each user and assistant message as a session event. Tool calls and tool results are not stored, so the most-voted n8n memory bug, the agent writing every tool output into memory, cannot happen here. Agent Memory then extracts long-term memories from the events asynchronously.

## Parameters

| Parameter | Description |
|---|---|
| Session ID | Conversation identifier. Defaults to `{{ $json.sessionId }}` from the Chat Trigger. |
| User ID | The user the conversation belongs to. Extracted long-term memories are owned by this user. |
| Recall Long-Term Memories | Whether to search the user's long-term memories on every turn and give the results to the model (default off). The switch alone is enough: the query defaults to the current message. |
| Recall Query | Text to search with; shown when recall is on. Defaults to `{{ $json.chatInput }}`, the current message. |
| Recall Limit | Max memories to recall per turn (default 5); shown when recall is on. |
| Options → Context Window Length | How many past interactions are sent to the model (default 50, max 500). Keep it at least as high as the number of turns the server retains; see below. An expression must resolve to a whole number of 1 or more, or the run fails; an empty value means the default. |
| Options → Include Summary | Whether to prepend the summary of older turns (default on). |
| Options → Namespace ID | Binds the session to a namespace, so extracted memories land in it and recall searches only it. |
| Options → Summary View ID | ID of a summary view grouped by user. When set, the view's summary of the User ID is given to the model on every turn, before the session summary, once the server has computed it; until then, and if the view is gone, nothing is added. A result the server scopes to another user, or to no user, is ignored. Adds one request per turn. Empty by default. See [Summary Views](summary-views.md). |
| Options → Verify Session Owner | Whether to refuse a session that the server says belongs to another user (default off). See [Sessions](data-model.md#sessions). |

## What the model receives

In order, when each part is present:

1. The summary view's briefing on the user (**Summary View ID** set and computed).
2. The server's summary of the older turns of this session (**Include Summary** on).
3. The long-term memories recalled for the current message (**Recall Long-Term Memories** on).
4. The last **Context Window Length** turns the server has kept.

## Context window

The history is trimmed in up to three places:

- The **server** keeps the recent turns of a session and folds older ones into the summary.
- The **node** sends the model the last **Context Window Length** turns of what the server kept, preceded by the summary.
- The **AI Agent** may trim once more, by tokens, if you set its *Max Tokens From Memory*.

The server is the main control: a turn it has retained but the summary does not cover yet is sent only if it falls inside the node's window. So keep **Context Window Length** at least as high as the number of turns your store retains before summarizing. The default of 50 is chosen for that; lower it only if your store retains fewer turns.

## Chat Memory Manager

n8n's own **Chat Memory Manager** node, which is not part of this package, works with this memory, with limits:

- *Get Many Messages* and *Insert Messages* work.
- *Insert Messages* with *Override All Messages* replaces the session: the summary is dropped and the new messages are extracted as new content.
- *Delete Messages* with *All Messages* deletes the session.
- *Delete Messages* with *Last N* is **not supported**: n8n implements it by deleting the session and re-inserting the kept turns through this node, which drops the summary and may extract the same facts again. The kept turns also get new event IDs, their `actorId` becomes the user of the deleting workflow, and that user becomes the session's owner.

To trim a session, use the action node's **Session → Delete Event**. To correct or remove what was learned, use **Long-Term Memory → Search** and **Delete**, or follow the [Memory Sources](provenance.md) guide.
