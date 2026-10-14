# Contributing

Discuss changes to account ownership, request correlation, approval handling, storage format, or retry behavior before extending them. Keep PRs focused and add regression coverage for behavioral changes.

```sh
npm ci --ignore-scripts
npm run build:vendor
npm run check
npm test
npm run check:package
```

The Host loads source plus the checked-in `vendor/` QR bundle. Commit the regenerated bundle, dependency manifest, and complete licenses when updating QR dependencies. `npm run check` rebuilds in memory and rejects stale artifacts. Do not commit node_modules, generated dist files, credentials, environment files, or runtime stores. Client registration ID must match the manifest package name. Use Harness theme tokens and locale text for UI.

Mock WeChat requests in tests. Do not send real messages from CI. Document real-device tests separately without publishing private data. Passing mocks does not establish provider idempotency, authentication interoperability, or broad runtime compatibility.

The `qrcode` and `esbuild` development dependencies are only needed by maintainers; never add them as runtime dependencies or add installation lifecycle scripts.

A release needs a reviewed diff, passing checks, verified tarball contents, matching manifest/lockfile version, updated changelog, and honest compatibility declarations. npm publishing is manual and outside the GitHub push workflow. Contributions are licensed under this repository's MIT license.
