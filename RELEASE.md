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
2. Go to GitHub Actions.
3. Run the `release-please` workflow manually.
4. Review the Release Please PR.
5. Merge the Release Please PR when ready.
6. The merge changes `package.json`, `package-lock.json`, `CHANGELOG.md`, and `.release-please-manifest.json`.
7. That release-file push runs `release-please` again automatically.
8. Release Please creates the GitHub Release and tag.
9. The `publish-npm` job waits for the `npm-publish` environment approval.
10. Approve the deployment.
11. The package publishes to npm.

Verify:

```bash
npm view pi-downshift version
pi install npm:pi-downshift
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
