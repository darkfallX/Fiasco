"use client";

/**
 * Connecting a NEAR wallet, through NEAR Wallet Selector (Meteor, HERE, Intear).
 *
 * The player picks a wallet and signs in, then approves one transaction that adds the
 * game's key to their account. That key can only call the game's player methods on the
 * Fiasco contract, with a small gas allowance. From then on the browser signs each bet
 * with it and the game relays the signed bets, so there are no more wallet popups.
 *
 * Loaded on demand, so players who never connect a wallet never download it.
 */
import { PLAYER_METHODS } from "@/lib/near/delegate";

const ALLOWANCE_YOCTO = "250000000000000000000000"; // 0.25 NEAR of gas the key may spend itself

export async function connectAndAddKey(contractId: string, publicKey: string): Promise<{ accountId: string }> {
  const [{ setupWalletSelector, internalActionToNaj }, { setupModal }, meteor, here, intear] = await Promise.all([
    import("@near-wallet-selector/core"),
    import("@near-wallet-selector/modal-ui"),
    import("@near-wallet-selector/meteor-wallet"),
    import("@near-wallet-selector/here-wallet"),
    import("@near-wallet-selector/intear-wallet"),
  ]);
  // @ts-expect-error CSS has no type declarations; Next bundles it.
  await import("@near-wallet-selector/modal-ui/styles.css");

  const selector = await setupWalletSelector({
    network: "testnet",
    modules: [meteor.setupMeteorWallet(), here.setupHereWallet(), intear.setupIntearWallet()],
  });

  const signedIn = async (): Promise<string> => {
    const existing = selector.store.getState().accounts.find((a) => a.active) ?? selector.store.getState().accounts[0];
    if (existing) return existing.accountId;
    const modal = setupModal(selector, { description: "Connect the account that will sign your bets." });
    return new Promise<string>((resolve, reject) => {
      const sub = selector.on("signedIn", ({ accounts }) => {
        sub.remove();
        hidden.remove();
        resolve(accounts[0].accountId);
      });
      const hidden = modal.on("onHide", ({ hideReason }) => {
        if (hideReason === "user-triggered") {
          sub.remove();
          hidden.remove();
          reject(new Error("Wallet connection cancelled"));
        }
      });
      modal.show();
    });
  };

  const accountId = await signedIn();
  const wallet = await selector.wallet();
  await wallet.signAndSendTransaction({
    signerId: accountId,
    receiverId: accountId,
    actions: [
      internalActionToNaj({
        type: "AddKey",
        params: {
          publicKey,
          accessKey: {
            permission: { receiverId: contractId, allowance: ALLOWANCE_YOCTO, methodNames: [...PLAYER_METHODS] },
          },
        },
      }),
    ],
  });
  return { accountId };
}
