/**
 * Self-signed play for players with a NEAR account (NEP-366 meta transactions).
 *
 * When a player connects a wallet, their browser makes a key pair and the player approves
 * one wallet transaction adding the public key to their account as a function-call key
 * that may only call the Fiasco contract's player methods. Each bet is then signed in the browser as a delegate action
 * with that key and handed to the game, which relays it on-chain and pays the gas. The
 * contract sees the player's own account as the caller, so the game server cannot place,
 * change or forge a bet for them, and there is no popup per bet.
 *
 * This module runs in the browser (signing) and on the server (checking and relaying).
 */
import { KeyPair, PublicKey } from "@near-js/crypto";
import type { KeyPairString } from "@near-js/crypto";
import {
  actionCreators,
  buildDelegateAction,
  encodeDelegateAction,
  Signature,
  signDelegateAction,
} from "@near-js/transactions";
import { sha256 } from "@noble/hashes/sha256";

/** Methods the wallet key is allowed to call. */
export const PLAYER_METHODS = ["place_bet", "place_sell", "cash_out", "buy_in"] as const;
export type PlayerMethod = (typeof PLAYER_METHODS)[number];

export const META_GAS = BigInt("30000000000000");
/** How long a signed action stays valid, in blocks (about five minutes). */
export const VALID_BLOCKS = 300;

export type DelegatePayload = {
  senderId: string;
  receiverId: string;
  methodName: PlayerMethod;
  args: Record<string, unknown>;
  nonce: string;
  maxBlockHeight: string;
  publicKey: string;
  signature: string;
};

const toBase64 = (bytes: Uint8Array) => {
  let s = "";
  bytes.forEach((b) => (s += String.fromCharCode(b)));
  return btoa(s);
};
const fromBase64 = (b64: string) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));

function delegateOf(p: Omit<DelegatePayload, "signature">) {
  return buildDelegateAction({
    senderId: p.senderId,
    receiverId: p.receiverId,
    actions: [actionCreators.functionCall(p.methodName, p.args, META_GAS, BigInt(0))],
    nonce: BigInt(p.nonce),
    maxBlockHeight: BigInt(p.maxBlockHeight),
    publicKey: PublicKey.from(p.publicKey),
  });
}

/** Browser side: sign one player action with the wallet key. */
export async function signPlayerAction(opts: {
  secretKey: string;
  senderId: string;
  receiverId: string;
  methodName: PlayerMethod;
  args: Record<string, unknown>;
  nonce: bigint;
  blockHeight: number;
}): Promise<DelegatePayload> {
  const keyPair = KeyPair.fromString(opts.secretKey as KeyPairString);
  const unsigned = {
    senderId: opts.senderId,
    receiverId: opts.receiverId,
    methodName: opts.methodName,
    args: opts.args,
    nonce: opts.nonce.toString(),
    maxBlockHeight: String(opts.blockHeight + VALID_BLOCKS),
    publicKey: keyPair.getPublicKey().toString(),
  };
  const { signedDelegateAction } = await signDelegateAction({
    delegateAction: delegateOf(unsigned),
    signer: { sign: async (message: Uint8Array) => keyPair.sign(sha256(message)).signature },
  } as unknown as Parameters<typeof signDelegateAction>[0]);
  return { ...unsigned, signature: toBase64(signedDelegateAction.signature.data) };
}

/** Browser side: sign a login proof so the server knows this browser holds the key. */
export function signLinkProof(secretKey: string, accountId: string, issuedAt: number): string {
  const keyPair = KeyPair.fromString(secretKey as KeyPairString);
  const message = new TextEncoder().encode(`fiasco-link:${accountId}:${issuedAt}`);
  return toBase64(keyPair.sign(sha256(message)).signature);
}

/** Server side: does this proof come from the holder of `publicKey`? */
export function verifyLinkProof(publicKey: string, accountId: string, issuedAt: number, signature: string): boolean {
  try {
    const message = new TextEncoder().encode(`fiasco-link:${accountId}:${issuedAt}`);
    return PublicKey.from(publicKey).verify(sha256(message), fromBase64(signature));
  } catch {
    return false;
  }
}

/** Server side: is the payload's signature valid for the action it describes? */
export function verifyPayload(p: DelegatePayload): boolean {
  try {
    const message = encodeDelegateAction(delegateOf(p));
    return PublicKey.from(p.publicKey).verify(sha256(message), fromBase64(p.signature));
  } catch {
    return false;
  }
}

/** Server side: the action to put in the relayer's transaction (receiver = the player). */
export function signedDelegateAction(p: DelegatePayload) {
  return actionCreators.signedDelegate({
    delegateAction: delegateOf(p),
    signature: new Signature({ keyType: PublicKey.from(p.publicKey).keyType, data: fromBase64(p.signature) }),
  });
}

export function newWalletKey(): { secretKey: string; publicKey: string } {
  const kp = KeyPair.fromRandom("ed25519");
  return { secretKey: kp.toString(), publicKey: kp.getPublicKey().toString() };
}

