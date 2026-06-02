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

## Versioning

Release Please owns release version files:

- `package.json`
- `package-lock.json`
- `CHANGELOG.md`
- `.release-please-manifest.json`

Do not manually bump `package.json` for a release.

To request an exact version, create a `Release-As:` commit:

```bash
git commit --allow-empty \
  -m "chore: release 0.2.1" \
  -m "Release-As: 0.2.1"

git push origin main
```

If the repo has the helper script, use:

```bash
npm run release:as -- 0.2.1
```

Then run the `release-please` workflow manually.

## Stable release flow

Stable releases are controlled through Release Please.

1. Merge normal feature/fix PRs into `main`.
2. Optional: create a `Release-As:` commit if the release must use an exact version.
3. Go to GitHub Actions.
4. Run the `release-please` workflow manually.
5. Review the Release Please PR.
6. Merge the Release Please PR when ready.
7. The merge changes `package.json`, `package-lock.json`, `CHANGELOG.md`, and `.release-please-manifest.json`.
8. That release-file push runs `release-please` again automatically.
9. Release Please creates the GitHub Release and tag.
10. The `publish-npm` job waits for the `npm-publish` environment approval.
11. Approve the deployment.
12. The package publishes to npm.

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

Test locally without publishing:

```bash
pi -e .
```

Or install from the local package path:

```bash
pi install .
```

Or test the packed package:

```bash
npm pack
pi install ./pi-downshift-<version>.tgz
```
