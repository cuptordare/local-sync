import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
	testDir: "test/e2e",
	fullyParallel: true,
	forbidOnly: !!process.env.CI,
	retries: process.env.CI ? 1 : 0,
	webServer: {
		command: "npx serve . -l 5050",
		url: "http://localhost:5050",
		reuseExistingServer: !process.env.CI,
	},
	use: {
		baseURL: "http://localhost:5050",
	},
	projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
