## REMOVED Requirements

### Requirement: deploy_app tool
**Reason**: Deployment lifecycle moved to the new `app-registry` capability, which provides named apps, versioning, git integration, and rollback. The vibe-coder capability focuses exclusively on the dev experience (preview, console logs, backend preview).
**Migration**: Remove `deploy` from `vibeCoder()` options. Register `appRegistry()` as a separate capability with the sandbox provider and storage configuration previously passed to vibe-coder's deploy option.

### Requirement: deploy configuration option
**Reason**: The `deploy` field in `VibeCoderOptions` is no longer needed since deploy_app is owned by app-registry.
**Migration**: Replace `vibeCoder({ provider, deploy: { storage } })` with `vibeCoder({ provider })` plus `appRegistry({ provider, storage })` in the capabilities array.
