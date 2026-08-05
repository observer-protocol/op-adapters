import { keccak256, encodeAbiParameters } from 'viem';
import type { Address, Hex } from './adapter-types.js';

// Derive the MPP/Tempo channel id the way the TempoStreamChannel contract does.
// Byte-identical to mppx's Channel.computeId (mppx@0.7.0,
// dist/tempo/legacy/session/Channel.js):
//   keccak256(abi.encode(payer, payee, token, salt, authorizedSigner,
//                        escrowContract, chainId))
// All inputs are available at signTransaction time: payer = the signer address,
// payee/token/salt/authorizedSigner from the `open` calldata, escrowContract +
// chainId from config. So an `open` can be linked to its channel offline, no
// on-chain read. We use viem's keccak256/encodeAbiParameters (already required
// via mppx) rather than vendoring a hand-rolled keccak — same code path the SDK
// uses, so the derivation cannot silently diverge.

export interface ChannelIdParams {
  payer: Address;
  payee: Address;
  token: Address;
  salt: Hex; // bytes32
  authorizedSigner: Address;
  escrowContract: Address;
  chainId: number | bigint;
}

export function computeChannelId(p: ChannelIdParams): Hex {
  return keccak256(
    encodeAbiParameters(
      [
        { type: 'address' },
        { type: 'address' },
        { type: 'address' },
        { type: 'bytes32' },
        { type: 'address' },
        { type: 'address' },
        { type: 'uint256' },
      ],
      [p.payer, p.payee, p.token, p.salt, p.authorizedSigner, p.escrowContract, BigInt(p.chainId)],
    ),
  );
}
