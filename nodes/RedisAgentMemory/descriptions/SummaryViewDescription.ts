import type { IDisplayOptions, INodeProperties } from 'n8n-workflow';
import { simplifyField } from './SharedFields';

const show = (operation: string[]) => ({
	show: { resource: ['summaryView'], operation },
});

export const summaryViewOperations: INodeProperties[] = [
	{
		displayName: 'Operation',
		name: 'operation',
		type: 'options',
		noDataExpression: true,
		displayOptions: {
			show: { resource: ['summaryView'] },
		},
		options: [
			{
				name: 'Create',
				value: 'create',
				description: 'Define a summary view over long-term memories',
				action: 'Create a summary view',
			},
			{
				name: 'Delete',
				value: 'delete',
				description: 'Delete a summary view and its results',
				action: 'Delete a summary view',
			},
			{
				name: 'Get',
				value: 'get',
				description: 'Get the definition of a summary view',
				action: 'Get a summary view',
			},
			{
				name: 'Get Many',
				value: 'getAll',
				description: 'List summary views',
				action: 'Get many summary views',
			},
			{
				name: 'Get Result',
				value: 'getResult',
				description: 'Read the summary of one group, for example one user',
				action: 'Get a summary view result',
			},
			{
				name: 'Refresh',
				value: 'refresh',
				description: 'Ask the server to compute a summary again',
				action: 'Refresh a summary view',
			},
			{
				name: 'Update',
				value: 'update',
				description: 'Change the definition or state of a summary view',
				action: 'Update a summary view',
			},
		],
		default: 'getResult',
	},
];

/** A view chosen from the store's list, or given as an ID or expression. */
const viewLocatorField = (
	description: string,
	displayOptions: IDisplayOptions,
): INodeProperties => ({
	displayName: 'View',
	name: 'viewId',
	type: 'resourceLocator',
	default: { mode: 'list', value: '' },
	required: true,
	description,
	displayOptions,
	modes: [
		{
			displayName: 'From List',
			name: 'list',
			type: 'list',
			typeOptions: {
				searchListMethod: 'searchSummaryViews',
				searchable: true,
			},
		},
		{
			displayName: 'ID',
			name: 'id',
			type: 'string',
			placeholder: 'e.g. sv_ea8eaecb72b34b91befce96a9014afb6',
		},
	],
});

/** The keys that select one group; which ones apply depends on the view's Group By. */
const groupField = (description: string, displayOptions: IDisplayOptions): INodeProperties => ({
	displayName: 'Group',
	name: 'group',
	type: 'collection',
	placeholder: 'Add Group Key',
	default: {},
	description,
	displayOptions,
	options: [
		{
			displayName: 'Memory Type',
			name: 'memoryType',
			type: 'string',
			default: '',
			description: 'The memory type, for a view grouped by memory type',
		},
		{
			displayName: 'Namespace ID',
			name: 'namespaceId',
			type: 'string',
			default: '',
			description: 'The namespace, for a view grouped by namespace',
		},
		{
			displayName: 'Session ID',
			name: 'sessionId',
			type: 'string',
			default: '',
			description: 'The session, for a view grouped by session',
		},
		{
			displayName: 'User ID',
			name: 'ownerId',
			type: 'string',
			default: '',
			description: 'The user, for a view grouped by user',
		},
	],
});

/** The Wait For Result switch and its Max Wait, shown under `displayOptions`. */
const waitFields = (displayOptions: IDisplayOptions): INodeProperties[] => [
	{
		displayName: 'Wait For Result',
		name: 'waitForResult',
		type: 'boolean',
		default: false,
		description:
			'Whether to poll every 2 seconds until the summary is ready, empty or failed, and fail after Max Wait. Off, the node returns the current state, which may still be cold or pending.',
		displayOptions,
	},
	{
		displayName: 'Max Wait (Seconds)',
		name: 'maxWaitSeconds',
		type: 'number',
		default: 60,
		description: 'How long to wait for the result before the node fails',
		typeOptions: { minValue: 1 },
		displayOptions: {
			show: { ...displayOptions.show, waitForResult: [true] },
		},
	},
];

const groupByOptions = [
	{ name: 'Memory Type', value: 'memoryType' },
	{ name: 'Namespace', value: 'namespaceId' },
	{ name: 'Session', value: 'sessionId' },
	{ name: 'User', value: 'ownerId' },
];

const outputFormatOptions = [
	{ name: 'Structured', value: 'STRUCTURED' },
	{ name: 'Text', value: 'TEXT' },
];

const refreshModeOptions = [
	{ name: 'Continuous', value: 'CONTINUOUS' },
	{ name: 'Manual', value: 'MANUAL' },
];

const visibilityOptions = [
	{ name: 'Private', value: 'PRIVATE' },
	{ name: 'Shared', value: 'SHARED' },
];

/**
 * The definition fields that Create keeps under Additional Fields and Update
 * offers as Update Fields. Sorted by display name, as n8n's lint requires.
 */
const definitionFields: INodeProperties[] = [
	{
		displayName: 'Debounce (Seconds)',
		name: 'debounceSeconds',
		type: 'number',
		default: 0,
		description:
			'For continuous refresh: how long the server waits after a change before it recomputes',
		typeOptions: { minValue: 0 },
	},
	{
		displayName: 'Description',
		name: 'description',
		type: 'string',
		default: '',
		description: 'What the view is for',
	},
	{
		displayName: 'Max Partitions',
		name: 'maxPartitions',
		type: 'number',
		default: 0,
		description:
			'How many groups the server keeps a summary for; older ones are evicted. Leave at 0 for the server default.',
		typeOptions: { minValue: 0 },
	},
	{
		displayName: 'Memory Type Filter',
		name: 'memoryType',
		type: 'string',
		default: '',
		description: 'Only summarize memories of this type',
	},
	{
		displayName: 'Namespace ID Filter',
		name: 'namespaceId',
		type: 'string',
		default: '',
		description: 'Only summarize memories in this namespace',
	},
	{
		displayName: 'Reconcile Interval (Seconds)',
		name: 'reconcileIntervalSeconds',
		type: 'number',
		default: 0,
		description:
			'For continuous refresh: how often the server checks for changes it missed. Leave at 0 for the server default.',
		typeOptions: { minValue: 0 },
	},
	{
		displayName: 'Schema (JSON)',
		name: 'schema',
		type: 'json',
		default: '',
		description:
			'For structured output: the fields the summary must have, as the API\'s <code>{ "fields": [...] }</code> object. Checked only as JSON.',
	},
	{
		displayName: 'Session ID Filter',
		name: 'sessionId',
		type: 'string',
		default: '',
		description: 'Only summarize memories extracted from this session',
	},
	{
		displayName: 'Time Window (Seconds)',
		name: 'timeWindowSeconds',
		type: 'number',
		default: 0,
		description: 'Only summarize memories created in the last so many seconds. Leave at 0 for all.',
		typeOptions: { minValue: 0 },
	},
	{
		displayName: 'Topics Filter',
		name: 'topics',
		type: 'string',
		default: '',
		description: 'Only summarize memories tagged with any of these topics, comma-separated',
		placeholder: 'e.g. food, travel',
	},
	{
		displayName: 'User ID Filter',
		name: 'ownerId',
		type: 'string',
		default: '',
		description: 'Only summarize memories owned by this user',
	},
	{
		displayName: 'Visibility',
		name: 'visibility',
		type: 'options',
		options: visibilityOptions,
		default: 'PRIVATE',
		description: 'Whether other API keys of the store can read the view',
	},
];

/** The fields Create has at the top level, as Update offers them. */
const updateOnlyFields: INodeProperties[] = [
	{
		displayName: 'Clear Filter',
		name: 'clearFilter',
		type: 'boolean',
		default: false,
		description: 'Whether to remove the filter, so the view summarizes every memory',
	},
	{
		displayName: 'Clear Time Window',
		name: 'clearTimeWindow',
		type: 'boolean',
		default: false,
		description: 'Whether to remove the time window',
	},
	{
		displayName: 'Group By',
		name: 'groupBy',
		type: 'multiOptions',
		options: groupByOptions,
		default: [],
		description: 'One summary per distinct value of these keys',
	},
	{
		displayName: 'Instructions',
		name: 'instructions',
		type: 'string',
		default: '',
		description: 'What the summary should focus on, in plain language',
		typeOptions: { rows: 3 },
	},
	{
		displayName: 'Name',
		name: 'name',
		type: 'string',
		default: '',
		description: 'New name of the view',
	},
	{
		displayName: 'Output Format',
		name: 'outputFormat',
		type: 'options',
		options: outputFormatOptions,
		default: 'TEXT',
		description: 'Whether the summary is prose or an object that follows the Schema',
	},
	{
		displayName: 'Refresh Mode',
		name: 'refreshMode',
		type: 'options',
		options: refreshModeOptions,
		default: 'MANUAL',
		description: 'Whether summaries are computed only on Refresh, or whenever the memories change',
	},
	{
		displayName: 'State',
		name: 'state',
		type: 'options',
		options: [
			{ name: 'Active', value: 'ACTIVE' },
			{ name: 'Disabled', value: 'DISABLED' },
		],
		default: 'ACTIVE',
		description: 'Whether the view computes summaries. A disabled view keeps its results.',
	},
];

/** Everything Update may change, sorted by display name as n8n's lint requires. */
const updateFields: INodeProperties[] = [...definitionFields, ...updateOnlyFields].sort((a, b) =>
	a.displayName.localeCompare(b.displayName),
);

export const summaryViewFields: INodeProperties[] = [
	viewLocatorField(
		'Summary view to read, refresh, update or delete',
		show(['get', 'getResult', 'refresh', 'update', 'delete']),
	),

	// ----- getResult / refresh -----
	{
		displayName: 'Target',
		name: 'target',
		type: 'options',
		options: [
			{ name: 'Full', value: 'FULL' },
			{ name: 'Partition', value: 'PARTITION' },
		],
		default: 'PARTITION',
		description:
			'Whether to recompute one group, selected by the Group keys, or every group. Only a Partition refresh can wait for its result.',
		displayOptions: show(['refresh']),
	},
	groupField(
		'The group to read: set the keys the view groups by, for example the User ID of a view grouped by user',
		show(['getResult']),
	),
	groupField('The group to recompute, for a Partition refresh: set the keys the view groups by', {
		show: { resource: ['summaryView'], operation: ['refresh'], target: ['PARTITION'] },
	}),
	// A result is one group's summary, so only Get Result and a Partition
	// refresh can wait for one; a Full refresh has no single result.
	...waitFields(show(['getResult'])),
	...waitFields({
		show: { resource: ['summaryView'], operation: ['refresh'], target: ['PARTITION'] },
	}),
	{
		displayName: 'Options',
		name: 'options',
		type: 'collection',
		placeholder: 'Add Option',
		default: {},
		displayOptions: show(['getResult']),
		options: [
			{
				displayName: 'Include Source Memory IDs',
				name: 'includeSourceMemoryIds',
				type: 'boolean',
				default: false,
				description: 'Whether to return the IDs of the memories the summary was computed from',
			},
		],
	},
	simplifyField(show(['getResult', 'refresh', 'get', 'getAll', 'create', 'update'])),

	// ----- getAll -----
	{
		displayName: 'Return All',
		name: 'returnAll',
		type: 'boolean',
		default: false,
		description: 'Whether to return all results or only up to a given limit',
		displayOptions: show(['getAll']),
	},
	{
		displayName: 'Limit',
		name: 'limit',
		type: 'number',
		default: 50,
		description: 'Max number of results to return',
		typeOptions: {
			minValue: 1,
		},
		displayOptions: {
			show: { resource: ['summaryView'], operation: ['getAll'], returnAll: [false] },
		},
	},

	// ----- create -----
	{
		displayName: 'Name',
		name: 'name',
		type: 'string',
		required: true,
		default: '',
		description: 'Name of the view',
		placeholder: 'e.g. customer-briefing',
		displayOptions: show(['create']),
	},
	{
		displayName: 'Group By',
		name: 'groupBy',
		type: 'multiOptions',
		required: true,
		options: groupByOptions,
		default: ['ownerId'],
		description:
			'One summary per distinct value of these keys. Get Result then selects a summary with the same keys.',
		displayOptions: show(['create']),
	},
	{
		displayName: 'Output Format',
		name: 'outputFormat',
		type: 'options',
		options: outputFormatOptions,
		default: 'TEXT',
		description:
			'Whether the summary is prose or an object that follows the Schema under Additional Fields',
		displayOptions: show(['create']),
	},
	{
		displayName: 'Instructions',
		name: 'instructions',
		type: 'string',
		default: '',
		description: 'What the summary should focus on, in plain language',
		placeholder: "e.g. Summarize the customer's preferences and open issues",
		typeOptions: { rows: 3 },
		displayOptions: show(['create']),
	},
	{
		displayName: 'Refresh Mode',
		name: 'refreshMode',
		type: 'options',
		options: refreshModeOptions,
		default: 'MANUAL',
		description:
			'Whether summaries are computed only on Refresh, or whenever the memories change. Continuous costs a model call per change.',
		displayOptions: show(['create']),
	},
	{
		displayName: 'Additional Fields',
		name: 'additionalFields',
		type: 'collection',
		placeholder: 'Add Field',
		default: {},
		displayOptions: show(['create']),
		options: definitionFields,
	},

	// ----- update -----
	{
		displayName: 'Update Fields',
		name: 'updateFields',
		type: 'collection',
		placeholder: 'Add Field',
		default: {},
		displayOptions: show(['update']),
		options: updateFields,
	},
];
