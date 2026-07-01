# Custom channels

Use for local/prototype channel integrations and arbitrary remote-service account config.

## Source files

- Plugin/setup/scaffolding: `src/channels/custom/plugin.ts`, `scaffolding.ts`.
- Account/config/inbound-outbound: `account-config.ts`, `adapter.ts`.
- High-signal tests: `src/channels/custom-account-config.test.ts`, `custom-adapter.test.ts`, plus generic channel registry/routing/message-channel tests when custom behavior touches shared infrastructure.

## Existing custom adapter

The generic custom channel accepts user-supplied account/config JSON and a token shape rather than a first-party setup wizard.

Source of truth:

- `src/channels/custom/plugin.ts`
- `src/channels/custom/account-config.ts`
- `src/channels/custom/scaffolding.ts`

Important config inputs:

- `accounts_json`: JSON array describing remote accounts.
- `configs_json`: JSON object/array for service-level config.
- `agent_id`: default routing target where supported.
- Any other values must be validated by the custom adapter or scaffolding before use.

## When adding a first-party channel

Prefer a real channel plugin over overloading custom config when the channel will be maintained:

- `plugin.ts` declares metadata, runtime packages/modules, adapter, message actions, and setup.
- `setup.ts` handles interactive configuration and secret storage.
- `account-config.ts` validates editable account config and snapshots.
- `adapter.ts` handles inbound normalization and outbound actions.
- Tests should cover config parsing, registry/routing, MessageChannel actions, media, and error replies.

Follow existing channel patterns for Telegram, Discord, Slack, WhatsApp, or Signal rather than inventing a parallel config system.
