import { defineConfig, devices } from "@playwright/test";
import path from "node:path";

const repositoryRoot = path.resolve(import.meta.dirname, "../..");
const externalBaseUrl = process.env.E2E_BASE_URL?.replace(/\/$/, "");

if (externalBaseUrl) {
  const target = new URL(externalBaseUrl);
  if (!new Set(["http:", "https:"]).has(target.protocol))
    throw new Error("E2E_BASE_URL must use HTTP or HTTPS");
  if (process.env.E2E_ALLOW_REMOTE_WRITE !== "1")
    throw new Error(
      "Remote E2E creates test organizations. Set E2E_ALLOW_REMOTE_WRITE=1 explicitly.",
    );
}

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? "github" : "list",
  use: {
    baseURL: externalBaseUrl ?? "http://127.0.0.1:3101",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
  webServer: externalBaseUrl
    ? undefined
    : [
        ...(process.env.E2E_MAILBOX_URL ? [{
          command: "node scripts/acceptance-smtp.mjs",
          cwd: repositoryRoot,
          url: process.env.E2E_MAILBOX_URL,
          reuseExistingServer: !process.env.CI,
          timeout: 30_000,
        }] : []),
        {
          command: "npm run start:e2e --workspace=@pastagansa/api",
          cwd: repositoryRoot,
          url: "http://127.0.0.1:3100/v1/health",
          reuseExistingServer: !process.env.CI,
          timeout: 30_000,
        },
        {
          command: "npm run start:e2e --workspace=@pastagansa/web",
          cwd: repositoryRoot,
          url: "http://127.0.0.1:3101/acceso",
          reuseExistingServer: !process.env.CI,
          timeout: 30_000,
        },
      ],
});
