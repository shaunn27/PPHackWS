import { randomBytes, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";

import type { ParticipantShare, SplitMode } from "./calculateSplit";
import type { ReviewedReceipt } from "./receipt";

/*
 * A deliberately simple store for split sessions: an in-memory Map, saved to
 * a JSON file after every change so sessions survive a server restart.
 * Good enough for a demo; a real product would use a database.
 *
 * SPLIT_DATA_FILE sets the file path. An empty value keeps everything in
 * memory only (used by the tests).
 */

/**
 * host:    the host's own share, or a share of 0.00 (nothing to collect)
 * pending: waiting for this friend to pay
 * claimed: the friend says they paid another way (cash, bank transfer...);
 *          NOT counted as paid until the host confirms it
 * paid:    settled, either by a verified PayPal capture or confirmed by the host
 */
export type ParticipantStatus = "host" | "pending" | "claimed" | "paid";

export const CLAIM_METHODS = [
  "cash",
  "bank_transfer",
  "other_app",
  "other",
] as const;

export type PaymentClaim = {
  method: (typeof CLAIM_METHODS)[number];
  note?: string;
  claimedAt: string;
};

export type StoredParticipant = {
  id: string;
  name: string;
  isHost: boolean;
  /** secret in this person's pay link */
  payToken: string;
  share: ParticipantShare;
  status: ParticipantStatus;
  orderId?: string;
  captureId?: string;
  paidAt?: string;
  /** how a paid share was settled */
  paidVia?: "paypal" | "other";
  /** the friend's "I've paid another way" claim, while it awaits the host */
  claim?: PaymentClaim;
  /** when the host confirmed a payment made outside PayPal */
  confirmedAt?: string;
  /** when the host last said a claimed payment hadn't arrived */
  claimRejectedAt?: string;
};

export type StoredSplit = {
  id: string;
  /** secret in the host's dashboard link */
  hostToken: string;
  createdAt: string;
  hostName: string;
  hostEmail: string;
  mode: SplitMode;
  receipt: ReviewedReceipt;
  participants: StoredParticipant[];
};

const splits = new Map<string, StoredSplit>();
let loaded = false;

function dataFile() {
  const configured = process.env.SPLIT_DATA_FILE;
  if (configured === "") {
    return;
  }
  return configured ?? path.join(process.cwd(), "data", "splits.json");
}

function load() {
  if (loaded) {
    return;
  }
  loaded = true;
  const file = dataFile();
  if (!file) {
    return;
  }
  try {
    const saved = JSON.parse(readFileSync(file, "utf8")) as StoredSplit[];
    for (const split of saved) {
      splits.set(split.id, split);
    }
  } catch {
    // no saved splits yet (or an unreadable file): start empty
  }
}

function save() {
  const file = dataFile();
  if (!file) {
    return;
  }
  mkdirSync(path.dirname(file), { recursive: true });
  // write then rename, so a crash mid-write can't corrupt the file
  const temporary = `${file}.tmp`;
  writeFileSync(temporary, JSON.stringify([...splits.values()], undefined, 2));
  renameSync(temporary, file);
}

export function newToken() {
  return randomBytes(18).toString("base64url");
}

export function createSplit(
  split: Omit<StoredSplit, "id" | "hostToken" | "createdAt">,
): StoredSplit {
  load();
  const stored: StoredSplit = {
    ...split,
    id: randomUUID(),
    hostToken: newToken(),
    createdAt: new Date().toISOString(),
  };
  splits.set(stored.id, stored);
  save();
  return stored;
}

export function getSplit(id: string) {
  load();
  return splits.get(id);
}

export function findParticipantByToken(split: StoredSplit, payToken: string) {
  return split.participants.find(
    (participant) => participant.payToken === payToken,
  );
}

export function updateParticipant(
  splitId: string,
  participantId: string,
  // a key set to undefined clears that field (JSON drops it when saving)
  changes: Partial<
    Pick<
      StoredParticipant,
      | "status"
      | "orderId"
      | "captureId"
      | "paidAt"
      | "paidVia"
      | "claim"
      | "confirmedAt"
      | "claimRejectedAt"
    >
  >,
) {
  const split = getSplit(splitId);
  const participant = split?.participants.find(
    ({ id }) => id === participantId,
  );
  if (!participant) {
    return;
  }
  Object.assign(participant, changes);
  save();
  return participant;
}

/** Test helper: forget every split. */
export function clearSplits() {
  splits.clear();
}
