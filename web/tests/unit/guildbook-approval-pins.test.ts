import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The owner approves migration 0018 and its operator scripts by exact content hash (docs/guildbook-local-only/0018-approval-checklist.md,
 * section C). This test recomputes the hash of every listed file (line endings normalised to LF, so Windows and Linux agree) and requires the
 * checklist to match. Editing any of the files without updating the checklist fails CI, which is what restarts the review and invalidates an
 * approval given for the previous hash.
 */
const root = resolve(__dirname, "../../..");
const checklist = readFileSync(resolve(root, "docs/guildbook-local-only/0018-approval-checklist.md"), "utf8");
const sha = (p: string) => createHash("sha256").update(readFileSync(resolve(root, p), "utf8").replace(/\r\n/g, "\n")).digest("hex");

const PINNED = [
  "database/migrations/0018_disable_guildbook_cloud_sync.sql",
  "database/ops/guildbook_local_only_reassert.sql",
  "database/ops/guildbook_historical_inventory.sql",
  "database/ops/guildbook_historical_cleanup.sql",
  "database/rollback/0018_restore.sql",
];

describe("0018 approval pins", () => {
  for (const file of PINNED) {
    it(`${file} matches the hash the owner is asked to approve`, () => {
      const row = new RegExp("\\| `" + file.replaceAll(".", "\\.") + "` \\| `([0-9a-f]{64})` \\|").exec(checklist);
      expect(row, `${file} is not listed in the approval checklist`).not.toBeNull();
      expect(sha(file), "the file changed after the checklist was written: update section C and re-request approval").toBe(row![1]);
    });
  }

  it("states plainly that nothing was executed and that two distinct production approvals are required", () => {
    expect(checklist).toMatch(/NOTHING in this document has been executed against any real project/);
    expect(checklist).toMatch(/two distinct production approvals/);
    expect(checklist).toMatch(/klxhikdlfwgxurdyexdi/);
    expect(checklist).toMatch(/chcoypkjzxfznsqmmbrq/);
  });
});
