import {createHash} from 'node:crypto';
import {assertEnvironment,type Environment,type Provider} from './types.js';

/** Provider-response evidence only; never accept a configured or local-user ID.
 * PayPal: official reporting search_response.account_number (merchant account).
 * Stripe: official GET /v1/account Account.id, using the same restricted key.
 */
export function providerAccountIdentity(provider:Provider,environment:Environment,raw:unknown):string{
 assertEnvironment(provider,environment);
 if(typeof raw!=='string'||!(provider==='stripe'?/^acct_[A-Za-z0-9]{1,128}$/:/^[A-Za-z0-9]{1,255}$/).test(raw))throw new Error('PROVIDER_ACCOUNT_UNAVAILABLE');
 return `provider-account-v1:${provider}:${environment}:`+createHash('sha256').update(raw).digest('hex');
}
export function isProviderAccountIdentity(value:unknown,provider:Provider,environment:Environment):value is string{
 return typeof value==='string'&&value.startsWith(`provider-account-v1:${provider}:${environment}:`)&&/^[a-f0-9]{64}$/.test(value.slice(`provider-account-v1:${provider}:${environment}:`.length));
}
