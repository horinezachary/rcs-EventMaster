# Event Master module

A Rack Control Surface module for Barco Event Master processors (E2, S3-4K, EX); see README.md. Built like
the other module repos (rcs-led-processor-module, rcs-videohub-router): SDK linked from a
rack-control-surface checkout, signed releases on every merge to master (the default branch).

## Working agreement

Features go on a branch and a pull request. Zac reviews, then merges. Title PRs `feat: ...` for features and
`fix: ...` for fixes; the title decides the version bump.

## Real processors

Event Master processors are live show equipment. Reading from them is fine. **Ask Zac before sending any
command to a real processor** (activatePreset, allTrans, cut, or any other method that changes the show).
Develop against the simulator (`src/sim`, `npm run sim`).

The processor is the source of truth: config and state hold only the module's own settings; start, restore and
reconnect only read; commands go out only on an operator action with Allow controls on.
