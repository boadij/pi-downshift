# Release

Downshift has one published release channel:

- Stable releases: GitHub Release + npm publish

Development builds are tested locally with `pi -e .`, `pi install .`, or a local packed tarball.

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
6. The `release-please.yml` workflow publishes the stable package to npm.
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

## Local release checks

Run:

```bash
npm run release:dry
```

This runs typecheck, tests, and `npm pack --dry-run`.
