# Contributing

Start with [team handoff](../docs/TEAM_HANDOFF.md) and [module assignments](../docs/TASKS.md).

## Team workflow

Collaborators clone the repository. External contributors fork it first.

```bash
git clone https://github.com/qiaoyan11/Plain-language-to-smart-contracts.git
cd Plain-language-to-smart-contracts
git switch -c feature/agent1
```

Replace the branch and directory with your module.

```bash
git status
git add agent1/
git commit -m "Add clarification flow"
git push -u origin feature/agent1
```

Open a pull request to main, describe the change and checks, and ask a teammate to review. Do not push directly to main after initialization. Ownership is a convention, not folder permissions.

Commit local work before synchronizing:

```bash
git fetch origin
git merge origin/main
```

After merging a PR, begin the next task on a new branch from updated main:

```bash
git switch main
git pull --ff-only origin main
git switch -c feature/agent1-next-task
```

## Review rules

- Shared interface changes require affected owners to agree.
- Each contributor connects and documents their own module.
- Submit small PRs and include actual verification results.
- Never commit secrets, private agreements or model checkpoints.
- Python agents follow shared/INTERFACES.md; LangGraph owns the generation/validation/repair workflow.
- Credit reused upstream code and preserve applicable licenses.

Branch protection and CODEOWNERS are not configured. These review rules are not yet technically enforced. Real contributor usernames are needed before configuring ownership.
