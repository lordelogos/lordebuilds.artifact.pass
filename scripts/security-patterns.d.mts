export interface SensitiveContentFinding {
  readonly label: string;
  readonly index: number;
}

export function findSensitiveContent(source: string): SensitiveContentFinding[];
export function findFirstSensitiveContent(source: string): SensitiveContentFinding | null;
export function findSensitivePath(path: string): string | null;
