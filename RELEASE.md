# Release

## Checklist

1. Confirm the working tree is clean enough to release.

   ```bash
   git status
   ```

2. Run checks and inspect the package contents.

   ```bash
   npm run release:dry
   ```

3. Create a local package tarball.

   ```bash
   npm pack
   ```

4. Install the tarball in Pi and smoke test it.

   ```bash
   pi install ./boadij-pi-downshift-<version>.tgz
   ```

   Smoke test:

   ```text
   /reload
   /downshift
   /downshift help
   /downshift status
   /downshift config
   /downshift now
   /downshift off
   /downshift on
   ```

5. Bump the version.

   ```bash
   npm version patch
   ```

   Use `minor` for meaningful feature additions and `major` for breaking changes after 1.0.

6. Publish.

   ```bash
   npm publish --access public
   ```

7. Verify npm.

   ```bash
   npm view @boadij/pi-downshift version
   ```

8. Verify install from npm.

   ```bash
   pi install npm:@boadij/pi-downshift
   ```

## Versioning

Before 1.0:

- patch: bug fixes, docs, small polish
- minor: new commands, changed defaults, meaningful behavior changes

After 1.0:

- patch: backward-compatible bug fixes
- minor: backward-compatible features
- major: breaking command, config, or behavior changes
