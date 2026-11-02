import type {
	IAuthenticateGeneric,
	ICredentialTestRequest,
	ICredentialType,
	INodeProperties,
} from 'n8n-workflow';

export class RedisAgentMemoryApi implements ICredentialType {
	name = 'redisAgentMemoryApi';

	displayName = 'Redis Agent Memory API';

	icon = {
		light: 'file:../nodes/RedisAgentMemoryChatMemory/memory.svg',
		dark: 'file:../nodes/RedisAgentMemoryChatMemory/memory.dark.svg',
	} as const;

	documentationUrl = 'https://redis.io/docs/latest/develop/ai/context-engine/agent-memory/';

	properties: INodeProperties[] = [
		{
			displayName: 'Server URL',
			name: 'serverUrl',
			type: 'string',
			default: '',
			required: true,
			placeholder: 'e.g. https://agent-memory.example.com',
			description: 'Base URL of your Agent Memory service, without a trailing slash',
		},
		{
			displayName: 'Store ID',
			name: 'storeId',
			type: 'string',
			default: '',
			required: true,
			description: 'ID of the Agent Memory store to read from and write to',
		},
		{
			displayName: 'API Key',
			name: 'apiKey',
			type: 'string',
			typeOptions: { password: true },
			default: '',
			required: true,
			description: 'Credential issued for your Agent Memory service or store',
		},
	];

	authenticate: IAuthenticateGeneric = {
		type: 'generic',
		properties: {
			headers: {
				Authorization: '=Bearer {{$credentials.apiKey}}',
			},
		},
	};

	test: ICredentialTestRequest = {
		request: {
			baseURL: '={{$credentials.serverUrl.replace(/\\/+$/, "")}}',
			// Same encoding as the nodes' request adapter, so the test hits the URL
			// the nodes will use.
			url: '=/v1/stores/{{encodeURIComponent($credentials.storeId)}}/health',
			method: 'GET',
		},
	};
}
