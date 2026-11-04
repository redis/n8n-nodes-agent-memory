import type { INodeProperties } from 'n8n-workflow';

const show = (operation: string[]) => ({
	show: { resource: ['longTermMemory'], operation },
});

export const longTermMemoryOperations: INodeProperties[] = [
	{
		displayName: 'Operation',
		name: 'operation',
		type: 'options',
		noDataExpression: true,
		displayOptions: {
			show: { resource: ['longTermMemory'] },
		},
		options: [
			{
				name: 'Create',
				value: 'create',
				description: 'Store a fact as a long-term memory of a user',
				action: 'Create a memory',
			},
			{
				name: 'Delete',
				value: 'delete',
				description: 'Delete a long-term memory',
				action: 'Delete a memory',
			},
			{
				name: 'Get',
				value: 'get',
				description: 'Get a long-term memory by ID',
				action: 'Get a memory',
			},
			{
				name: 'Get Many',
				value: 'getAll',
				description: 'List long-term memories that match the filters',
				action: 'Get many memories',
			},
			{
				name: 'Move',
				value: 'move',
				description: 'Move a long-term memory to another namespace',
				action: 'Move a memory',
			},
			{
				name: 'Search',
				value: 'search',
				description: "Search a user's long-term memories by meaning",
				action: 'Search memories',
			},
			{
				name: 'Update',
				value: 'update',
				description: 'Update a long-term memory',
				action: 'Update a memory',
			},
		],
		default: 'search',
	},
];

const memoryIdField: INodeProperties = {
	displayName: 'Memory ID',
	name: 'memoryId',
	type: 'string',
	required: true,
	default: '',
	description: 'ID of the long-term memory',
	displayOptions: show(['get', 'update', 'delete', 'move']),
};

const topicsField = (description: string): INodeProperties => ({
	displayName: 'Topics',
	name: 'topics',
	type: 'string',
	default: '',
	description,
	placeholder: 'e.g. food, travel',
});

export const longTermMemoryFields: INodeProperties[] = [
	// ----- search -----
	{
		displayName: 'Query',
		name: 'query',
		type: 'string',
		required: true,
		default: '',
		description: 'Text to search for. Memories are ranked by meaning, not by keyword.',
		placeholder: 'e.g. What food does the user like?',
		displayOptions: show(['search']),
	},
	{
		displayName: 'User ID',
		name: 'ownerId',
		type: 'string',
		required: true,
		default: '',
		description:
			'Only memories owned by this user are searched. Set it from the workflow, not from the model, so one user cannot read the memories of another.',
		placeholder: 'e.g. user-42',
		displayOptions: show(['search', 'create']),
	},
	{
		displayName: 'Max Results',
		name: 'maxResults',
		type: 'number',
		default: 10,
		description: 'Max number of memories to return, best matches first',
		typeOptions: {
			minValue: 1,
			maxValue: 100,
		},
		displayOptions: show(['search']),
	},
	{
		displayName: 'Options',
		name: 'options',
		type: 'collection',
		placeholder: 'Add Option',
		default: {},
		displayOptions: show(['search']),
		options: [
			{
				displayName: 'Memory Type',
				name: 'memoryType',
				type: 'string',
				default: '',
				description: 'Only memories of this type, built-in or custom',
			},
			{
				displayName: 'Namespace ID',
				name: 'namespaceId',
				type: 'string',
				default: '',
				description: 'Only memories in this namespace',
			},
			{
				displayName: 'Session ID',
				name: 'sessionId',
				type: 'string',
				default: '',
				description: 'Only memories extracted from this session',
			},
			{
				displayName: 'Similarity Threshold',
				name: 'similarityThreshold',
				type: 'number',
				default: 0,
				description:
					'Minimum similarity between 0 and 1. Leave at 0 to return the closest matches regardless of score.',
				typeOptions: {
					minValue: 0,
					maxValue: 1,
					numberPrecision: 2,
				},
			},
			topicsField('Only memories tagged with any of these topics, comma-separated'),
		],
	},

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
			maxValue: 100,
		},
		displayOptions: {
			show: { resource: ['longTermMemory'], operation: ['getAll'], returnAll: [false] },
		},
	},
	{
		displayName: 'Filters',
		name: 'filters',
		type: 'collection',
		placeholder: 'Add Filter',
		default: {},
		displayOptions: show(['getAll']),
		options: [
			{
				displayName: 'Memory Type',
				name: 'memoryType',
				type: 'string',
				default: '',
				description: 'Only memories of this type, built-in or custom',
			},
			{
				displayName: 'Namespace ID',
				name: 'namespaceId',
				type: 'string',
				default: '',
				description: 'Only memories in this namespace',
			},
			{
				displayName: 'Session ID',
				name: 'sessionId',
				type: 'string',
				default: '',
				description: 'Only memories extracted from this session',
			},
			topicsField('Only memories tagged with any of these topics, comma-separated'),
			{
				displayName: 'User ID',
				name: 'ownerId',
				type: 'string',
				default: '',
				description: 'Only memories owned by this user',
			},
		],
	},

	// ----- create -----
	{
		displayName: 'Text',
		name: 'text',
		type: 'string',
		required: true,
		default: '',
		description: 'The fact to remember, in plain language',
		placeholder: 'e.g. The user is vegetarian and prefers spicy food',
		typeOptions: {
			rows: 3,
		},
		displayOptions: show(['create']),
	},
	{
		displayName: 'Additional Fields',
		name: 'additionalFields',
		type: 'collection',
		placeholder: 'Add Field',
		default: {},
		displayOptions: show(['create']),
		options: [
			{
				displayName: 'Memory ID',
				name: 'id',
				type: 'string',
				default: '',
				description:
					"ID for the new memory: letters, digits and dashes. Creating the same ID again replaces the memory's text, type and topics. Generated when empty.",
			},
			{
				displayName: 'Memory Type',
				name: 'memoryType',
				type: 'string',
				default: '',
				description: 'Type of the memory, built-in or a custom type registered on the store',
			},
			{
				displayName: 'Namespace ID',
				name: 'namespaceId',
				type: 'string',
				default: '',
				description: 'Namespace to place the memory in',
			},
			{
				displayName: 'Session ID',
				name: 'sessionId',
				type: 'string',
				default: '',
				description: 'Session the memory came from',
			},
			topicsField('Topic tags, comma-separated'),
		],
	},

	// ----- get / update / delete / move -----
	memoryIdField,
	{
		displayName: 'Namespace ID',
		name: 'namespaceId',
		type: 'string',
		required: true,
		default: '',
		description: 'ID of the namespace to move the memory to',
		displayOptions: show(['move']),
	},
	{
		displayName: 'Update Fields',
		name: 'updateFields',
		type: 'collection',
		placeholder: 'Add Field',
		default: {},
		displayOptions: show(['update']),
		options: [
			{
				displayName: 'Memory Type',
				name: 'memoryType',
				type: 'string',
				default: '',
				description: 'Type of the memory, built-in or a custom type registered on the store',
			},
			{
				displayName: 'Namespace ID',
				name: 'namespaceId',
				type: 'string',
				default: '',
				description: 'Namespace to place the memory in',
			},
			{
				displayName: 'Session ID',
				name: 'sessionId',
				type: 'string',
				default: '',
				description: 'Session the memory came from',
			},
			{
				displayName: 'Text',
				name: 'text',
				type: 'string',
				default: '',
				description: 'New content of the memory',
				typeOptions: {
					rows: 3,
				},
			},
			topicsField('Topic tags, comma-separated. Replaces the existing topics.'),
			{
				displayName: 'User ID',
				name: 'ownerId',
				type: 'string',
				default: '',
				description: 'User who owns the memory',
			},
		],
	},
];
