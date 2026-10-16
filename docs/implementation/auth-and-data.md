# Authentication and test data

The browser runtime supports a Playwright `storageState` JSON file through `target.storageStatePath`. This keeps credentials out of source and avoids exposing arbitrary login automation to an agent. The path must be explicitly configured by the project owner.

Test data is represented by the validated `TestDataFixture` contract. The current engine does not execute arbitrary setup or cleanup scripts; integrations must provide explicit, reviewed setup/cleanup services before destructive workflows are enabled.

For concrete integrations, `HttpTestDataProvider` supports an explicitly configured setup endpoint, optional cleanup endpoint, fixture JSON, origin-controlled deployment, and bounded request timeouts. Shell commands are intentionally unsupported.
