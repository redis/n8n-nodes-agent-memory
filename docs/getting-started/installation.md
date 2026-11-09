# Installation

## Requirements

| Dependency | Supported versions |
|---|---|
| n8n | 2.42.6 tested by the end-to-end suite, and nightly on the latest release; releases that ship `@n8n/ai-node-sdk` |
| `@n8n/ai-node-sdk` | 0.32.4 or later, provided by n8n |
| Redis Agent Memory | a store on an Agent Memory service, with an API key |

Older n8n versions that ship `@n8n/ai-node-sdk` may work but are not tested.

## Install the node

=== "n8n UI"

    1. Open **Settings → Community Nodes**.
    2. Choose **Install**, enter `@redis/n8n-nodes-agent-memory`, accept the risk notice and install.
    3. Three entries appear in the node picker: **Redis Agent Chat Memory** under AI → Memory, **Redis Agent Memory** in the main node list, and **Redis Agent Memory Tool** in the AI Agent's Tool picker.

    This is the path for self-hosted n8n and for n8n Cloud once the node is verified. See the [n8n community nodes guide](https://docs.n8n.io/integrations/community-nodes/installation/) for the current rules.

=== "Command line"

    In the n8n installation directory (for Docker, inside the container's `~/.n8n/nodes` folder):

    ```bash
    npm install @redis/n8n-nodes-agent-memory
    ```

    Restart n8n afterwards.

=== "From source"

    ```bash
    git clone https://github.com/redis/n8n-nodes-agent-memory.git
    cd n8n-nodes-agent-memory
    npm install
    npm run dev        # builds and starts n8n with this node at http://localhost:5678
    ```

    `npm run dev` runs n8n in a container from n8n 3.0 onward, so Docker or Podman is required. Use `npx n8n-node dev --external-n8n` to attach to an n8n you already run.

!!! warning "Upgrading from 0.3.0 or earlier"
    Version 0.4.0 renames two identifiers that n8n stores in workflow JSON, before the node is verified for n8n Cloud and the names are fixed for good:

    - The chat memory sub-node's type is now `redisAgentChatMemory` (was `redisAgentMemoryChatMemory`). A workflow saved with an earlier version shows that node as unknown; delete it, add **Redis Agent Chat Memory** again and set its parameters.
    - The **User ID** parameter of **Redis Agent Chat Memory** and of **Session → Add Event** is stored as `ownerId` (was `actorId`), the key every other operation already uses. A saved value under the old key is ignored, so open those nodes and set **User ID** again.

    The display names, the credential and the stored data are unchanged.

## Create the credential

Both nodes use one credential, **Redis Agent Memory API**, with three fields:

| Field | Where to find it |
|---|---|
| **Server URL** | `AI Services / Iris / Agent Memory` page, **Configuration** tab, **General Settings**. Enter the host only (`https://…`), without a path: the nodes add `/iris/data/v1/agent-memory` themselves. |
| **Store ID** | Same page and tab. |
| **API Key** | `AI Services / Iris / Agent Memory` page, **API Keys** tab. |

The credential test calls the store's health endpoint, so a wrong URL, store or key fails at save time rather than at the first chat.

!!! note "Summary views and extraction"
    Long-term memory extraction and summary views are features of the store. Extraction is on by default on hosted stores; summary views must be enabled on the store before the **Summary View** resource and the chat memory's **Summary View ID** option work.

Next: the [Quick Start](quick-start.md).
