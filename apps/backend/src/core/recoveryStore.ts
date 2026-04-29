import * as fs from "fs";

/** Serialisable snapshot of a single deposited sub-note for recovery. */
export interface RecoverableNote {
  noteSecret: number[];
  withdrawKey: number[];
  noteHash: number[];
  nullifierHash: number[];
  denominationLamports: string;
  amountLamports: string;
  notePda: string;
  depositSig?: string;
  offsetHex: string;
}

/** Recovery file written when deposits succeed but withdrawal has not yet completed. */
export interface RecoveryFile {
  id: string;
  createdAt: string;
  recipient: string;
  sender: string;
  totalLamports: string;
  delayMs: number;
  clusterOffset: number;
  programId: string;
  rpcUrl: string;
  notes: RecoverableNote[];
  transactionNoteGroups?: number[][];
}

const RECOVERY_DIR = process.env.LOWKIE_RECOVERY_DIR ?? "./recovery";

function ensureRecoveryDir(): void {
  if (!fs.existsSync(RECOVERY_DIR)) {
    fs.mkdirSync(RECOVERY_DIR, { recursive: true });
  }
}

export function recoveryFilePath(id: string): string {
  return `${RECOVERY_DIR}/${id}.json`;
}

export function writeRecoveryFile(data: RecoveryFile): void {
  ensureRecoveryDir();
  fs.writeFileSync(
    recoveryFilePath(data.id),
    JSON.stringify(data, null, 2),
    { mode: 0o600 },
  );
}

export function deleteRecoveryFile(id: string): void {
  const filePath = recoveryFilePath(id);
  if (fs.existsSync(filePath)) {
    fs.unlinkSync(filePath);
  }
}

export function loadRecoveryFile(id: string): RecoveryFile | null {
  const filePath = recoveryFilePath(id);
  if (!fs.existsSync(filePath)) {
    return null;
  }

  return JSON.parse(fs.readFileSync(filePath, "utf8")) as RecoveryFile;
}

export function listRecoveryFiles(): string[] {
  ensureRecoveryDir();
  return fs
    .readdirSync(RECOVERY_DIR)
    .filter((fileName: string) => fileName.endsWith(".json"))
    .map((fileName: string) => fileName.replace(/\.json$/, ""));
}