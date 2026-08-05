# Distribution map — mppx-op-account launch

The OWS-playbook step: map the lanes before launch day, name who maintains each, its
posture, whether the credential/delegation/enforcement lane is empty there, and the right
vector. Same honesty clauses as the OWS issue (#232): credit what exists, claim the layer
not the deployment, no invulnerability claims, artifact-as-evidence not a pitch.

## The shape of the move (read first)
OP needs **no core change to mppx**. mppx already exposes the viem `account` slot; our
adapter is a drop-in `account`. So the vector everywhere is *"here is an artifact that
composes with your existing extension point,"* not *"please merge my change."* That keeps
every conversation low-friction and non-territorial.

## Lanes

### 1. `wevm/mppx` — the SDK (PRIMARY, now)
- **Maintainer:** wevm (the viem / wagmi / ox team). MIT, viem-native, extension via the
  account interface + framework middlewares.
- **Posture:** open SDK, builder-friendly, composition-first.
- **Is the lane empty?** Yes for *enforcement*: mppx ships session/escrow/voucher
  mechanics but no signed-mandate / delegation-credential verification. The custom-account
  slot is the designed seam — nobody is filling it with a portable, revocable mandate.
- **Vector:** a **GitHub Discussion** (not a core PR — nothing to merge) titled around
  "verifiable spending mandates as a drop-in account," linking the public package + the
  live-fire result against the real escrow ABI. Offer, don't ask.
- **Timing:** launch day.

### 2. `tempoxyz/mpp-specs` + IETF `draft-ryan-httpauth-payment` — the spec
- **Maintainer:** Tempo (spec repo) and the IETF draft author. Standardization track for
  the Payment HTTP auth scheme.
- **Posture:** specification; careful, consensus-oriented.
- **Is the lane empty?** The spec defines payment/voucher mechanics; a *policy/verifier*
  or principal-bound credential concept is not part of it. Complementary, not competing.
- **Vector:** a light **issue/discussion** noting signer-boundary enforcement as a
  complementary layer above the wire protocol — awareness, not a spec change. Flag the
  IETF draft as the eventual venue if a "verifier" concept is ever standardized.
- **Timing:** launch week, light touch. No spec PR.

### 3. Tempo **TIPs** (`tips.sh`, GitHub Discussions) — protocol governance
- **Maintainer:** Tempo protocol. Process is **discussion-first**: an Idea in the TIP
  repo's GitHub Discussions → community consensus → Draft TIP as a PR (no number until
  vetted).
- **Is the lane empty?** A "custom verifier / pre-sign policy" concept at the protocol
  level does not exist as a TIP.
- **Assessment — POST-TRACTION move (not now).** A TIP is protocol governance; proposing
  one before any wallet integration or design-partner signal reads as overreach and burns
  goodwill. Correct sequence: ship the artifact → land a native integration or
  design-partner signal → *then* seed a TIP **Idea** in Discussions with the artifact +
  traction as evidence, and only file a Draft TIP once there's organic support. Seeding the
  Idea discussion early is acceptable **only** if a conversation arises organically; do not
  manufacture it.

### 4. `mpp.dev` / Tempo community (Discord, social) — awareness
- **Posture:** community/builder awareness.
- **Vector:** a short post once the package is public, pointing at the repo + a one-line
  "what it does." Low stakes.
- **Timing:** launch day, after the package is live.

### 5. OP's own channels — the launch post
- Ties to the thesis memo positioning (second engine = portability proven). The strongest
  single line: *the only thing that changed between the OWS engine and this one was the
  decoder.*
- **Timing:** launch day.

## TIP route — verdict
**Post-traction.** The working adapter + live-fire is the evidence a TIP would need; it is
strongest *after* a wallet or design partner has skin in the game. Now-move is lanes 1, 4,
5 (and a light 2). Hold the formal TIP until there is traction to cite.

---

## Announcement drafts (honesty clauses applied)

### Draft A — `wevm/mppx` GitHub Discussion
> **Title:** Verifiable, revocable spending mandates as a drop-in mppx account
>
> mppx's account slot turned out to be a clean place to enforce a *signed spending
> mandate* before anything is signed. We built `@observer-protocol/mppx-op-account` — a
> custom viem account that wraps your base account and, on each escrow `open`/`topUp` and
> each voucher, verifies an Observer Protocol delegation credential (W3C, eddsa-jcs-2022)
> against the actual payload: per-rail ceiling, counterparty, temporal window, and a
> cross-session velocity cap. If the action is outside the signed mandate, the account
> throws and the key never signs.
>
> It needs **no change to mppx** — it composes via the existing `account` interface. The
> escrow decode, the `computeChannelId` derivation, and the voucher types are confirmed
> against the real `mppx@0.7.0` ABI, exercised by a live-fire harness using that ABI + a
> real viem signer. Scope and exact bounds (velocity-counter scope, recovery semantics) are
> stated plainly in the support matrix — nothing is claimed that a fixture doesn't prove.
>
> Sharing as an artifact in case it's useful to others building agent wallets on MPP;
> happy to take feedback on the seam. [link]

### Draft B — `tempoxyz/mpp-specs` issue (light, complementary)
> **Title:** Note: signer-boundary mandate enforcement as a complementary layer
>
> Not a spec change — a note for anyone thinking about agent-authority controls on MPP.
> The session/escrow/voucher mechanics are a clean wire protocol; we found the
> wallet-signer boundary a natural place to enforce a *portable, revocable* spending
> mandate above it (per-rail ceiling, counterparty, velocity), verified from the payload,
> fail-closed. Implementation composes with mppx unchanged: [link]. Flagging in case a
> "verifier"/policy concept is ever interesting for the spec or the IETF draft. The escrow
> mechanics genuinely bind on-chain — this is an identity + portability layer on top, not a
> replacement.

### Draft C — community / social (short)
> New: `@observer-protocol/mppx-op-account` — drop-in viem account that checks a signed,
> revocable spending mandate against every MPP/Tempo escrow + voucher, at the key,
> fail-closed. Composes with mppx, no core change. Confirmed against the real escrow ABI.
> The same mandate format the OWS verifier checks — only the decoder changed. [link]

## Honesty clauses (apply to all drafts)
- Credit mppx/Tempo: the escrow/voucher mechanics **genuinely bind**; OP is an identity +
  portability layer above them, not a fix for theater.
- Claim the **layer**, not deployment: enforcement holds where a signing seam exists.
- No invulnerability: a compromised signer host bypasses in-process checks; remote-signer
  is the hardened end-state. Correct placement, not magic.
- Artifact as evidence, offered — never a pitch, never "you need this."
