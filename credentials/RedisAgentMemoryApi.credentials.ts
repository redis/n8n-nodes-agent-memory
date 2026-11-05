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
		light: 'file:../icons/memory.svg',
		dark: 'file:../icons/memory.dark.svg',
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
			description:
				'Base URL of your Agent Memory service: the host only, without a path or a trailing slash. The nodes add /iris/data/v1/agent-memory themselves.',
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
			url: '=/iris/data/v1/agent-memory/stores/{{encodeURIComponent($credentials.storeId)}}/health',
			method: 'GET',
		},
		rules: [
			{
				// The gateway refuses a wrong key, a wrong store and an extra path
				// segment in the URL alike; n8n's default for a 403 is the bare
				// word "Forbidden".
				type: 'responseCode',
				properties: {
					value: 403,
					message: 'Forbidden: check the API Key, Server URL and Store ID',
				},
			},
			{
				// A Server URL that already carries a path, or a server on an older
				// API, answers with an empty 404.
				type: 'responseCode',
				properties: {
					value: 404,
					message:
						'Not found: check the Server URL. It must be the host only; the nodes add the API path themselves.',
				},
			},
		],
	};
}
