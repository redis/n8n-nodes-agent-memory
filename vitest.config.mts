import { defineConfig } from 'vitest/config';

export default defineConfig({
	// Hide Vite's sourcemap warnings for n8n-workflow, which ships maps without sources.
	logLevel: 'error',
	test: {
		// Coverage is collected only by `npm run test:coverage`. The unit tests
		// cover the shipped sources; the e2e tests run them inside Docker, where
		// nothing can be measured.
		coverage: {
			provider: 'v8',
			include: ['nodes/**/*.ts', 'credentials/**/*.ts'],
			reporter: ['text', 'lcovonly'],
			reportsDirectory: 'coverage',
		},
		projects: [
			{
				test: {
					name: 'unit',
					include: ['test/unit/**/*.test.ts'],
				},
			},
			{
				test: {
					name: 'contract',
					include: ['test/contract/**/*.test.ts'],
					// The opt-in tests wait for the server's background work on a
					// shared store; another file writing at the same time slows it.
					fileParallelism: false,
					testTimeout: 30_000,
					hookTimeout: 60_000,
				},
			},
			{
				test: {
					name: 'e2e',
					include: ['test/e2e/**/*.test.ts'],
					globalSetup: ['test/e2e/global-setup.ts'],
					fileParallelism: false,
					testTimeout: 120_000,
					hookTimeout: 300_000,
				},
			},
		],
	},
});
