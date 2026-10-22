import { readFileSync } from "node:fs";
import { parseLegacyMigrationPlan, prepareLegacyMigration, verifyLegacyMigration } from "./legacy-migration.ts";

const [command, planPath, destination, ...extra] = process.argv.slice(2);
try {
  if (command === "verify" && planPath && !destination) {
    console.log(JSON.stringify(await verifyLegacyMigration(planPath), null, 2));
  } else {
    if (command !== "prepare" || !planPath || !destination || extra.length) {
      throw new Error("Usage: pnpm migration prepare /absolute/plan.json /absolute/new-candidate-directory | verify /absolute/candidate-directory");
    }
    const plan = parseLegacyMigrationPlan(JSON.parse(readFileSync(planPath, "utf8")));
    const report = await prepareLegacyMigration(plan, destination);
    console.log(JSON.stringify({ status: report.status, database: report.database, sources: report.sources.length,
      archivedRecords: report.sources.reduce((sum, source) => sum + source.archivedRecords, 0),
      searchableRecords: report.sources.reduce((sum, source) => sum + source.searchableRecords, 0),
      unresolvedTimestamps: report.sources.reduce((sum, source) => sum + source.unresolvedTimestamps, 0),
      activeJobs: 0, liveTrafficChanged: false }, null, 2));
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : "Migration failed");
  process.exitCode = 1;
}
