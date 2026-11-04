import type { IDisplayOptions, INodeProperties } from 'n8n-workflow';

/**
 * n8n's Simplify switch, with its standard name and text. On, the node
 * returns the record's main fields; off, the API's object as it came.
 */
export const simplifyField = (displayOptions: IDisplayOptions): INodeProperties => ({
	displayName: 'Simplify',
	name: 'simple',
	type: 'boolean',
	default: true,
	description: 'Whether to return a simplified version of the response instead of the raw data',
	displayOptions,
});

/**
 * A namespace chosen from the store's list, or given as an ID or expression.
 * The ID mode has no format check: the server's ID format may change.
 *
 * Only the top-level Namespace fields use it. The Namespace ID strings inside
 * Filters, Additional Fields and Options stay plain strings: a locator in a
 * collection crowds the panel.
 */
export const namespaceLocatorField = (
	description: string,
	displayOptions: IDisplayOptions,
): INodeProperties => ({
	displayName: 'Namespace',
	name: 'namespaceId',
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
				searchListMethod: 'searchNamespaces',
				searchable: true,
			},
		},
		{
			displayName: 'ID',
			name: 'id',
			type: 'string',
			placeholder: 'e.g. 0875d631ea6b4b8b94d8de9d5fd6747c',
		},
	],
});
