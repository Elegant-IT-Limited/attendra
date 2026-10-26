## What and why

<!-- One paragraph: the change and the reason for it. Link the issue. -->

## Checklist

- [ ] `pnpm lint && pnpm typecheck && pnpm test` pass locally
- [ ] New behaviour has a unit test; agent behaviour has an eval scenario in `evals/scenarios/`
- [ ] Words the caller or the assistant says ship with their Spanish twin, a row in `language-parity.test.ts`, and a Spanish eval when there is an English one (CONTRIBUTING.md, Languages)
- [ ] No real patient data anywhere: code, fixtures, screenshots, this description
- [ ] Any new PHI field is encrypted and covered by the redaction test
- [ ] Every commit is signed off (`git commit -s`), see CONTRIBUTING.md
