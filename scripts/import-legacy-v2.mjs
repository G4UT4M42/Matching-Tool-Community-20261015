#!/usr/bin/env node
/**
 * Only use with a fully stopped legacy application and a new destination.
 * Never run this against the owner's active production checkout.
 */
import { stageLegacyV2 } from '../src/migration/offline-v2.mjs';
import { verifyLegacyStage } from '../src/migration/verify-offline-stage.mjs';
const argv=process.argv.slice(2);
function value(flag) {
 const p=argv.indexOf(flag);
 return p<0?null:argv[p+1];
}
const opts={
 sourceRoot:value('--source'),
 destinationRoot:value('--destination'),
 confirmedOffline:argv.includes('--source-offline-confirmed'),
 dryRun:!argv.includes('--stage'),
};
if(!opts.sourceRoot||!opts.destinationRoot||!opts.confirmedOffline) {
 console.error('Usage: node scripts/import-legacy-v2.mjs --source SOURCE_FOLDER --destination NEW_FOLDER --source-offline-confirmed [--stage]');
 process.exit(2);
}
try {
 const out=await stageLegacyV2(opts);
 const verification=opts.dryRun?undefined:verifyLegacyStage({destinationRoot:out.staged_directory});
 console.log(JSON.stringify({...out,verification},null,2));
 if(!opts.dryRun)console.log('STAGING_ONLY: Candidate verified but NEVER activated. Versioned migration and owner review are required before launch.');
}catch(error){
 console.error(String(error?.message??error).replace(/(?:[A-Z]:\\[^\s]+)/g,'[LOCAL_PATH]'));
 process.exit(1);
}
