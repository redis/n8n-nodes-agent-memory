// A stand-in for the OpenAI Chat Completions API, so end-to-end tests need no
// model provider. Replies are deterministic, and every request is recorded so
// tests can check what the AI Agent sent, including the history from memory.
//
//   POST   /v1/chat/completions  answer a chat completion (JSON or streamed)
//   GET    /_requests            the recorded request bodies, oldest first
//   DELETE /_requests            forget the recorded requests
//
// Replies, decided by the last user message unless a tool just answered:
//   - after a tool result:                   "The answer is <result>." where
//                                            <result> is what the tool returned
//   - "use tool <name> with <json-object>":  a call to the tool named <name>,
//                                            with exactly that JSON as arguments;
//                                            when no such tool was offered, a
//                                            text reply listing the tools
//   - "calculate <expression>":              a call to the Calculator tool, or
//                                            to the first tool, with the expression
//   - anything else:                         "Echo: <last user message>"
//
// Tool names arrive in body.tools[].function.name. n8n builds them from the
// node name, with every character outside [A-Za-z0-9_-] replaced by "_":
// a node called "Search memories" is the tool "Search_memories".
import { createServer } from 'node:http';

const requests = [];
let sequence = 0;

function text(content) {
	if (typeof content === 'string') return content;
	if (Array.isArray(content)) return content.map((part) => part.text ?? '').join('');
	return '';
}

// n8n tools return JSON such as [{"response":"4"}]; use the plain value when there is one.
function toolResult(content) {
	try {
		const parsed = JSON.parse(content);
		const first = Array.isArray(parsed) ? parsed[0] : parsed;
		if (first && typeof first === 'object' && 'response' in first) return String(first.response);
	} catch {
		// Not JSON: use the content as it is.
	}
	return content;
}

function toolCall(name, args) {
	sequence += 1;
	return {
		id: `call_${sequence}`,
		type: 'function',
		function: { name, arguments: JSON.stringify(args) },
	};
}

function reply(body) {
	const messages = body.messages ?? [];
	const last = messages[messages.length - 1] ?? {};

	if (last.role === 'tool') {
		return { content: `The answer is ${toolResult(text(last.content))}.` };
	}

	const userText = text([...messages].reverse().find((m) => m.role === 'user')?.content);
	const tools = (body.tools ?? []).map((t) => t.function).filter(Boolean);

	const named = /use tool\s+(\S+)\s+with\s+(\{[\s\S]*\})/i.exec(userText);
	if (named) {
		const [, name, argumentsJson] = named;
		if (!tools.some((t) => t.name === name)) {
			const offered = tools.map((t) => t.name).join(', ') || 'none';
			return { content: `No tool named ${name}. Tools offered: ${offered}.` };
		}
		let args;
		try {
			args = JSON.parse(argumentsJson);
		} catch {
			return { content: `The arguments for ${name} are not a JSON object: ${argumentsJson}` };
		}
		return { content: `Calling ${name}.`, toolCalls: [toolCall(name, args)] };
	}

	const match = /calculate\s+(.+)/i.exec(userText);
	const tool = tools.find((t) => /calculator/i.test(t.name)) ?? tools[0];
	if (match && tool) {
		const argument = Object.keys(tool.parameters?.properties ?? { input: {} })[0] ?? 'input';
		return {
			content: 'Let me calculate that.',
			toolCalls: [toolCall(tool.name, { [argument]: match[1].trim() })],
		};
	}

	return { content: `Echo: ${userText}` };
}

function completion(body, { content, toolCalls }) {
	return {
		id: `chatcmpl-stub-${Date.now()}`,
		object: 'chat.completion',
		created: Math.floor(Date.now() / 1000),
		model: body.model ?? 'stub',
		choices: [
			{
				index: 0,
				message: { role: 'assistant', content, ...(toolCalls ? { tool_calls: toolCalls } : {}) },
				finish_reason: toolCalls ? 'tool_calls' : 'stop',
			},
		],
		usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
	};
}

function stream(res, body, { content, toolCalls }) {
	res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
	const base = {
		id: `chatcmpl-stub-${Date.now()}`,
		object: 'chat.completion.chunk',
		created: Math.floor(Date.now() / 1000),
		model: body.model ?? 'stub',
	};
	const send = (delta, finishReason = null) =>
		res.write(
			`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta, finish_reason: finishReason }] })}\n\n`,
		);

	send({ role: 'assistant', content });
	if (toolCalls) {
		send({ tool_calls: toolCalls.map((call, index) => ({ index, ...call })) });
	}
	send({}, toolCalls ? 'tool_calls' : 'stop');
	if (body.stream_options?.include_usage) {
		res.write(
			`data: ${JSON.stringify({ ...base, choices: [], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })}\n\n`,
		);
	}
	res.end('data: [DONE]\n\n');
}

function json(res, status, value) {
	res.writeHead(status, { 'Content-Type': 'application/json' });
	res.end(JSON.stringify(value));
}

const server = createServer((req, res) => {
	const chunks = [];
	req.on('data', (chunk) => chunks.push(chunk));
	req.on('end', () => {
		const path = new URL(req.url ?? '/', 'http://stub').pathname;

		if (path === '/_requests' && req.method === 'GET') return json(res, 200, requests);
		if (path === '/_requests' && req.method === 'DELETE') {
			requests.length = 0;
			return json(res, 200, { deleted: true });
		}
		if (path.endsWith('/chat/completions') && req.method === 'POST') {
			let body;
			try {
				body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
			} catch {
				return json(res, 400, { error: { message: 'Request body is not JSON' } });
			}
			requests.push(body);
			const answer = reply(body);
			return body.stream ? stream(res, body, answer) : json(res, 200, completion(body, answer));
		}
		if (path.endsWith('/models')) {
			return json(res, 200, { object: 'list', data: [{ id: 'gpt-4o-mini', object: 'model' }] });
		}

		json(res, 404, { error: { message: `No stub for ${req.method} ${path}` } });
	});
});

server.listen(8080, () => console.log('LLM stub listening on :8080'));
