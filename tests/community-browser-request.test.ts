/// <reference lib="dom" />
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let api: typeof import('../web/src/api.js');
let fetchMock: ReturnType<typeof vi.fn>;
let dispatch: ReturnType<typeof vi.fn>;
let stored: Map<string,string>;
const origin='http://127.0.0.1:40123';
const csrf='a'.repeat(64);
beforeEach(async()=>{
  vi.resetModules();stored=new Map();fetchMock=vi.fn(async()=>new Response('{}',{status:200}));dispatch=vi.fn();
  vi.stubGlobal('window',{location:{origin},fetch:fetchMock,dispatchEvent:dispatch,
    sessionStorage:{getItem:(key:string)=>stored.get(key)??null,setItem:(key:string,value:string)=>stored.set(key,value),removeItem:(key:string)=>stored.delete(key)}});
  api=await import('../web/src/api.js');
});
afterEach(()=>vi.unstubAllGlobals());
const options=()=>fetchMock.mock.calls.at(-1)![1] as RequestInit;

describe('normal browser account request boundary',()=>{
  it('adds volatile CSRF only to local mutating API calls',async()=>{
    api.setCommunityCsrfToken(csrf);await api.communityFetch('/api/import/commit',{method:'POST',body:'{}'});
    expect(new Headers(options().headers).get('X-CSRF-Token')).toBe(csrf);
    expect(options().credentials).toBe('same-origin');expect(options().redirect).toBe('error');
    expect(stored.size).toBe(0);
    await api.communityFetch('/api/transactions');expect(new Headers(options().headers).has('X-CSRF-Token')).toBe(false);
  });
  it('retains the explicit synthetic token only in the existing demo channel',async()=>{
    api.setCommunityAccessToken('synthetic-demo-only');await api.communityFetch('/api/community/session');
    expect(new Headers(options().headers).get('X-Community-Access-Token')).toBe('synthetic-demo-only');
    api.setCommunityAccessToken('');await api.communityFetch('/api/community/session');
    expect(new Headers(options().headers).has('X-Community-Access-Token')).toBe(false);expect(stored.size).toBe(0);
  });
  it('strips local credentials from external, other-port and non-API requests',async()=>{
    api.setCommunityCsrfToken(csrf);api.setCommunityAccessToken('synthetic-demo-only');
    for(const target of ['https://fictional.invalid/api/sync','http://127.0.0.1:40124/api/sync',origin+'/api-not-a-route',origin+'/assets/file']){
      await api.communityFetch(target,{method:'POST',credentials:'include',headers:{'X-CSRF-Token':csrf,'X-Community-Access-Token':'do-not-forward'}});
      expect(new Headers(options().headers).has('X-CSRF-Token')).toBe(false);
      expect(new Headers(options().headers).has('X-Community-Access-Token')).toBe(false);
      expect(options().credentials).toBe('same-origin');
    }
  });
  it('preserves method and nonsensitive headers from Request objects',async()=>{
    api.setCommunityCsrfToken(csrf);
    const request=new Request(origin+'/api/import/commit',{method:'POST',headers:{'X-Synthetic-Trace':'example'},body:'{}'});
    await api.communityFetch(request);expect(new Headers(options().headers).get('X-Synthetic-Trace')).toBe('example');
    expect(new Headers(options().headers).get('X-CSRF-Token')).toBe(csrf);
  });
  it('notifies the gate and clears CSRF when a protected action loses authentication',async()=>{
    api.setCommunityCsrfToken(csrf);fetchMock.mockImplementation(async()=>new Response('{}',{status:401}));
    await api.communityFetch('/api/import/commit',{method:'POST'});
    expect(dispatch).toHaveBeenCalledTimes(1);expect(dispatch.mock.calls[0][0].type).toBe('community-session-expired');
    fetchMock.mockImplementation(async()=>new Response('{}',{status:200}));
    await api.communityFetch('/api/import/commit',{method:'POST'});expect(new Headers(options().headers).has('X-CSRF-Token')).toBe(false);
  });
  it('does not confuse an incorrect login password with an expired open session',async()=>{
    api.setCommunityCsrfToken(csrf);fetchMock.mockImplementation(async()=>new Response('{}',{status:401}));
    await api.communityFetch('/api/auth/login',{method:'POST'});expect(dispatch).not.toHaveBeenCalled();
    fetchMock.mockImplementation(async()=>new Response('{}',{status:200}));await api.communityFetch('/api/auth/reauthenticate',{method:'POST'});
    expect(new Headers(options().headers).get('X-CSRF-Token')).toBe(csrf);
  });
  it('rejects malformed CSRF values and permits explicit in-memory clearing',async()=>{
    expect(()=>api.setCommunityCsrfToken('not-a-token')).toThrow();api.setCommunityCsrfToken(csrf);api.setCommunityCsrfToken('');
    await api.communityFetch('/api/auth/logout',{method:'POST'});expect(new Headers(options().headers).has('X-CSRF-Token')).toBe(false);
  });
});
