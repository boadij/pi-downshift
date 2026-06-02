# Release

Downshift has two release channels:

- Stable releases: GitHub Release + npm publish
- Dev releases: GitHub prerelease only

## Commit format

Use Conventional Commits:

```text
fix: prevent duplicate handoff prompts
feat: add steered continuation after handoff
docs: clarify prompt caching behavior
chore: update release workflow
```

Release Please uses these commits to generate changelog entries and version bumps.

## Stable release flow

Stable releases are controlled through Release Please.

1. Merge normal feature/fix PRs into `main`.
2. Release Please opens or updates a release PR.
3. Review the release PR.
4. Merge the release PR when ready.
5. Release Please creates a GitHub Release and tag.
6. The `release.yml` workflow publishes the stable package to npm.
7. Verify:

```bash
npm view @boadij/pi-downshift version
pi install npm:@boadij/pi-downshift
```

Stable releases must use tags like:

```text
v0.2.0
v1.0.0
```

## Dev release flow

Dev releases are manually triggered from GitHub Actions.

1. Go to GitHub Actions.
2. Run `dev-release`.
3. Enter a prerelease version, for example:

```text
0.2.0-dev.0
```

4. Optionally enter notes.
5. The workflow creates a GitHub prerelease and uploads a `.tgz` package asset.
6. Do not publish dev releases to npm.

Dev releases must use prerelease versions like:

```text
0.2.0-dev.0
0.2.0-beta.1
```

## Local release checks

Run:

```bash
npm run release:dry
```

This runs typecheck, tests, and `npm pack --dry-run`.
