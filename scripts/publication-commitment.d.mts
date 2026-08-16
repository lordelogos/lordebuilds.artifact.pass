export interface PayloadCommitmentInput {
  readonly bytes: Uint8Array;
  readonly derivedBytes?: Uint8Array;
  readonly expiresInSeconds: number;
  readonly extraction?: {
    readonly status: string;
    readonly extractor?: string | undefined;
    readonly extractor_version?: string | undefined;
    readonly page_count?: number | undefined;
    readonly reason?: string | undefined;
  };
  readonly filename: string;
  readonly mimeType: string;
}

export interface PayloadCommitmentHashInput extends Omit<PayloadCommitmentInput, "bytes" | "derivedBytes"> {
  readonly derivedHash?: string | null;
  readonly sourceHash: string;
}

export function sourceSha256(bytes: Uint8Array): Promise<string>;
export function createPayloadCommitment(input: PayloadCommitmentInput): Promise<string>;
export function createPayloadCommitmentFromSourceHash(
  input: PayloadCommitmentHashInput,
): Promise<string>;
