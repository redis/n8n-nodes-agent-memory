# Operations

Every parameter of **Redis Agent Chat Memory** and **Redis Agent Memory**, by resource and operation. **Redis Agent Memory Tool** is the action node in the AI Agent's Tool picker and has the same parameters. Parameter names in `code` are the keys in a workflow's JSON, useful when you set them by expression or edit an exported workflow.

## Redis Agent Chat Memory

| Parameter | Key | Default | Description |
|---|---|---|---|
| Session ID | `sessionId` | `{{ $json.sessionId }}` | Conversation identifier. |
| User ID | `actorId` | | The user the conversation belongs to. Extracted long-term memories are owned by this user. |
| Recall Long-Term Memories | `recallLongTermMemories` | off | Search the user's long-term memories on every turn and give the results to the model. |
| Recall Query | `recallQuery` | `{{ $json.chatInput }}` | Text to search long-term memories with. Shown when recall is on. |
| Recall Limit | `recallLimit` | 5 | Max number of long-term memories to recall per turn. |
| Options → Context Window Length | `options.windowSize` | 50 | How many past interactions are sent to the model (1–500). |
| Options → Include Summary | `options.includeSummary` | on | Prepend the server's summary of older turns. |
| Options → Namespace ID | `options.namespaceId` | | Bind the session to a namespace. |
| Options → Summary View ID | `options.summaryViewId` | | Give the model this view's summary of the user on every turn. |
| Options → Verify Session Owner | `options.verifyOwner` | off | Refuse a session the server says belongs to another user. |

## Redis Agent Memory

Resource is `resource`, operation is `operation`. The resource values are `longTermMemory`, `session`, `namespace` and `summaryView`.

### Long-Term Memory

#### Search (`search`)

Search a user's long-term memories by meaning.

| Parameter | Key | Required | Description |
|---|---|---|---|
| Query | `query` | yes | Text to search for. Memories are ranked by meaning, not by keyword. |
| User ID | `ownerId` | yes | Only memories owned by this user are searched. |
| Limit | `limit` | | Max number of results, 1–100 (default 50). |
| Simplify | `simple` | | Default on. |
| Include Sources | `includeSources` | | Keep where each memory came from, in short form. Shown when Simplify is on. |
| Options → Memory Type | `options.memoryType` | | Only memories of this type, built-in or custom. |
| Options → Namespace ID | `options.namespaceId` | | Only memories in this namespace. |
| Options → Session ID | `options.sessionId` | | Only memories extracted from this session. |
| Options → Similarity Threshold | `options.similarityThreshold` | | Minimum similarity, 0–1. 0 returns the closest matches regardless of score. |
| Options → Topics | `options.topics` | | Only memories tagged with any of these topics, comma-separated. |

#### Get Many (`getAll`)

List long-term memories that match the filters. At least one filter is required.

| Parameter | Key | Description |
|---|---|---|
| Return All | `returnAll` | Return every result instead of the first Limit. |
| Limit | `limit` | Max number of results, 1–100 (default 50). |
| Simplify | `simple` | Default on. |
| Include Sources | `includeSources` | As on Search. |
| Filters → Memory Type | `filters.memoryType` | Only memories of this type. |
| Filters → Namespace ID | `filters.namespaceId` | Only memories in this namespace. |
| Filters → Session ID | `filters.sessionId` | Only memories extracted from this session. |
| Filters → Topics | `filters.topics` | Any of these topics, comma-separated. |
| Filters → User ID | `filters.ownerId` | Only memories owned by this user. |

#### Create (`create`)

Store a fact as a long-term memory of a user. Creating the same Memory ID again replaces the memory with the fields given.

| Parameter | Key | Required | Description |
|---|---|---|---|
| Text | `text` | yes | The fact to remember, in plain language. |
| User ID | `ownerId` | yes | Owner of the memory. |
| Simplify | `simple` | | Default on. |
| Additional Fields → Memory ID | `additionalFields.memoryId` | | Letters, digits and dashes. Generated when empty. |
| Additional Fields → Memory Type | `additionalFields.memoryType` | | Built-in or a custom type registered on the store. |
| Additional Fields → Namespace ID | `additionalFields.namespaceId` | | Namespace to place the memory in. |
| Additional Fields → Session ID | `additionalFields.sessionId` | | Session the memory came from. |
| Additional Fields → Topics | `additionalFields.topics` | | Topic tags, comma-separated. |

#### Get (`get`)

| Parameter | Key | Required | Description |
|---|---|---|---|
| Memory ID | `memoryId` | yes | ID of the memory. |
| Simplify | `simple` | | Default on. |
| Include Sources | `includeSources` | | As on Search. |

#### Get Sources (`getSources`)

List the sessions or documents a memory was extracted from, with the evidence. One output item per source.

| Parameter | Key | Required | Description |
|---|---|---|---|
| Memory ID | `memoryId` | yes | ID of the memory. |
| Return All | `returnAll` | | Return every source. |
| Limit | `limit` | | Max number of sources, 1–100 (default 50). |
| Simplify | `simple` | | Default on. |

#### Update (`update`)

| Parameter | Key | Required | Description |
|---|---|---|---|
| Memory ID | `memoryId` | yes | ID of the memory. |
| Simplify | `simple` | | Default on. |
| Update Fields → Memory Type | `updateFields.memoryType` | | New type. |
| Update Fields → Namespace ID | `updateFields.namespaceId` | | New namespace. |
| Update Fields → Session ID | `updateFields.sessionId` | | New source session. |
| Update Fields → Text | `updateFields.text` | | New content. |
| Update Fields → Topics | `updateFields.topics` | | Replaces the existing topics. |
| Update Fields → User ID | `updateFields.ownerId` | | New owner. |

#### Delete (`delete`)

| Parameter | Key | Required | Description |
|---|---|---|---|
| Memory ID | `memoryId` | yes | ID of the memory. Returns `{ deleted: true, memoryId }`. |

#### Move (`move`)

| Parameter | Key | Required | Description |
|---|---|---|---|
| Memory ID | `memoryId` | yes | ID of the memory. |
| Namespace | `namespaceId` | yes | Resource locator: from the store's list (`mode: "list"`) or an ID or expression (`mode: "id"`). |

### Session

#### Get (`get`)

Get the events and summary of a session.

| Parameter | Key | Required | Description |
|---|---|---|---|
| Session ID | `sessionId` | yes | ID of the session. |
| Simplify | `simple` | | Default on. |
| Options → Include Summarized Events | `options.includeSummarisedEvents` | | Also return the older events the summary already covers. |

#### Get Many (`getAll`)

List sessions. Without a filter, every session on the store. Each item has `sessionId`, `ownerId`, `namespaceId`, `createdAt` and `updatedAt`.

| Parameter | Key | Description |
|---|---|---|
| Return All | `returnAll` | Return every session. |
| Limit | `limit` | Max number of sessions (default 50). |
| Filters → User ID | `filters.ownerId` | Only sessions owned by this user. |

#### Delete (`delete`)

Delete a session with its events and summary. Long-term memories extracted from it stay.

| Parameter | Key | Required | Description |
|---|---|---|---|
| Session ID | `sessionId` | yes | Returns `{ deleted: true, sessionId }`. |

#### Add Event (`addEvent`)

Append a message to a session. The session is created when it does not exist.

| Parameter | Key | Required | Description |
|---|---|---|---|
| Session ID | `sessionId` | yes | ID of the session. |
| User ID | `actorId` | yes | User the message belongs to. Extracted memories are owned by this user. |
| Role | `role` | | `USER` (default), `ASSISTANT` or `SYSTEM`. |
| Text | `text` | yes | Content of the message. |
| Additional Fields → Created At | `additionalFields.createdAt` | | When the message was said. Defaults to now. |
| Additional Fields → Namespace ID | `additionalFields.namespaceId` | | Bind the session to a namespace. |

#### Delete Event (`deleteEvent`)

Delete one event, keeping the rest and the summary.

| Parameter | Key | Required | Description |
|---|---|---|---|
| Session ID | `sessionId` | yes | ID of the session. |
| Event ID | `eventId` | yes | ID of the event. Session → Get returns the IDs. |

### Namespace

#### Create (`create`)

| Parameter | Key | Required | Description |
|---|---|---|---|
| Name | `name` | yes | Name of the namespace. |
| Scope | `scope` | | `SHARED` (default) or `PERSONAL`. Ignored when Parent ID is set: a child inherits its parent's scope. |
| Simplify | `simple` | | Default on. |
| Additional Fields → Parent ID | `additionalFields.parentId` | | Nest under this namespace. |
| Additional Fields → User ID | `additionalFields.ownerId` | | Owner, for personal namespaces. |

#### Get (`get`), Update (`update`), Delete (`delete`)

| Parameter | Key | Required | Description |
|---|---|---|---|
| Namespace | `namespaceId` | yes | Resource locator: list, or ID or expression. |
| Simplify | `simple` | | Get and Update. Default on. |
| Update Fields → Name | `updateFields.name` | | New name. |
| Update Fields → Archive | `updateFields.archive` | | Archive the namespace. The API cannot make an archived namespace active again. |

#### Get Many (`getAll`)

| Parameter | Key | Description |
|---|---|---|
| Return All | `returnAll` | Return every namespace. |
| Limit | `limit` | Max number (default 50). |
| Simplify | `simple` | Default on. |

### Summary View

#### Get Result (`getResult`)

Read the summary of one group.

| Parameter | Key | Required | Description |
|---|---|---|---|
| View | `viewId` | yes | Resource locator: list, or ID or expression. |
| Group → User ID / Session ID / Namespace ID / Memory Type | `group.ownerId`, `group.sessionId`, `group.namespaceId`, `group.memoryType` | | The keys the view groups by. |
| Wait For Result | `waitForResult` | | Poll every 2 seconds until `READY`, `EMPTY` or `FAILED`. |
| Max Wait (Seconds) | `maxWaitSeconds` | | Fail after this long (default 60). Shown when waiting. |
| Options → Include Source Memory IDs | `options.includeSourceMemoryIds` | | Return the IDs of the memories the summary was computed from. |
| Simplify | `simple` | | Default on. |

#### Refresh (`refresh`)

| Parameter | Key | Required | Description |
|---|---|---|---|
| View | `viewId` | yes | Resource locator. |
| Target | `target` | | `PARTITION` (default): one group, selected by Group. `FULL`: every group. |
| Group → … | `group.*` | | For a Partition refresh, the group to recompute. |
| Wait For Result, Max Wait | `waitForResult`, `maxWaitSeconds` | | Partition only. |
| Simplify | `simple` | | Default on. |

#### Create (`create`)

| Parameter | Key | Required | Description |
|---|---|---|---|
| Name | `name` | yes | Name of the view. |
| Group By | `groupBy` | yes | Array of `ownerId`, `sessionId`, `namespaceId`, `memoryType` (default `["ownerId"]`). |
| Output Format | `outputFormat` | | `TEXT` (default) or `STRUCTURED`. |
| Instructions | `instructions` | | What the summary should focus on. |
| Refresh Mode | `refreshMode` | | `MANUAL` (default) or `CONTINUOUS`. |
| Simplify | `simple` | | Default on. |
| Additional Fields | `additionalFields.*` | | `debounceSeconds`, `description`, `maxPartitions`, `memoryType`, `namespaceId`, `reconcileIntervalSeconds`, `schema` (JSON, `{ "fields": [...] }`), `sessionId`, `timeWindowSeconds`, `topics`, `ownerId`, `visibility` (`PRIVATE` default, or `SHARED`). |

#### Get (`get`), Delete (`delete`)

| Parameter | Key | Required | Description |
|---|---|---|---|
| View | `viewId` | yes | Resource locator. |
| Simplify | `simple` | | Get only. Default on. |

#### Get Many (`getAll`)

| Parameter | Key | Description |
|---|---|---|
| Return All | `returnAll` | Return every view. |
| Limit | `limit` | Max number (default 50). |
| Simplify | `simple` | Default on. |

#### Update (`update`)

| Parameter | Key | Required | Description |
|---|---|---|---|
| View | `viewId` | yes | Resource locator. |
| Simplify | `simple` | | Default on. |
| Update Fields | `updateFields.*` | | Every Create field (`name`, `groupBy`, `outputFormat`, `instructions`, `refreshMode` and the Additional Fields) plus `state` (`ACTIVE` or `DISABLED`), `clearFilter` and `clearTimeWindow`. |

## Credential

**Redis Agent Memory API** (`redisAgentMemoryApi`): `serverUrl` (host only; the nodes add `/iris/data/v1/agent-memory`), `storeId`, `apiKey`. The credential test calls the store's health endpoint.
