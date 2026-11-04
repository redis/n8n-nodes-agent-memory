import type { INodeProperties } from 'n8n-workflow';

const show = (operation: string[]) => ({
	show: { resource: ['namespace'], operation },
});

export const namespaceOperations: INodeProperties[] = [
	{
		displayName: 'Operation',
		name: 'operation',
		type: 'options',
		noDataExpression: true,
		displayOptions: {
			show: { resource: ['namespace'] },
		},
		options: [
			{
				name: 'Create',
				value: 'create',
				description: 'Create a namespace',
				action: 'Create a namespace',
			},
			{
				name: 'Delete',
				value: 'delete',
				description: 'Delete a namespace',
				action: 'Delete a namespace',
			},
			{
				name: 'Get',
				value: 'get',
				description: 'Get a namespace by ID',
				action: 'Get a namespace',
			},
			{
				name: 'Get Many',
				value: 'getAll',
				description: 'List namespaces',
				action: 'Get many namespaces',
			},
			{
				name: 'Update',
				value: 'update',
				description: 'Rename or archive a namespace',
				action: 'Update a namespace',
			},
		],
		default: 'get',
	},
];

export const namespaceFields: INodeProperties[] = [
	{
		displayName: 'Namespace ID',
		name: 'namespaceId',
		type: 'string',
		required: true,
		default: '',
		description: 'ID of the namespace',
		displayOptions: show(['get', 'update', 'delete']),
	},

	// ----- create -----
	{
		displayName: 'Name',
		name: 'name',
		type: 'string',
		required: true,
		default: '',
		description: 'Name of the namespace',
		placeholder: 'e.g. product-support',
		displayOptions: show(['create']),
	},
	{
		displayName: 'Scope',
		name: 'scope',
		type: 'options',
		options: [
			{ name: 'Personal', value: 'PERSONAL' },
			{ name: 'Shared', value: 'SHARED' },
		],
		default: 'SHARED',
		description:
			"Whether the namespace belongs to one user (set User ID below) or is shared. Ignored when Parent ID is set: a child inherits its parent's scope.",
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
				displayName: 'Parent ID',
				name: 'parentId',
				type: 'string',
				default: '',
				description:
					'ID of the parent namespace, to nest this one under it. The child takes the scope and user of its parent.',
			},
			{
				displayName: 'User ID',
				name: 'ownerId',
				type: 'string',
				default: '',
				description: 'User who owns the namespace, for personal namespaces',
			},
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
		},
		displayOptions: {
			show: { resource: ['namespace'], operation: ['getAll'], returnAll: [false] },
		},
	},

	// ----- update -----
	{
		displayName: 'Update Fields',
		name: 'updateFields',
		type: 'collection',
		placeholder: 'Add Field',
		default: {},
		displayOptions: show(['update']),
		options: [
			{
				displayName: 'Name',
				name: 'name',
				type: 'string',
				default: '',
				description: 'New name of the namespace',
			},
			{
				displayName: 'Archive',
				name: 'archive',
				type: 'boolean',
				default: false,
				description:
					'Whether to archive the namespace. The API cannot make an archived namespace active again.',
			},
		],
	},
];
