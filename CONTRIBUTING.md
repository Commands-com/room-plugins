# Contributing

Thanks for helping expand the Commands.com room plugin ecosystem.

This repository is for external room orchestrator plugins and the tooling/docs needed to install and validate them. The goal is to make it easy for contributors to add new room types without requiring source access to Commands Desktop itself.

## What Belongs Here

Good fits for this repo:

- New external room orchestrator plugins
- Improvements to existing room plugins
- Installer, allowlist, hashing, and local dev tooling for room plugins
- Documentation that helps people build, validate, or safely install room plugins

Usually not a fit:

- Changes that belong inside the main Commands Desktop app
- Private one-off plugins that cannot be shared or documented
- Breaking changes to shared contracts without corresponding docs updates
- Plugins that depend on undeclared files outside their own directory

## Ground Rules

Please keep contributions self-contained, honest, and easy to verify.

- A plugin should live entirely inside its own folder under `room-plugins/`, unless it intentionally depends on a documented shared library in this repo such as `room-plugins/sql-optimizer-core` or `room-plugins/core-room-support`.
- Do not add hidden dependencies on another plugin's private files.
- Keep manifests and runtime behavior aligned with the documented contract.
- Prefer clear, boring installation and validation steps over clever setup.
- Document any external services, binaries, credentials, or runtime assumptions.

## Adding a New Room Plugin

1. Start from `room-plugins/template-room` for imperative rooms, or from an existing family plugin if you are extending a declarative pattern.
2. Give the plugin a stable, descriptive `orchestratorType`.
3. Add or update:
   - `manifest.json`
   - `index.js`
   - any supporting `lib/` files
   - README notes inside the plugin folder if setup is non-trivial
4. Reinstall locally with the room-plugin installer.
5. Verify the plugin can be discovered and loaded by Commands Desktop.

## Required Documentation

Every contribution should make its operational limits obvious.

- If a plugin needs Docker, databases, cloud credentials, or local binaries, say so clearly.
- If a plugin is experimental, say so clearly.
- If a plugin is intended only for local/dev use, say so clearly.
- If a plugin shares code through a common library, document that dependency in the plugin and in the shared library.

## Validation

Before opening a PR, run the checks that apply to your change.

Common commands:

```bash
./scripts/install-room-plugins.sh --plugin <name>
node scripts/install-room-plugins.mjs --plugin <name>
node scripts/generate-room-allowlist.mjs
node scripts/compute-room-plugin-sha256.mjs ./room-plugins/<name>
node scripts/dev-runner.js --help
```

If your plugin has its own validation steps, include them in the PR description.

## PR Checklist

Please aim to include:

- A short explanation of what the plugin or change does
- Any setup/runtime requirements
- Validation steps you ran
- Doc updates when behavior or workflow changes
- Screenshots or sample output when UI/dashboard behavior changes

## Compatibility Expectations

Keep compatibility in mind when changing shared scripts or contracts.

- Do not break existing room plugins unnecessarily.
- If you change the contract, update the docs in `docs/`.
- If you change installers or allowlist generation, make sure single-plugin install still works.

## Security and Trust

Room plugins are executable code loaded by a local desktop app.

- Avoid surprising behavior.
- Minimize unnecessary filesystem, process, or network access.
- Keep allowlist/integrity behavior intact.
- Do not weaken loading safeguards without a strong reason and a matching docs update.

## Questions

If a change is large or changes the contract shape, open an issue or draft PR first so the approach can be aligned before too much work lands.
