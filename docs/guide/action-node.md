# Action Node and Tools

One node with two faces. In the node list it is **Redis Agent Memory**, an action node the workflow runs to manage what the memory sub-node writes. In an AI Agent's Tool picker n8n lists the same node as **Redis Agent Memory Tool**, a tool sub-node the model calls when it decides to search or save a memory. Each operation is one REST call on the credential's store.

## Resources and operations

| Resource | Operations |
|---|---|
| Long-Term Memory | Search (by meaning, for one user), Get Many (by filters), Create, Get, Get Sources (the sessions or documents a memory came from), Update, Delete, Move (to another namespace) |
| Session | Get, Get Many, Delete, Add Event, Delete Event |
| Namespace | Create, Get, Get Many, Update, Delete |
| Summary View | Get Result (one group's summary), Refresh, Create, Get, Get Many, Update, Delete |

Every field of every operation is listed in the [Operations reference](../reference/operations.md).

## Using the node as a tool

Attach one **Redis Agent Memory Tool** per operation to the Agent's **Tool** input and pin everything but the content: set **Resource**, **Operation** and **User ID** yourself, and let the model fill **Query** (Search) or **Text** (Create) with *Let the model define this parameter*. Two instances cover most agents:

- *Search memories*: Long-Term Memory → Search, User ID fixed. The agent calls it when it needs something it was told before.
- *Save memory*: Long-Term Memory → Create, User ID fixed. The agent calls it to remember a fact right away, without waiting for extraction.

!!! danger "Never let the model fill User ID"
    The User ID is what keeps one user's memories away from another. Set it from the workflow, for example `{{ $('Identify the user').item.json.userId }}`.

Extraction is asynchronous, so a fact said in this turn may not be searchable until the next one; *Save memory* is how an agent makes a fact available at once.

Other safe tools: **Get Sources** and **Search** with *Include Sources* (read-only, lets the agent cite where it learned something) and **Summary View → Get Result** with the view and the User ID group pinned ("what do you know about me?" in one call).

## Search and Get Many

**Search** ranks a user's memories by meaning against a **Query** and returns up to **Limit** results (1–100). Options narrow it: **Memory Type**, **Namespace ID**, **Session ID**, **Topics** (any of a comma-separated list) and a **Similarity Threshold** between 0 and 1 (0 returns the closest matches regardless of score).

**Get Many** lists memories by filters alone, without a query: **User ID**, **Memory Type**, **Namespace ID**, **Session ID**, **Topics**. At least one filter is required. It pages through the server's results with **Return All** or **Limit**. Use it for clean-up ("every memory from this session") and audits; use Search when a question is involved.

## Create, Update, Delete and Move

- **Create** stores a **Text** for a **User ID**, with optional **Memory ID**, **Memory Type**, **Namespace ID**, **Session ID** and **Topics**. Creating the same Memory ID again replaces the memory, which is how a workflow keeps a single fact current.
- **Update** changes any of the same fields on an existing memory. **Topics** replaces the existing topics.
- **Delete** removes one memory. Deletion is permanent.
- **Move** places a memory in another namespace, chosen from the store's list or given as an ID or expression.

## Output

Every operation that returns records has a **Simplify** switch, on by default, which keeps the fields a workflow usually needs:

| Record | Simplified fields |
|---|---|
| Memory | `memoryId`, `text`, `ownerId`, `memoryType`, `topics`, `namespaceId`, `sessionId`, `createdAt`; with **Include Sources** on (Search, Get, Get Many), `sources`: `sourceId`, `kind`, `sessionId` or `documentId`, `eventIds` |
| Source (Get Sources) | `sourceId`, `kind`, `sessionId`, `documentId`, `revision`, `eventIds` (every event behind the source, in one list), `evidenceCount` (the number of evidence entries, not of events), `capturedAt` (when the first evidence entry was recorded) |
| Session (Get) | `sessionId`, `ownerId`, `namespaceId`, the `summary` text and the `events`, each with `eventId`, `actorId`, `role`, `text`, `createdAt` |
| Session (Get Many) | `sessionId`, `ownerId`, `namespaceId`, `createdAt`, `updatedAt` |
| Namespace | `namespaceId`, `name`, `scope`, `state`, `parentId`, `ownerId` |
| Summary view | `viewId`, `name`, `visibility`, `groupBy`, `state`, `outputFormat`, `refreshMode`, `updatedAt` |
| Summary view result | `viewId`, `status`, `stale`, the `text` or `data`, `computedAt`, `sourceMemoryCount`, `summarizedMemoryCount`, `truncated` and, when present, `sourceMemoryIds` and `errorCode` |

Switch **Simplify** off for the API's object as it came. Delete operations return `{ deleted: true }` with the ID that was deleted.

**Resource locators.** The **Namespace** field of Namespace → Get, Update, Delete and Long-Term Memory → Move offers the store's namespaces from a list, or takes an ID or expression; the **View** field of Summary View does the same for the store's views.

## Errors

The node turns the API's Problem Details into n8n errors: the server's `detail` becomes the message and `title (HTTP n)` the description. A `404` with the resource-not-found type is the only "not found" the node recognises; a read-only API key answers `403`. With *Continue On Fail* on, the error lands on the item and the workflow can branch on it.
