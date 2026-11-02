# Start here, even in a new AI conversation

Read README.md, docs/WORKLOG.md (decisions and newest log), docs/TASKS.md,
shared/INTERFACES.md, then the README in your assigned module before editing.
User instructions take precedence. Do not infer completion from a plan or stub.

- Preserve the working frontend, Node server and reference contracts.
- Codex does not edit validation/ or REVIEW.md. Claude owns them.
- Work in your assigned folder and a feature branch. Shared interfaces or another
  owner's files require coordination; record agreed changes in WORKLOG first.
- Wire JSON uses camelCase, integer wei strings and versioned schemas.
- Check module input/output with shared.handoff; do not bypass failed checks.
- Stubs are fixtures, never AI performance results or deployment approval.
- Keep hidden evaluation tests/results out of generator prompts and feedback.
- Never commit credentials or let a model construct commands or sign transactions.
- Run npm run e2e for handoff changes. Run npm test / npm run test:api when changing
  contracts or app behavior. Describe test results and remaining limits in the PR.
- Add a newest-first Chinese WORKLOG entry (at most 10 lines) for completed work.
  Do not rewrite other contributors' logs. Keep main runnable.

Concrete setup, replacement points and a copyable AI prompt:
docs/TEAM_HANDOFF.md.
