// Compatibility entry point for the complete source-verified Visa repair.
import { runVisaRepairCli } from "./repair-visa-imports.js";

runVisaRepairCli().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
