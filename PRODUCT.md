# Product

## Register

product

## Users
One competitive debater (PF/policy/LD) working in CardMirror on a Mac. Two moments: mid-round, between speeches, sending or grabbing docs from SpeechDrop under time pressure; and after the round, calmly disclosing a speech doc to the openCaselist and checking Tabroom pairings. The job is always "get this doc where it needs to go, correctly, without leaving CardMirror."

## Product Purpose
A CardMirror plugin (plus a local helper) that uploads docs to SpeechDrop, opens docs dropped by opponents, shows Tabroom rounds, and discloses rounds to openCaselist. Success: the round never stalls on file transfer, and nothing is ever posted to a public caselist by accident.

## Brand Personality
Built-in, quick, trustworthy. The dialogs should feel like part of CardMirror, not a bolted-on web form: same colors, type and spacing as CardMirror's own dialogs, following its light/dark theme. Calm confidence: what's about to happen is always visible before it happens.

## Anti-references
- Generic HTML web forms or Bootstrap-style stacked fields with gray default buttons.
- Fixed-size modals whose contents overflow, or labels that wrap awkwardly.
- Anything flashy: gradients, glow, decorative animation.

## Design Principles
1. **Native to the host.** Inherit CardMirror's theme and rhythm; never fight its stylesheet.
2. **Show before send.** Public or irreversible actions name exactly what will happen (file, destination) before the button is pressed.
3. **Fast path first.** Mid-round actions are one prompt deep, keyboard-complete, and pre-filled from the last use.
4. **Quiet until it matters.** Status lives in small, steady text; only errors and confirmations raise their voice.

## Accessibility & Inclusion
WCAG 2.2 AA contrast in both themes, complete keyboard operation (Tab order, Enter/Esc, visible focus), and respect for prefers-reduced-motion.
