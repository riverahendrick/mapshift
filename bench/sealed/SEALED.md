# Sealed question set

A third benchmark set, written to be blind, and committed here as a hash before the engine it will test was frozen.

- **Hash:** SHA-256 `a5087f215f10e46b39471980067f1c062da40289941e41bb390112be95b63a59`, over `repos.json`, then each repository's question file in `repos.json` order, then `spans.json`, as bytes, one after another.
- **Size:** 120 questions on six public repositories (one JavaScript, one TypeScript, two Python, one Go, one Rust), none of them used in any earlier set.
- **Written by:** an author that worked from the repositories' source only. It never ran Mapshift or Graft and never read Mapshift's search code or earlier question sets.
- **Kept from tuning:** nobody tuning Mapshift has read a question or an answer. The repository names were seen once, in a folder listing; nothing was run on those repositories before the scored run.
- **Rules for the run:** the matching rule is `matches()` in `run-heldout.mjs`, unchanged. Both tools run once, with no hand queries before the run and no edits to questions, answers or the rule after it. The results are published whatever they show.

The question files are added to this folder with the results, so anyone can check them against the hash above.
