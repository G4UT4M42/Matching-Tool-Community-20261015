import type { PaymentAdapter } from './types.js';

/**
 * Hardwired, entirely local, deterministic simulation. There is no URL,
 * bank API, browser automation, upload or network call in this adapter.
 * Never describe its acknowledgment as a real payment or authorization.
 */
export const communitySimulatedPaymentAdapter:PaymentAdapter={
  provider:'community-simulated-bank',
  environment:'mock',
  async submit({claimId,batch,credential}) {
    if(!credential || typeof credential!=='object' || (credential as {simulation?:unknown}).simulation!==true ||
      !/^[-0-9a-f]{36}$/.test(claimId)||batch.provider!=='community-simulated-bank'||batch.environment!=='mock')throw new Error('SIMULATION_ONLY');
    return {outcome:'acknowledged',reference:'SIM-'+claimId};
  },
  async readStatus({claimId,credential}){
    if(!credential || typeof credential!=='object'||(credential as {simulation?:unknown}).simulation!==true ||
      !/^[-0-9a-f]{36}$/.test(claimId))throw new Error('SIMULATION_ONLY');
    return{outcome:'acknowledged',reference:'SIM-'+claimId};
  },
};
