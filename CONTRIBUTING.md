# Contributing

Discuss changes to account ownership, request correlation, approval handling, storage format, or retry behavior before extending them. Keep PRs focused and add regression coverage for behavioral changes.

```sh
npm ci --ignore-scripts
npm run check
npm test
npm run check:package
```

The plugin loads source directly; do not commit node_modules, generated dist files, credentials, environment files, or runtime stores. Client registration ID must match the manifest package name. Use Harness theme tokens and locale text for UI.

Mock WeChat requests in tests. Do not send real messages from CI. Document real-device tests separately without publishing private data. Passing mocks does not establish provider idempotency, authentication interoperability, or broad runtime compatibility.

A release needs a reviewed diff, passing checks, verified tarball contents, matching manifest/lockfile version, updated changelog, and honest compatibility declarations. npm publishing is manual and outside the GitHub push workflow. Contributions are licensed under this repository's MIT license.
