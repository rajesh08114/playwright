import { TestDataFixture } from "./contracts.js";

export interface TestDataProvider {
  setup(signal?: AbortSignal): Promise<TestDataFixture>;
  cleanup(fixture: TestDataFixture, signal?: AbortSignal): Promise<void>;
}

export class NoopTestDataProvider implements TestDataProvider {
  async setup(): Promise<TestDataFixture> { return { id: "noop", description: "No application data mutation", data: {}, cleanupRequired: false }; }
  async cleanup(): Promise<void> { return; }
}
