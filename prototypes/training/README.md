# CutRank training workspace · local prototype

Serve the repository root locally, then open `/prototypes/training/`.

The prototype includes a workout logger with per-set weight, reps and RIR;
add-set and completion controls; session saving; lift charts; a body-weight
trend; optional calorie/protein/weight check-ins; and a simulated coach chat.
Example data and edits are saved in browser localStorage under
`cutrank_training_prototype_v1`. The example week is 12–18 October 2026.

Charts show rounded axis ticks, latest values and period changes. Hover, tap or
focus a session to inspect its exact numbers; use arrow keys to move between
sessions. The lift table expands below the graph. Body-weight charts use a
minimum 2 kg domain so small changes stay visually small.

Coach replies are scripted and visibly labelled. No AI provider, account,
payment, live API, email or real user history is connected. Example calorie
target changes require explicit acceptance. The mockup is a design and
interaction review, not a production Pro entitlement or nutrition service.

The production build excludes `prototypes/`. This branch can be pushed for
review without adding a live feature to cutrank.app.

Before production: agree the design, model workouts/check-ins in the private
API, enforce Pro server-side, add account-scoped storage and deletion, then
connect a bounded coach that cites log evidence, asks for missing context and
recognises situations requiring qualified support. Real calorie suggestions
need a reviewed decision policy rather than this demo's simplified rule.
