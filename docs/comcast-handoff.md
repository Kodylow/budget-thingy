# Comcast workspace handoff

This repository contains the Budget Monitor frontend, API, shared packages,
database migrations, tests, and operational documentation. Local attachments,
the unrelated reference project, agent files, data exports, test environment
files, and generated evidence are excluded.

## Git transfer

The handoff starts with a new root commit on `main`. Earlier development commits
are not ancestors of this branch and are not included when pushing it. Comcast's
approved team allocations, workspace/group mappings, and setup scripts are
intentionally retained for this private company repository.

Push only `main`, not `--all` or `--mirror`. Local backup and task branches are
not part of the handoff. Transfer through Git, not by uploading this workspace
directory or its `.git` directory: local ignored files and platform-maintained
references can still contain material excluded from the clean branch.

### Replace the GitHub branch

Confirm `origin` points to the intended **private** company repository. Back up
any work that must be kept and coordinate the replacement with its contributors.
For an existing GitHub `main`, fetch and review the remote state, then push only
the sanitized branch:

```sh
git fetch origin main
git log -5 --oneline origin/main
git push --force-with-lease origin main:main
```

For a new, empty repository, use `git push -u origin main:main` instead. Do not
substitute an unrestricted `--force` if a lease fails; review the remote changes.

Replacing `main` does not erase history retained by other GitHub branches, tags,
pull requests, forks, or existing clones. Review those separately if old material
was already uploaded. Revoke/rotate any credential previously exposed; rewriting
Git history does not revoke it.

### Update Comcast's checkout

First back up uncommitted and Comcast-only work. The following resets tracked
files to the new GitHub branch and discards local tracked changes:

```sh
git fetch origin main
git switch main
git reset --hard origin/main
```

Do not run `git clean -fdx`: ignored secrets, local data, and destination
configuration must be preserved. This reset does not purge old objects from
that existing clone. Use a fresh clone when the destination itself must have
only the sanitized history, carrying over required private configuration
separately rather than copying the old `.git` directory.

## Before publishing in Comcast

- Reconfigure the destination workspace's secrets and authorized integrations.
  Do not copy local environment files or commit credential values.
- Set `BOOTSTRAP_ADMIN_EMAIL` to Comcast's designated operator if bootstrap
  access or test email is needed. There is no built-in personal identity.
  Without a valid value, bootstrap promotion and special test-email access are
  disabled, and non-production email fails closed rather than sending to real
  recipients. Existing account-admin authorization remains in place.
- Confirm authentication uses the destination Replit app identity and allowed
  public origin. Do not carry over a test issuer or development hostname.
- Preserve the destination's database and persisted budget configuration.
  Git does not transfer local databases, cached usage, uploads, or live settings.
  Follow `database-setup.md` for the existing storage configuration.
- Review deployment settings, connected services, and any custom domain in the
  destination workspace; those settings do not transfer through Git.
- Install dependencies with `pnpm install --frozen-lockfile` and run the existing
  type checks, build, and API/frontend tests before publishing.

Budget calculations, Comcast allocations/mappings, limits, and Airtable
workflows are retained. The developer-specific bootstrap and test-email
identity is replaced by explicit destination configuration.

## Member and team-admin walkthrough

The old interactive tour is replaced by a 12-slide walkthrough. Help opens the
PDF bundled at `artifacts/budget-monitor/public/guides/budget-monitor-walkthrough.pdf`,
so the deployed app does not depend on a separate slide-authoring service.

The editable deck is in `artifacts/budget-walkthrough`; the approved wording is
in `docs/budget-monitor-walkthrough.md`. After changing the deck, validate it and
export a new PDF into the bundled location before publishing the app.

Annotated screenshots show the actual interface with sample data. Keep live
employee and financial data out of these images: the guide is a static asset,
not an authenticated report.