import type { INodeProperties } from 'n8n-workflow';
import { simplifyField } from './SharedFields';

const show = (operation: string[]) => ({
	show: { resource: ['session'], operation },
});

export const sessionOperations: INodeProperties[] = [
	{
		displayName: 'Operation',
		name: 'operation',
		type: 'options',
		noDataExpression: true,
		displayOptions: {
			show: { resource: ['session'] },
		},
		options: [
			{
				name: 'Add Event',
				value: 'addEvent',
				description: 'Append a message to a session',
				action: 'Add an event to a session',
			},
			{
				name: 'Delete',
				value: 'delete',
				description: 'Delete a session, with its events and summary',
				action: 'Delete a session',
			},
			{
				name: 'Delete Event',
				value: 'deleteEvent',
				description: 'Delete one event from a session, keeping the rest and the summary',
				action: 'Delete an event from a session',
			},
			{
				name: 'Get',
				value: 'get',
				description: 'Get the events and summary of a session',
				action: 'Get a session',
			},
			{
				name: 'Get Many',
				value: 'getAll',
				description: 'List session IDs',
				action: 'Get many sessions',
			},
		],
		default: 'get',
	},
];

export const sessionFields: INodeProperties[] = [
	{
		displayName: 'Session ID',
		name: 'sessionId',
		type: 'string',
		required: true,
		default: '',
		description: 'ID of the session',
		displayOptions: show(['get', 'delete', 'addEvent', 'deleteEvent']),
	},
	{
		displayName: 'Event ID',
		name: 'eventId',
		type: 'string',
		required: true,
		default: '',
		description: 'ID of the event to delete. Session → Get returns the IDs.',
		displayOptions: show(['deleteEvent']),
	},

	// ----- get -----
	simplifyField(show(['get'])),
	{
		displayName: 'Options',
		name: 'options',
		type: 'collection',
		placeholder: 'Add Option',
		default: {},
		displayOptions: show(['get']),
		options: [
			{
				displayName: 'Include Summarized Events',
				name: 'includeSummarisedEvents',
				type: 'boolean',
				default: false,
				description: 'Whether to also return the older events that the summary already covers',
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
			show: { resource: ['session'], operation: ['getAll'], returnAll: [false] },
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
				displayName: 'User ID',
				name: 'ownerId',
				type: 'string',
				default: '',
				description: 'Only sessions owned by this user',
			},
		],
	},

	// ----- addEvent -----
	{
		displayName: 'User ID',
		name: 'ownerId',
		type: 'string',
		required: true,
		default: '',
		description:
			'User the message belongs to. Long-term memories extracted from it are owned by this user.',
		placeholder: 'e.g. user-42',
		displayOptions: show(['addEvent']),
	},
	{
		displayName: 'Role',
		name: 'role',
		type: 'options',
		options: [
			{ name: 'Assistant', value: 'ASSISTANT' },
			{ name: 'System', value: 'SYSTEM' },
			{ name: 'User', value: 'USER' },
		],
		default: 'USER',
		description: 'Who said it',
		displayOptions: show(['addEvent']),
	},
	{
		displayName: 'Text',
		name: 'text',
		type: 'string',
		required: true,
		default: '',
		description: 'Content of the message',
		typeOptions: {
			rows: 3,
		},
		displayOptions: show(['addEvent']),
	},
	{
		displayName: 'Additional Fields',
		name: 'additionalFields',
		type: 'collection',
		placeholder: 'Add Field',
		default: {},
		displayOptions: show(['addEvent']),
		options: [
			{
				displayName: 'Created At',
				name: 'createdAt',
				type: 'dateTime',
				default: '',
				description: 'When the message was said. Defaults to now.',
			},
			{
				displayName: 'Namespace ID',
				name: 'namespaceId',
				type: 'string',
				default: '',
				description:
					'Namespace to bind the session to. Long-term memories extracted from it are placed there.',
			},
		],
	},
];
