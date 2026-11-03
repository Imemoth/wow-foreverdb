export interface MigrationSqlFile {
  name: string;
  sql: string;
}

export function guildbookPolicyViolations(files: MigrationSqlFile[]): string[];
export function loadMigrationFiles(root?: string): MigrationSqlFile[];
