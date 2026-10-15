#!/usr/bin/env node
// Synthetic offline stage verification. This command never performs activation.
import { verifyLegacyStage } from '../src/migration/verify-offline-stage.mjs';
const args=process.argv.slice(2);
if(args.length!==2||args[0]!=='--stage') {
  console.error('Usage: node scripts/verify-offline-stage.mjs --stage STAGED_SYNTHETIC_FOLDER');
  process.exit(2);
}
try {
  const result=verifyLegacyStage({destinationRoot:args[1]});
  console.log(JSON.stringify(result,null,2));
  console.log('STAGING_ONLY: this is not permission to use real financial data or activate a dataset.');
} catch(error) {
  console.error(String(error?.message??error).replace(/(?:[A-Z]:\\[^\s]+)/g,'[LOCAL_PATH]'));
  process.exit(1);
}
