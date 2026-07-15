# Test Quality Rubric
Judge whether the tests in this diff actually protect the changed behaviour.
Be exhaustive about coverage — even for small or "trivial" functions.

ALWAYS report a finding when, for code added or changed in this PR:
- A branch / conditional / early-return has no test that exercises it.
- A boundary value is untested (the exact threshold and threshold ± 1).
- Tests assert only the happy path while edge inputs (empty, null, negative, max) go unverified.
- A mock asserts the very thing under test (tautology), or a test relies on time / order / network / randomness (flaky).

Cite file:line in the diff and name the uncovered branch or case.
Do NOT skip a gap because the function looks small.