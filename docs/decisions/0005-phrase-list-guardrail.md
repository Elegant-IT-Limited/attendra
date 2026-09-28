# 5. A phrase list, not a classifier, for emergencies

**Status:** accepted, 2026-09-28

The emergency guardrail matches reviewed phrases on a rolling window of the caller's words. It does not ask a model.

A model classifier would catch more paraphrases, but it adds latency on every fragment, can be wrong in ways that are hard to test, and would make the most important behaviour in the product depend on a remote call succeeding. The phrase list is instant, deterministic, testable line by line, and reviewable by a clinician who does not read code.

We bias it toward false positives and accept the occasional unnecessary 911 line. Revisit when we have pilot transcripts to measure misses against; any model-based detector would run *in addition to* the list, never instead of it.
