// Self-narrating L402 authorization demo. One window, every line true at run
// time: real did:key VACs, real eddsa-jcs-2022 signatures, the real engine + hook
// + seller verifier. No real sats, no broadcast, no live Lightning network — the
// OP authorization gate is what's shown. Buyer side first, then the seller wedge.
//
//   npm run build && node demo/scenes.mjs        (DEMO_PAUSE=ms to pace)
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeAgent, issueVac, verifierConfig } from '../test/fixtures/gen.mjs';
import { handleL402PaymentHook, issueChallenge, signPresentation, verifyPresentationForServing } from '../dist/index.mjs';

const g = '\x1b[1;32m', r = '\x1b[1;31m', c = '\x1b[1;36m', d = '\x1b[2m', b = '\x1b[1m', x = '\x1b[0m';
const pause = () => new Promise((res) => setTimeout(res, Number(process.env.DEMO_PAUSE ?? 1400)));
const box = (s) => { console.log(`\n${c}┌${'─'.repeat(72)}┐${x}`); for (const ln of s.match(/.{1,70}(\s|$)/g)) console.log(`${c}│ ${b}${ln.trim().padEnd(70)}${x}${c} │${x}`); console.log(`${c}└${'─'.repeat(72)}┘${x}`); };

const dir = mkdtempSync(join(tmpdir(), 'l402-demo-'));
const principal = makeAgent();      // the authorizing principal (a human/org/Sovereign cert)
const agent = makeAgent();          // the agent that holds the key and transacts
const vac = issueVac({ issuerDid: principal.did, issuerPriv: principal.privateKey, issuerVm: principal.vm, subjectDid: agent.did, ceilingSats: 100000, allowList: ['api.example.com'] });
const credPath = join(dir, 'agent-delegation.json'); writeFileSync(credPath, JSON.stringify(vac));
const config = verifierConfig(principal.did, dir, credPath);

console.log(`${d}one did:key authorization · ${principal.did.slice(0, 24)}… authorized ${agent.did.slice(0, 18)}… · ≤100,000 sats, only to api.example.com${x}`);

box('BUYER, in mandate: the agent is about to pay a 50,000-sat L402 invoice from api.example.com. lnget calls the OP pre-payment hook first.');
console.log(`${d}$ POST $PRE_PAYMENT_HOOK_URL  { origin: api.example.com, invoice: lnbc500u… }${x}`);
let h = await handleL402PaymentHook(config, { origin: 'https://api.example.com/paid', invoice: 'lnbc500u1demo' });
console.log(`  ${g}${h.decision.toUpperCase()}${x}  ${h.reason}  ${d}→ lnget pays; the key signs.${x}`);
await pause();

box('BUYER, over the line: a 150,000-sat invoice, past the 100,000 ceiling. The hook denies before lnget pays — the key is never reached.');
console.log(`${d}$ POST $PRE_PAYMENT_HOOK_URL  { origin: api.example.com, invoice: lnbc1500u… }${x}`);
h = await handleL402PaymentHook(config, { origin: 'https://api.example.com/paid', invoice: 'lnbc1500u1demo' });
console.log(`  ${r}${h.decision.toUpperCase()}${x}  ${h.reason}  ${d}→ no payment, nothing signed.${x}`);
await pause();

box('SELLER (Aperture), the wedge: a paid endpoint requires a holder-bound credential. It issues a challenge; the agent presents a VP signed by its own did:key.');
const ch = issueChallenge('api.example.com');
console.log(`${d}seller → challenge ${ch.challenge.slice(0, 16)}…   agent → VP signed by ${agent.did.slice(0, 18)}…${x}`);
const vp = signPresentation({ credential: vac, holderDid: agent.did, holderPrivateKey: agent.privateKey, challenge: ch.challenge, domain: ch.domain });
let s = await verifyPresentationForServing(config, vp, { challenge: ch.challenge, domain: ch.domain });
console.log(`  ${s.serve ? g + 'SERVE' : r + 'REFUSE'}${x}  ${s.reason}  ${d}(${s.holderDid?.slice(0, 18)}… proved control of its key)${x}`);
await pause();

box('SELLER refuses a stolen credential: the SAME credential presented WITHOUT a holder proof — a bearer token. Macaroons cannot stop this; OP does.');
const bare = { ...vp }; delete bare.proof;
s = await verifyPresentationForServing(config, bare, { challenge: ch.challenge });
console.log(`  ${r}REFUSE${x}  ${s.reason}`);
await pause();

console.log(`\n${d}lnget moves the sats. Whether an agent is authorized to spend, and whether it truly holds the credential it presents, is Observer Protocol — at the key, fail-closed, no Lightning Labs code changed.${x}`);
