import type { IDataObject } from 'n8n-workflow';

/**
 * The result statuses that end a wait. The server leaves them as they are
 * until the next refresh; the others (COLD, PENDING, REFRESHING) will change.
 */
export const SETTLED_RESULT_STATUSES: ReadonlySet<string> = new Set(['READY', 'EMPTY', 'FAILED']);

/**
 * One group's result from `GET /summary-views/{viewId}/result`, as far as the
 * nodes read it. `scope` echoes the keys the view groups by.
 */
export interface AgentMemorySummaryViewResult extends IDataObject {
	viewId?: string;
	status?: string;
	scope?: { ownerId?: string; sessionId?: string; namespaceId?: string; memoryType?: string };
	stale?: boolean;
	value?: { text?: string; data?: IDataObject };
	computedAt?: string;
}
