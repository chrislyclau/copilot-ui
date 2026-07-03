export interface AuditFinding {
  readonly severity: 'low' | 'medium' | 'high' | 'critical';
  readonly file: string;
  readonly description: string;
  readonly line?: number;
}

export interface AuditResult {
  readonly pass: boolean;
  readonly findings: ReadonlyArray<AuditFinding>;
  readonly aborted?: boolean;
}
